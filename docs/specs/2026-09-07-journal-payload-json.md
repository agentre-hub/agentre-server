# 镜像日志载荷改为原生 JSON 列

> Status: Approved
> Owner: agentre-server
> Last updated: 2026-09-07

**Objective:** 让 `agent_session_notification_journal` 里的一帧在数据库里可以被直接读懂与检索，而不必先跑一段解码程序。

**Hard invariant:** 一帧的内容不得在写入时丢失。投影不出来的帧、以及投影不出来的字段，必须把原始字节原样带进存储；已有的写入幂等性（`(user_id, conversation_id, seq)` 主键上的 `DO NOTHING`）、`seq` 语义与对端 wire 契约（仍为 protobuf）一律不变。

## Problem

1. **载荷是不透明的 protobuf，库里查不了。**（已核实）建表语句是 `payload longblob NOT NULL`（`migrations/202609040108_agent_sessions.go`），写侧 `mirror_svc.writeFrames` 落的是 `proto.Marshal` 的结果。要看一条对话到底存了什么，只能写一次性程序把它解出来——排查一个"某条转录内容不对"的问题因此没有任何 SQL 入口。

2. **同一张表的迁移注释描述的是一个不存在的列。**（已核实）202609040108 的注释写着 "agent_session_notification_journal.params is a json column, not text"，但表上没有 `params` 列，只有 `payload longblob`。这份注释描述的是改用 protobuf 之前的形态，与现状不符。

3. **读路径为了取一个 `event.kind` 要把整帧解码，而且一页里同一行解两遍。**（已核实）`session_mirror_read.go:203` 的 `isTurnStart` 调 `journalFrameView`（`proto.Unmarshal` + `wireview` 投影）只为读出 `kind` 判轮次边界；随后 `take()`（`:121`）对同一批行再调一次同样的 `journalFrameView`。

4. **一帧投影失败会让整页转录失败。**（已核实）`session_mirror_read.go:85` 与 `:123` 在 `journalFrameView` 出错时 `return TranscriptPage{}, err`，于是单帧的解码问题会把整条对话的详情页变成一次请求错误，而不是一处显示不出来。

## Actors and user stories

1. 作为排查问题的开发者，我想用一条 SQL 就看清某条对话存下的帧内容，以便判断"内容不对"发生在同步、存储还是渲染，而不必先写解码程序。
2. 作为控制台用户，我想在某一帧异常时仍能看到这条对话的其余部分，而不是整页打不开。

## Design decisions

| # | Decision | Basis and rejected option |
|---|---|---|
| 1 | `payload` 改为原生 `json` 列 | 用户已决定。原生类型让 `JSON_EXTRACT` 与将来的 generated column 直接可用，且读侧不留格式分支。否决：`longblob` + `codec` 列——检索要 `CAST(payload AS CHAR)`，且读侧永久保留一条格式分支；否决：新增 `payload_json` 并存列——中间态存活最久，还要再收一轮尾 |
| 2 | 存 `wireview.Notification()` 现产出的 `{method, params}` 视图 | 读侧本来每次读都要算这一份（`journalFrameView`），存它之后读路径变透传，问题 3 一并消失。`wireview` 是 protoreflect 全字段投影（`messageMap` 用 `Range` 遍历全部已置字段），且穷尽性已被 `TestNotificationViewCoversEveryRuntimeEventCase` 钉住。否决：`protojson`——它会把 `ToolCall.input` / `canonical`、`ToolResult.meta`、`UnrecognizedBlock.data` 一律编成 base64，而这四处恰恰是唯一有检索价值的内容，`wireview.go:106-115` 的 `putRawJSON` 存在的全部理由就是把它们还原成 JSON |
| 3 | 写侧投影失败时，把原始 `RpcNotification` 字节以 `{"$proto": "<base64>"}` 存入，既不拒绝也不丢弃该帧 | `transcript_projection.go` 包头记的决策 4 明写"缺口只开在读侧是有意的……写入时就削的话，丢掉的就真的没了"。写侧拒绝一帧会让这条对话的镜像卡在原地反复重试。否决：写入报错——把一次渲染问题升级成整条同步链路中断；否决：丢弃该帧——直接违反决策 4 |
| 4 | 非 JSON 的原始字节装成 `{"$b64": "<base64>"}` | **字节不丢**：`messageMap` 先按 `BytesKind` 把该字段投成 base64 字符串，`putRawJSON` 解不动时不覆盖，于是保留的就是那个 base64（实测：非 JSON 的 `ToolCall.input` 投影出 `"input":"AAH/"`）。问题是**歧义**——载荷本来就是 JSON 字符串时投影出的也是一个字符串，两者在视图里一模一样，消费方分不出手里这串是原文还是编码。包装消除的是这个歧义。否决：保持裸 base64——歧义会在检索时变成误判，而这一列存在的理由就是被人直接读 |
| 5 | 存量不就地改写：新迁移清空本表并把 `agent_sessions.latest_seq` 归零，由镜像重新拉满 | 用户已决定。`latest_seq` 只有一个读者 `storedCursor`（`mirror.go:621` 注释"latest_seq 只有一个读者……one idempotent re-pull, nothing more"），帧表写入是 `OnConflict{DoNothing}` 故重拉幂等，而对端的日志"只追加、永久保存——agentred 不再回收任何一行"。否决：在迁移里逐行 proto→JSON 改写——迁移要反向依赖 wire 生成代码，且要在唯一的无界表上跑一次全表重写 |
| 6 | 读侧的 `projectTranscriptFrames`（丢弃 / 合并）留在读侧，一行不动 | 它的包头明写该清单的真源是共享包 `@agentre-hub/agentre-ui` 的归约器，会随显示面演进（`steer_consumed` 就是这样离开清单的）。把它写进存储等于把决策 4 的缺口从读侧扩大到写侧。否决：一并前移——渲染层一改，老数据就再也补不回来 |
| 7 | 不加任何压缩 | 本轮动机是可检索，压过的字节 `LIKE` 不了也 `JSON_EXTRACT` 不了。真遇到体积问题时用 InnoDB 页压缩，它对 SQL 透明。否决：沿用 `chat_message_blocks` 的 4 KiB deflate 阈值——会造成"小帧能搜、大帧搜不到"的静默漏报，对排查工具比没有检索更糟 |
| 8 | 本轮不加索引、不加 generated column、不做搜索接口 | 用户已决定范围：只改存储形态，检索先靠手写 SQL。搜索的产品形态尚未确定，现在铺路容易铺错方向 |

## 存储形状

`payload` 存一个 JSON 对象，恒有两个键：

- `method`：`wireview.Notification()` 交回的方法名（`runtime.event`、`runtime.runResultDone` 等）。
- `params`：该方法的载荷视图，即今天 `TranscriptFrameView.Params` 的内容。

两处逃生路使用 `$` 前缀的单键对象，`$` 不会与 wire 的任何 JSON 字段名相撞（wire 侧字段名由 protoreflect 的 `JSONName()` 产出，一律是 lowerCamelCase）：

- **`{"$b64": "<base64>"}`** 出现在原本承载原始 JSON 字节的字段位置（`input` / `canonical` / `meta` / `data`），当那段字节不是合法 JSON 时。前提：写侧拿到一段非 JSON 的字节；动作：base64 编码后装进该键；可观察结果：该字段在库里与下行视图里都是这个包装对象，读者据此知道它是编码过的原始字节，而不是像今天一样与一个普通 JSON 字符串**无法区分**。
- **`{"$proto": "<base64>"}`** 出现在**整个 payload 的位置**，当 `wireview.Notification()` 对这一帧返回错误时。前提：一帧的类型或事件 kind 投影不出来；动作：把设过 seq 的原始 `RpcNotification` 的 protobuf 字节 base64 后作为整个 payload 存入；可观察结果：该帧在库里保留完整原件，镜像继续前进，这条对话的其余帧不受影响。

读侧遇到 `$proto` 包装时，解出字节按今天的路径投影一次；投影仍失败时，该帧作为一个无法解读的帧**原样放行**而不是让整页失败——这同时修掉问题 4。

### 契约版本与"读不懂的帧"

（已核实）镜像连接的握手对协议版本精确匹配，不合即以 `ErrProtocolVersionMismatch` 拒绝且**不重试**（`resident.go:210`、`:229`），版本常量是 `wireversion.Protocol`。因此"对端带来本服务端契约里没有的字段或事件 kind"在结构上进不了这张表；`$proto` 逃生路覆盖的是本仓内部的漂移（有人给 proto 加了 oneof 分支而 `wireview` 没跟上），它同时被 `TestNotificationViewCoversEveryRuntimeEventCase` 在构建期挡住。逃生路是第二道闸，不是主路。

## 写入路径

前提：`mirror_svc` 从对端日志收到一批 `JournaledNotification`。动作：对每一帧设好 seq 后调用 `wireview.Notification()`，把 `{method, params}` 序列化为 JSON 写入 `payload`；投影失败时改写 `$proto` 包装。可观察结果：与今天一样，一帧一行，落在 `(user_id, conversation_id, seq)` 主键上，重复到达的帧仍是 `DO NOTHING` 的空操作。

失败行为：JSON 序列化失败（不预期发生，`map[string]any` 的视图不含不可序列化值）时，该批写入返回错误，由镜像现有的重试路径处理——与今天 `proto.Marshal` 失败的处理位置相同。

## 读取路径

前提：详情页请求一页转录。动作：读出的行不再 `proto.Unmarshal`，`payload` 直接就是 `TranscriptFrameView` 的 `Method` / `Params`。可观察结果：页面内容与改动前逐字节一致；`isTurnStart` 改为在已解出的视图上判 `event.kind`，一页里同一行不再解码两次。

`projectTranscriptFrames` 的丢弃与合并、以及三个计数（`Cursor` / `OldestSeq` / `HasBefore`）按原始行记的既有约定，全部不变。

## 迁移与重拉

前提：迁移在既有库上执行。动作：在 `migrationList()` 末尾追加一条新迁移（取一个从未出现过的号），把 `payload` 改成 `json NOT NULL`，清空 `agent_session_notification_journal`，并把 `agent_sessions.latest_seq` 全部置 0。可观察结果：迁移完成后控制台上每条对话的转录暂时为空，镜像随后按各自的重连节奏把帧重新拉满，内容与清空前一致。

失败行为：对端此刻不在线的对话保持为空，直到它下次上线；这与该对话在删库重建后的表现相同，没有引入新的状态。

`agent_sessions` 这一行的其余字段（标题、cwd、生命周期等）不清——它们由 `setSummary` 经 Sync 维护，与帧无关。

## 体积与传输上限

（已核实）图片附件在桌面端的落库形态就是 JSON 内联 base64（`{"type":"image","data":{"media_type":"image/png","source":{"inline":"…"}}}`），且 `internal/pkg/transcript/handlers/` 下没有 image 处理器，因此它经 `projection.go` 的兜底以 `UnrecognizedBlock` 帧进入本表，`data` 就是上面那段 JSON。桌面端 `chat_svc/dropped_image.go` 的 `maxDropImageBytes = 5 MiB` 上限、MIME 白名单与"超限降级为路径引用"已经框住最坏情况，因此单帧上界约 6.7 MiB。

由此产生一条部署约束：MySQL 的 `max_allowed_packet` 必须显著高于单帧上界，否则超大帧会在插入时以 `ER_NET_PACKET_TOO_LARGE` 失败并让该对话的镜像反复重试。（未核实：各部署环境当前的 `max_allowed_packet` 取值。）改用 JSON 后同一张图比现在大约 1/3，这条约束因此要在部署文档里写明下限，而不是依赖默认值。

## 检索的使用方式

本轮只保证形状可查，不提供接口。使用时应经 `JSON_EXTRACT` / `->>` 定位到具体路径（如 `$.params.event.text`），**不应**对整个 `payload` 做 `LIKE`：一张图的 base64 是数 MB 的连续字符，全表 `LIKE` 会被它拖慢并可能误命中。两处 `$` 包装因此天然落在检索范围之外，这是想要的结果。

## 访问范围与隐私

本表存的是用户的转录内容。改动**不触碰**任何访问控制：读取仍由 `(user_id, conversation_id)` 两列共同限定，少一列即跨账号读，这一点在三条读语句上原样保留。

需要明说的是一处性质变化：载荷从"要用生成契约解码才看得懂"变成"库里直接可读"。有数据库访问权的人本来就能解出这些内容（写一段程序即可），本轮把门槛降到一条 SQL。这是本轮想要的结果，但它意味着生产库的访问权限与审计要按"直接可读的用户内容"来对待，而不是按不透明二进制。

## Out of scope

- 面向控制台的搜索接口与 UI（用户已决定推迟；产品形态未定）
- generated column 与索引（同上）
- 载荷压缩（决策 7）
- agentred 与桌面端各自的存储形态：规格 `2026-09-05-transcript-storage-alignment.md` 决策 7 明确"压缩是纯存储层的正交问题……各库可各自决定，不构成跨仓耦合"，本轮不触及，也不需要 `pkg/wire` 变更
- 把帧折成消息树再存：该方案要求服务端从"哑镜像"变成"解释器"，并在本仓再实现一份与 `internal/pkg/transcript` 逐帧一致的投影，是独立一轮的取舍
- 修改对端 wire 契约或协议版本

## Testing decisions

| Seam | What it verifies | Prior art |
|---|---|---|
| `wireview.Notification`（包边界） | 非 JSON 的原始字节被包成 `{"$b64":…}` 而不是丢键；已是 JSON 的四个字段仍还原成对象 | `wireview_test.go` 的 `TestNotificationViewKeepsToolInputAsJSONObject` / `…KeepsUnrecognizedBlockPayloadAsJSON` |
| `mirror_svc` 写入（服务边界，repo 用 mock） | 一帧落库的 `payload` 是 `{method, params}` JSON；投影失败的一帧落成 `$proto` 包装且整批不中断 | `mirror_test.go` |
| `agent_session_repo.JournalFrame`（仓储边界，sqlmock） | 改列后写入与三条读语句的 SQL 拼写不变，幂等仍收敛到主键 | `journal_frame_test.go` |
| `workspace_svc` 读取（服务边界） | 页面内容与改动前一致；单帧解不开时该帧原样放行而整页不失败（问题 4） | `session_mirror_read` 既有测试 |
| 守卫测试 | 能进本表的 notification 类型集合内不含承载真实二进制的那些（terminal / fs / mcp 载荷） | `TestNotificationViewCoversEveryRuntimeEventCase` 是同类守卫的先例 |

**迁移不做自动化测试**：`docs/testing.md` 的「Migration compatibility is not automated」明确本仓不写解析迁移 DDL 或复制 schema 文本的单元测试，`migrations/migrations_test.go` 只覆盖命名锁运行器。本轮遵循该约定。

因此以下两项由手工验证承担，证据按 `docs/verification.md` 写在 `e2e/scratch/2026-09-07-journal-payload-json/` 下，形式是读回的表结构而非截图：

1. 迁移在真实 MySQL 上被接受，执行后 `payload` 列类型为 `json`、本表为空、`agent_sessions.latest_seq` 全为 0。
2. 迁移后镜像把帧重新拉满：在联调环境观察一条对话在对端上线后转录恢复，且内容与清空前一致。这一项依赖真实对端，无法在单元层表达。

## Open questions

（无）
