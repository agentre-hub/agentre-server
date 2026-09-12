package migrations

import (
	"github.com/go-gormigrate/gormigrate/v2"
	"gorm.io/gorm"
)

// migration202609120101 建 0.1.0 首发的全部表。
//
// 这一条就是 schema 的全部：0.1.0 之前的十条基线迁移与五条补丁迁移在发布前被压成了
// 这一条，压缩后的结果与「按原顺序跑完那十五条」逐列、逐索引、逐键位次等价（在
// MySQL 9.7 真库上用 mysqldump --no-data 两侧对比，diff 为空）。压缩是发布前的一次性
// 例外——首发之后本文件同样不再改动，修正一律追加补丁迁移（见 migrations.go 的规范）。
//
// 被压掉的五条补丁里有四条是索引（它们写在下面对应的键上，理由也一并搬了过来），
// 第五条是给存量账号补 sync_account_seqs 行的纯 DML：全新库在建表时一个账号都没有，
// 那条 INSERT … SELECT 恒选中 0 行，而建号本身已经在同一个事务里预建序列行
// （user_svc 里紧随 users 行的 EnsureSeq，决策 20），所以它在这里没有对应物。
//
// 一次迁移只做一件事，这件事是「把库建出来」。语句逐条执行：gormigrate 的
// DefaultOptions 不包事务，而 MySQL 的 DDL 本来也不是事务性的。
//
// ── 通用约定 ──
//
// 每张表的行身份都是一根与业务取值无关的自增 id（见 internal/model/entity 的
// TestEveryEntityHasAutoIncrementIDPrimaryKey），业务身份走唯一键。每张表只有一个
// 「身份」唯一键，这样 ON DUPLICATE KEY UPDATE 的重放对「撞的是哪一行」没有歧义
// （docs/architecture.md 的 one unique key 规则）。
//
// 表默认排序规则一律 utf8mb4_0900_ai_ci，只在**真正参与比较**的列上显式写排序规则，
// 读的人才知道哪些列的判等语义是被刻意选过的：不透明标识（指纹、sync_id、device_code、
// 哈希、UUID）用 utf8mb4_0900_bin 逐字节判等，人输入的邮箱与验证码用
// utf8mb4_0900_as_ci（折叠大小写、不折叠重音）。显式排序规则都取 _0900_ 那一族，
// 因为它们是 NO PAD——老的 utf8mb4_bin / utf8mb4_general_ci 是 PAD SPACE，会忽略尾随
// 空格（'x ' 等于 'x'），那和 PG 的 text 语义不一样。要互相比较的两列必须同排序规则，
// 否则 MySQL 直接判 illegal mix of collations。
//
// MySQL 没有部分唯一索引，用「条件成立时取值、否则取 NULL」的 STORED 生成列表达：
// 唯一键里出现 NULL 的行不参与约束。users.active_flag、device_flow_codes.pending_flag、
// sync_objects.live_natural_key 都是这个写法。
func migration202609120101() *gormigrate.Migration {
	return &gormigrate.Migration{
		ID: "202609120101",
		Migrate: func(tx *gorm.DB) error {
			for _, statement := range initialSchemaStatements {
				if err := tx.Exec(statement).Error; err != nil {
					return err
				}
			}
			return nil
		},
		Rollback: func(tx *gorm.DB) error {
			// 逆序删：表之间没有外键，但按建表的反序回收读起来与上面一一对应。
			for i := len(initialSchemaTables) - 1; i >= 0; i-- {
				if err := tx.Exec("DROP TABLE IF EXISTS " + initialSchemaTables[i]).Error; err != nil {
					return err
				}
			}
			return nil
		},
	}
}

// initialSchemaTables 按建表顺序列出本迁移建的表，Rollback 按它逆序回收。
var initialSchemaTables = []string{
	"users",
	"user_identities",
	"devices",
	"device_tokens",
	"device_flow_codes",
	"sync_objects",
	"sync_account_seqs",
	"sync_device_states",
	"sync_avatars",
	"device_local_paths",
	"agent_session_saves",
	"agent_sessions",
	"agent_session_durable_frames",
	"agent_session_delete_todos",
	"webauthn_credentials",
	"agent_activity_daily",
	"user_settings",
}

// initialSchemaStatements 是首发 schema 的建表语句，按依赖无关的阅读顺序排列。
var initialSchemaStatements = []string{
	// ── users ──
	//
	// email 用 utf8mb4_0900_as_ci：**大小写不敏感、但不折叠重音**。
	//
	// 大小写不敏感是产品决定：同一个人用 "A@b.C" 和 "a@b.c" 注册必须落在同一个账号上，
	// 否则同一个邮箱能注册出两个账号。既然唯一键与 FindByEmail 都走这一列，把这件事交给
	// 排序规则比在每个写入方各自 lower() 一遍更可靠——少一处就漏一处。ai_ci 不行：
	// ai = accent-insensitive 连重音都折叠，会把 e@x.c 与 é@x.c 当成同一个邮箱，
	// 而那是两个不同的收件人。display_name / avatar_url 从不参与比较，留表默认即可。
	//
	// uk_users_email_active 等价于 PG 的
	// `CREATE UNIQUE INDEX ... ON users(email) WHERE status = 1`。键写成
	// (email, active_flag) 而不是 (active_flag, email)，是为了让同一个索引既做约束、
	// 又能被 user_repo.FindByEmail 的 `WHERE email=?` 当最左前缀用上——否则 email 上
	// 就一个索引都没有，登录路径每次都是全表扫。
	//
	// **没有 email_verified 列**：唯一的写入点会把它硬编码成 true（账号只能由 GitHub
	// OAuth 创建），没有任何一处读它，也不进任何 API 响应。一个不被读的 email_verified
	// 看上去像一道校验，实际上系统此刻就把所有邮箱一视同仁——它提供的是安全感而不是
	// 安全。接入第二种**不**保证邮箱已验证的身份来源时再加回来，届时它要连同真正的
	// 读取点（拒绝未验证邮箱的那条判断）一起落地，而不是先建一列空着。
	`
		CREATE TABLE users (
		  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL,
		  display_name    varchar(255) NOT NULL DEFAULT '',
		  avatar_url      varchar(2048) NOT NULL DEFAULT '',
		  webauthn_handle varbinary(64) NOT NULL DEFAULT '',
		  status          smallint NOT NULL DEFAULT 1,
		  createtime      bigint NOT NULL DEFAULT 0,
		  updatetime      bigint NOT NULL DEFAULT 0,
		  active_flag     tinyint GENERATED ALWAYS AS (IF(status = 1, 1, NULL)) STORED,
		  UNIQUE KEY uk_users_email_active (email, active_flag)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── user_identities ──
	//
	// provider / provider_uid 用 utf8mb4_0900_bin 逐字节判等：provider_uid 是 OAuth
	// 提供方给的不透明标识，大小写不敏感地判重会把两个不同的上游账号认成同一个。
	// email 跟 users.email 同一个排序规则，两列语义相同且会互相比较。
	// provider_login 是展示用的用户名，留表默认排序规则。
	//
	// raw_profile 带上 DEFAULT ('{}')（MySQL 8.0.13+ 的表达式默认值）：让「没有
	// profile」这件事由 schema 表达一次，而不是在每个写入方各自兜一遍。
	`
		CREATE TABLE user_identities (
		  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id         bigint NOT NULL,
		  provider        varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
		  provider_uid    varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  provider_login  varchar(255) NOT NULL DEFAULT '',
		  email           varchar(320) COLLATE utf8mb4_0900_as_ci NOT NULL,
		  raw_profile     json NOT NULL DEFAULT ('{}'),
		  createtime      bigint NOT NULL DEFAULT 0,
		  updatetime      bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_user_identities_provider_uid (provider, provider_uid),
		  KEY idx_user_identities_user (user_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── devices ──
	//
	// fingerprint 是设备的自然键、由桌面端生成，kind 是枚举字面量，两者都用
	// utf8mb4_0900_bin：指纹大小写不敏感地判重会把两台不同的机器认成同一台，进而让
	// 第二台的注册撞上 uk_devices_user_fingerprint。name 是用户可改的展示名，留默认
	// 排序规则。fingerprint 会被 sync_objects.agentred_fingerprint 与
	// agent_session_saves.device_fingerprint 拿去比较，那几列必须用同一个排序规则。
	//
	// idx_devices_user_active 是普通复合索引而不是部分索引：PG 那边写的是
	// `WHERE status = 1`，MySQL 没有部分索引，但把 status 放进键里同样能服务
	// `WHERE user_id=? AND status=?`，只是索引会连非活跃行一起收——设备表很小，
	// 不值得为此再加一个生成列。
	// display_name 是用户自己给这台设备起的备注名，空串表示没设过、读取时回落到 name
	// （device_entity.EffectiveName）。不复用 name 的原因：那一列是设备 claim 时自报的
	// 主机名，device_repo.Upsert 的 ON DUPLICATE KEY UPDATE 赋值列里就有它，那台机器每次
	// 重新配对都会把用户改的名字原样覆盖回去——同一台电脑上的多个桌面端因此在账号里是
	// 一串一模一样的主机名，用户想撤销其中一台时分不清该点哪个。
	`
		CREATE TABLE devices (
		  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id         bigint NOT NULL,
		  name            varchar(255) NOT NULL,
		  display_name    varchar(255) NOT NULL DEFAULT '',
		  kind            varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
		  platform        varchar(64) NOT NULL DEFAULT '',
		  version         varchar(64) NOT NULL DEFAULT '',
		  fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  last_seen_at    bigint NOT NULL DEFAULT 0,
		  status          smallint NOT NULL DEFAULT 1,
		  createtime      bigint NOT NULL DEFAULT 0,
		  updatetime      bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_devices_user_fingerprint (user_id, fingerprint),
		  KEY idx_devices_user_active (user_id, status)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── device_tokens ──
	//
	// access_token_hash 与 refresh_token_hash 都是明文凭据的 sha256 十六进制
	// （device_svc 里 hex.EncodeToString，恒为 64 位小写）：access token 不是 JWT，
	// 而是不透明随机串，server 只存它的摘要，Bearer 校验按摘要等值查找。两列都用
	// utf8mb4_0900_bin 逐字节判等——它们上面各挂一个唯一键，大小写不敏感会让两个不同
	// 的哈希互相顶掉，也等于放宽一个 bearer 凭据的匹配条件。
	//
	// ip 与 user_agent 只写不读（审计用，从不出现在任何 WHERE 里），显式排序规则对
	// 它们没有意义，留表默认即可。
	//
	// idx_dtokens_device_active 把 revoked_at 放进键里代替 PG 的
	// `WHERE revoked_at = 0`，理由同 devices：一条复合索引就能服务查询，不必为此加
	// 生成列——RevokeChain 的 `device_id=? AND revoked_at=0` 正是它。
	// idx_dtokens_revoked 与 idx_dtokens_refresh_expiry 各服务 DeleteRevokedBefore
	// 拆开的那两条清理语句。
	//
	// **没有 rotated_from_id 列**：那一列记「这条 token 是轮换掉哪一条得来的」，而
	// 轮换链从来没有被消费——撤销按 device_id 整批走（RevokeByDevice），清理按时间窗
	// 走（CleanupDeviceTokens），没有任何一条路径顺着它往回走。真要做轮换链审计时，
	// 它要连同读取点一起加回来。
	`
		CREATE TABLE device_tokens (
		  id                  bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  device_id           bigint NOT NULL,
		  access_token_hash   varchar(64) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  refresh_token_hash  varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
		  refresh_expires_at  bigint NOT NULL DEFAULT 0,
		  last_used_at        bigint NOT NULL DEFAULT 0,
		  revoked_at          bigint NOT NULL DEFAULT 0,
		  user_agent          varchar(512) NOT NULL DEFAULT '',
		  ip                  varchar(45),
		  createtime          bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_dtokens_refresh_hash (refresh_token_hash),
		  UNIQUE KEY uk_dtokens_access_hash (access_token_hash),
		  KEY idx_dtokens_device_active (device_id, revoked_at),
		  KEY idx_dtokens_revoked (revoked_at),
		  KEY idx_dtokens_refresh_expiry (refresh_expires_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── device_flow_codes（RFC 8628 的 device_code / user_code 状态机）──
	//
	// device_code 是机器之间传递的 bearer 凭据，用 utf8mb4_0900_bin 逐字节判等：
	// 大小写不敏感等于凭空放宽一个凭据的匹配条件。user_code 相反，它是印给人看、由人
	// 敲进浏览器的，所以用 utf8mb4_0900_as_ci 大小写不敏感——用户小写敲验证码必须也能
	// 对上。usercode.Normalize 已经会先转大写，排序规则是第二层保障：将来多一条忘了
	// Normalize 的查询路径时，症状是「查不到这个验证码」这种很难联想到大小写的报错。
	//
	// 两者的长度按生成器实际产出来定，不留无意义的余量——device_code 是
	// randomBase32(32)（32 字节 base32、无填充，恒为 52 位小写），user_code 是
	// usercode.Generate() 的 "XXX-XXX"（7 位大写）。device_code 既是这张表的唯一键，
	// 又被 InnoDB 塞进每一条二级索引（唯一键的列同样会被复制进去），所以它的宽度是
	// 真实成本，不能随手写 varchar(255)。
	//
	// uk_dfc_user_code_pending 等价于 PG 的
	// `... ON device_flow_codes(user_code) WHERE consumed_at = 0 AND denied_at = 0`：
	// 只有未结算的行会互相排斥。键写成 (user_code, pending_flag) 是为了让同一个索引
	// 也能被 `WHERE user_code=? AND consumed_at=0 AND denied_at=0` 当最左前缀用上——
	// 这条路径是设备每 5 秒一次的轮询和 approve/deny 两条 UPDATE，没有索引就是全表扫，
	// 而全表扫的 UPDATE 在 InnoDB 下还会把 next-key 锁铺满整张表。
	`
		CREATE TABLE device_flow_codes (
		  id                  bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  device_code         varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
		  user_code           varchar(16) COLLATE utf8mb4_0900_as_ci NOT NULL,
		  device_kind         varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
		  client_fingerprint  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  platform            varchar(64) NOT NULL DEFAULT '',
		  version             varchar(64) NOT NULL DEFAULT '',
		  client_name         varchar(128) NOT NULL DEFAULT '',
		  authorized_user_id  bigint NOT NULL DEFAULT 0,
		  approved_at         bigint NOT NULL DEFAULT 0,
		  consumed_at         bigint NOT NULL DEFAULT 0,
		  denied_at           bigint NOT NULL DEFAULT 0,
		  interval_seconds    smallint NOT NULL DEFAULT 5,
		  last_polled_at      bigint NOT NULL DEFAULT 0,
		  expires_at          bigint NOT NULL DEFAULT 0,
		  createtime          bigint NOT NULL DEFAULT 0,
		  pending_flag        tinyint GENERATED ALWAYS AS
		    (IF(consumed_at = 0 AND denied_at = 0, 1, NULL)) STORED,
		  UNIQUE KEY uk_device_flow_codes_identity (device_code),
		  UNIQUE KEY uk_dfc_user_code_pending (user_code, pending_flag),
		  KEY idx_dfc_expires (expires_at)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── sync_objects（工作区多端同步的同步组）──
	//
	// 同步组（sync_objects）与上报组（device_local_paths）语义不同，所以不是一张表：
	// 同步组双向同步、有版本号与墓碑；上报组按设备分命名空间、整份快照替换，没有删除
	// 时间也没有冲突元数据。
	//
	// sync_id / scope_sync_id / agentred_fingerprint / kind 都是客户端自带的不透明
	// 标识，一律 utf8mb4_0900_bin 逐字节判等，同步的一切都建立在这个标识精确可比上。
	// agentred_fingerprint 要能和 devices.fingerprint 比较，两列排序规则必须一致。
	//
	// uk_sync_objects_natural 是 agentred 路径的账号内自然键，只约束存活的行：墓碑不占
	// 自然键，否则删掉再建就建不回来。live_natural_key（存活且属于带自然键的那几种 kind
	// 时取 kind 本身、否则为 NULL）把墓碑摘出去，等价于 PG 那条带
	// `WHERE kind IN (…) AND deleted_at = 0` 的
	// (user_id, scope_sync_id, agentred_fingerprint, kind) 部分唯一索引。
	//
	// 末尾放的是 **kind 本身而不是常数 1**，这样一条键就够了：
	// ('project_location', proj, fp) 与 ('agent_backend_cli', proj, fp) 在键上是不同的
	// 两点，不必各占一根生成列 + 一条索引（那种写法每多一种带自然键的 kind 就多一列
	// 一键，而两条键的前三列完全相同）。
	//
	// **名单必须保持最小。** 九种 kind 里只有 project_location 与 agent_backend_cli 在
	// 写入侧被强制要求 scope_sync_id 与 agentred_fingerprint 非空（sync_svc 的
	// rejectReason、workspace_svc 的 checkLocationNaturalKey）。其余七种这两列恒为空串，
	// 放进名单会让该 kind 下所有存活行退化成同一个键 (user_id, ”, ”, kind) 而互相顶掉
	// ——用户建第二个 Agent 就撞唯一索引。
	//
	// 键里放的是三个真列而不是把它们拼成一个字符串：拼接需要一个分隔符，而在
	// utf8mb4_0900_ai_ci 下 CHAR(0) 这类控制字符的排序权重为空、会被直接忽略，
	// ('proj','Xdev') 与 ('projX','dev') 会拼成同一个键、误判成重复。放真列既没有这个
	// 问题，又能让 objectRepo.FindLocationByNaturalKey 走
	// (user_id, scope_sync_id, agentred_fingerprint) 这个最左前缀。
	//
	// idx_sync_objects_fingerprint 让指纹能直接 join 到 devices.fingerprint：web 控制台
	// 不需要额外的映射表就能说出「这条配置属于哪台机器」。PG 那边它带一个「指纹非空」的
	// 条件，MySQL 这里收全部行——多收的是空指纹那一批，不值得为此再加一个生成列。
	//
	// avatar_hash 是 payload 里那个头像哈希的生成列。R16a 的回收语句要回答「还有谁引用
	// 着这份头像」，原本写成 JSON_UNQUOTE(JSON_EXTRACT(payload,'$.avatar_hash')) =
	// content_hash——函数谓词落不到任何索引上，于是每一个候选头像行都要把该账号的全部
	// sync_objects 读上来逐行解 JSON。提成列之后它才有地方落，idx_sync_objects_avatar
	// 的前三列 (user_id, kind, deleted_at) 顺带也服务 objectRepo.ListByKinds。
	`
		CREATE TABLE sync_objects (
		  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id              bigint NOT NULL,
		  kind                 varchar(32) COLLATE utf8mb4_0900_bin NOT NULL,
		  sync_id              varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  scope_sync_id        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  agentred_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  payload              json NOT NULL DEFAULT ('{}'),
		  version              bigint NOT NULL,
		  -- 客户端提交的最后修改时间。这张表是同步元数据的专表，前缀冗余
		  -- （2026-08-27-schema-overhaul.md 决策 13）；实体那一侧的字段刻意不叫
		  -- UpdatedAt，见 sync_entity.SyncObject 上的注释。
		  updated_at           bigint NOT NULL DEFAULT 0,
		  -- 最后一次修改来自哪台机器。存**指纹**而不是 devices.id：数值是这个
		  -- server 的本地主键，桌面端离线创建的行没有它，而工作区里其余跨机引用
		  -- 一律用指纹（决策 14）。空串 = 服务端直写（决策 21）。
		  origin_fingerprint   varchar(128) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  deleted_at           bigint NOT NULL DEFAULT 0,
		  createtime           bigint NOT NULL DEFAULT 0,
		  updatetime           bigint NOT NULL DEFAULT 0,
		  -- 存活自然键，只用来把墓碑和「不带自然键的那些 kind」从下面那条唯一键里
		  -- 摘出去（见上面的注释）。放的是 kind 本身而不是常数 1，两种 kind 因此
		  -- 在同一条键上互不相撞。
		  live_natural_key     varchar(32) COLLATE utf8mb4_0900_bin
		    GENERATED ALWAYS AS (IF(deleted_at = 0 AND
		    kind IN ('project_location', 'agent_backend_cli'), kind, NULL)) STORED,
		  -- 头像哈希从 payload 里提出来单独成列，是为了让它有地方落索引：
		  -- 回收语句的引用检查原本写成 JSON_EXTRACT(...) = content_hash，
		  -- 那是个函数谓词，优化器定位不了任何索引（见上面的注释）。
		  -- 排序规则必须跟 sync_avatars.content_hash 一致，两列要直接比较；
		  -- 不显式写的话它会继承 JSON 那一族的默认排序规则，而那一档是
		  -- PAD SPACE，会忽略尾随空格。
		  avatar_hash          varchar(64) COLLATE utf8mb4_0900_bin
		    GENERATED ALWAYS AS
		    (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.avatar_hash'))) STORED,
		  UNIQUE KEY uk_sync_objects_identity (user_id, sync_id),
		  UNIQUE KEY uk_sync_objects_natural
		    (user_id, scope_sync_id, agentred_fingerprint, live_natural_key),
		  KEY idx_sync_objects_cursor (user_id, version),
		  KEY idx_sync_objects_fingerprint (user_id, agentred_fingerprint),
		  KEY idx_sync_objects_tombstone (deleted_at),
		  -- 四列全是等值谓词，顺序对头像回收无所谓；把 deleted_at 放在
		  -- avatar_hash 前面是为了让前三列同时当 ListByKinds
		  -- （user_id + kind IN ? + deleted_at=0）的完整前缀用。
		  KEY idx_sync_objects_avatar (user_id, kind, deleted_at, avatar_hash)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── sync_account_seqs（账号级版本序列）──
	//
	// 一个账号一行，由建号在同一个事务里紧随 users 行预建（user_svc 的 EnsureSeq，
	// 决策 20）：缺行的两个新账号并发首次取号，会在 NextVersion 的回落分支上各持一把
	// 间隙锁、随后的 INSERT 互等而 ERROR 1213。这张表刻意没有实体，取号全部走原生 SQL
	// （见 sync_entity 的注释与 internal/model/entity/schema_test.go 的白名单）。
	`
		CREATE TABLE sync_account_seqs (
		  id          bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id     bigint NOT NULL,
		  version_seq bigint NOT NULL DEFAULT 0,
		  updatetime  bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_sync_account_seqs_identity (user_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── sync_device_states（每台设备最近一次成功同步的时间）──
	`
		CREATE TABLE sync_device_states (
		  id           bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id      bigint NOT NULL,
		  device_id    bigint NOT NULL,
		  last_sync_at bigint NOT NULL DEFAULT 0,
		  updatetime   bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_sync_device_states_identity (user_id, device_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── sync_avatars（按内容哈希存放的头像）──
	//
	// content 用 mediumtext 而不是 text：MySQL 的 text 上限是 65535 字节，而
	// sync_svc.MaxAvatarBytes 允许 4 MiB，用 text 会让超过 64 KB 的头像直接写不进去
	// （ER_DATA_TOO_LONG）。mediumtext 是 16 MiB，覆盖得住那个上限。
	//
	// **没有 byte_size 列**：配额校验在写入前对 in.Content 当场算
	// （sync_svc.MaxAvatarBytes），回收按引用计数走（idx_sync_objects_avatar），两条路
	// 都不看它；正文就在同一行上，长度随时算得出来。
	`
		CREATE TABLE sync_avatars (
		  id           bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id      bigint NOT NULL,
		  content_hash varchar(64) COLLATE utf8mb4_0900_bin NOT NULL,
		  content_type varchar(255) NOT NULL DEFAULT '',
		  content      mediumtext NOT NULL,
		  createtime   bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_sync_avatars_identity (user_id, content_hash),
		  KEY idx_sync_avatars_createtime (createtime)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── device_local_paths（每台设备上报的本地路径清单）──
	`
		CREATE TABLE device_local_paths (
		  id              bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id         bigint NOT NULL,
		  device_id       bigint NOT NULL,
		  project_sync_id varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  path            text NOT NULL,
		  updatetime      bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_device_local_paths_identity (user_id, device_id, project_sync_id),
		  -- 撤销设备时按 device_id 单列清这台机器的清单，而唯一键以 user_id 打头，
		  -- device_id 不是它的最左前缀（见 sync_repo 的 DeleteByDevice）。
		  KEY idx_dlp_device (device_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── agent_session_saves（账号级「保存的对话」名单，R12 后端 / R14）──
	//
	// 这是 agentre-server 唯一的会话相关新增名单表，也是硬不变量（server 不持有任何
	// 会话内容）的唯一例外，且它存的是「指向」——目标设备指纹 + 会话身份 + 关注时间，
	// 不含标题、消息或转录。表名与列名退出实现比喻，并到 agent_session_* 这个域上
	// （2026-08-27-schema-overhaul.md 决策 19/12）：「保存」是这份名单的动作，不是域名。
	//
	// 身份是 (user_id, conversation_id)
	// （2026-08-31-conversation-centric-addressing.md「会话身份」）：conversation_id 是
	// 一条对话在桌面端、agentred 与 server 三套库以及线格式上的**同一个**身份（决策 1），
	// 由发起端铸 UUIDv7。保存/删除因此幂等：重复保存命中唯一索引时那条 INSERT 什么都不改
	// （gorm 的 DoNothing 在 MySQL 下发出 ON DUPLICATE KEY UPDATE 的自赋值形式），
	// 不新增行、不重置首次保存时间；删除就是一条 DELETE，删不到也是成功。
	//
	// conversation_id 用 char(36) 而不是 varchar(36)：规范形式的 uuid 恒为 36 字符，
	// 定长省掉每行一个长度前缀。peer_fingerprint 留着，但已经**退出身份**，只是来源
	// 标注与授权用的普通列；device_fingerprint 是目标设备的不透明标识，要能和
	// devices.fingerprint 比较。
	`
		CREATE TABLE agent_session_saves (
		  id                 bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id            bigint NOT NULL,
		  conversation_id    char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  device_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  peer_fingerprint   varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  followed_at        bigint NOT NULL DEFAULT 0,
		  createtime         bigint NOT NULL DEFAULT 0,
		  updatetime         bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_agent_session_saves_identity (user_id, conversation_id),
		  KEY idx_agent_session_saves_machine (user_id, device_fingerprint)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── agent_sessions / agent_session_durable_frames / agent_session_delete_todos ──
	//
	// 三张账号级的会话表（2026-08-18-server-session-mirror.md「存什么」/ 决策 17）：
	// 一条对话一行摘要、它的原始持久帧，以及待跨端重放的删除。表名取自行的内容而不是
	// 填充它们的机制（决策 19）：mirror / followed 是同一个域的两种实现比喻，
	// 「保存过」与「来自某个 peer」是一份名单和一列的属性，不是域名。镜像作为动词留在
	// mirror_svc 上。
	//
	// 身份一律 (user_id, conversation_id)，agent_session_durable_frames 再加 seq。
	// conversation_id 用 char(36)：规范 uuid 恒为 36 字符，定长省掉每行一个长度前缀——
	// 而 agent_session_durable_frames 是这里唯一一张无界增长的表（帧只在对话被删时才
	// 回收），这一列进了唯一键、会被复制进每一条二级索引。peer_fingerprint 要能和
	// devices.fingerprint 比较，取同样的 utf8mb4_0900_bin。
	//
	// agent_session_delete_todos 的机器列叫 **device_fingerprint** 而不是
	// peer_fingerprint：它存的是**承载**这条对话的机器（重放删除时要拨的那台），
	// 不是发起端。两者取值范围重叠——在本机开的对话上它们是同一个值——所以列名弄错
	// 不会在任何地方报错，只会把 todo 发给一台从没跑过这条对话的机器。另外四个别名
	// （agentred_ / daemon_ / machine_ / sync_origin_）的角色命名是对的，保留；
	// 见 agentre/docs/architecture.md「Device fingerprints」。
	//
	// agent_session_durable_frames 原本把身份键当**主键**、而不是另加一根自增列，
	// 理由是这个表是唯一一张无界增长的表，聚簇因此是存储决定而不是记账：一根自增 id
	// 会把一条对话的帧打散在整个聚簇索引上，而详情页读的是一条对话的**尾部**
	// （seq DESC LIMIT n，ListFramesBefore）。后来库级约定统一成「每一张表的行身份都是
	// 一个与业务取值无关的数字」（见 internal/model/entity 的
	// TestEveryEntityHasAutoIncrementIDPrimaryKey），这张表也带了 id 主键，那笔开销因此
	// 是真的付了：尾部读取现在是二级唯一索引扫一段、再逐行回表取 payload。记在这里，
	// 免得下次有人重新推导一遍这个代价。
	//
	// payload 是 json（早期是 longblob，存的是 protobuf 字节）：text 的 64KB 上限会把
	// 大帧截断（与 sync_objects.payload 同一个理由），而 json 没有 64KB 上限。
	//
	// title 是 text 而不是 varchar：它是 peer 报上来的任意展示串，两侧都没有长度约束
	// ——桌面端的重命名路径封到 200 runes，但导入会话的标题是它第一条消息的第一行。
	// varchar 的上限不会截断，而是让整条 upsert 以 ER_DATA_TOO_LONG 失败，于是那条对话
	// 根本不镜像，报错里既没有列名也没有标题。cwd 同理。
	//
	// idx_agent_session_delete_todos_machine 服务每 60 秒一轮的 ListPendingMachines：
	// 真库上按 device_fingerprint 分组要建临时表，有了 (user_id, device_fingerprint)
	// 是一次覆盖扫描（决策 12）。它刻意是**非唯一**的：AddDeleteTodo 的
	// ON DUPLICATE KEY UPDATE 语义依赖这张表只有一个唯一键，多一个唯一键会让「撞的是
	// 哪一行」变得含混。
	`
		CREATE TABLE agent_sessions (
		  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id              bigint NOT NULL,
		  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  title                text NOT NULL DEFAULT (''),
		  agent_sync_id        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  provider_session_id  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  cwd                  text NOT NULL DEFAULT (''),
		  backend_type         varchar(64) NOT NULL DEFAULT '',
		  lifecycle_state      varchar(32) NOT NULL DEFAULT '',
		  waiting_for_input    boolean NOT NULL DEFAULT false,
		  project_sync_id     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  provider_key        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  model_key           varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  last_read_at        bigint NOT NULL DEFAULT 0,
		  latest_seq           bigint NOT NULL DEFAULT 0,
		  -- 发起端自己记的最后活动时刻。**不叫 updated_at**：那是行更新时刻的
		  -- 名字，GORM 会按它自动改写这一列，而这一列是排序键、分页游标的一半
		  -- 与「未读」判据的一边（2026-08-27-schema-overhaul.md 决策 10）。
		  last_message_at      bigint NOT NULL DEFAULT 0,
		  createtime           bigint NOT NULL DEFAULT 0,
		  updatetime           bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_agent_sessions_identity (user_id, conversation_id),
		  KEY idx_agent_sessions_recent (user_id, last_message_at, id),
		  KEY idx_agent_sessions_agent_recent
		    (user_id, agent_sync_id, last_message_at, id),
		  KEY idx_agent_sessions_project_recent
		    (user_id, project_sync_id, last_message_at, id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
	`
		CREATE TABLE agent_session_durable_frames (
		  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id              bigint NOT NULL,
		  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  peer_fingerprint     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  seq                  bigint NOT NULL,
		  payload              json NOT NULL,
		  createtime           bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_agent_session_durable_frames_identity (user_id, conversation_id, seq)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
	`
		CREATE TABLE agent_session_delete_todos (
		  id                   bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id              bigint NOT NULL,
		  conversation_id      char(36) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  device_fingerprint   varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  createtime           bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_agent_session_delete_todos_identity (user_id, conversation_id),
		  KEY idx_agent_session_delete_todos_machine (user_id, device_fingerprint)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── webauthn_credentials（通行密钥）──
	//
	// credential_id / public_key / aaguid 用 **varbinary** 而不是 varchar：它们是认证器
	// 给出的原始字节，不是文本。存 base64 也能塞进 varchar，但那样每次读写都要多一层
	// 编解码，而且唯一索引会落在编码后的字符串上——同一把凭证换一种 base64 变体
	// （标准 / URL-safe、带不带 padding）就会被认成两把。
	//
	// credential_id 上是**全局**唯一键，不是 (user_id, credential_id)：登录时不要求任何
	// 标识，只能拿凭证 ID 反查账号，那条查询必须唯一命中一行。它同时也是「同一把认证器
	// 不许注册两次」的真正裁决处——选项里的 excludeCredentials 只是给浏览器的提示，
	// 浏览器完全可以不理会。
	//
	// 宽度 512 字节：规范允许凭证 ID 最长 1023 字节，但那超出 InnoDB 单列唯一索引在
	// 多字节字符集下的舒适区，而现实中的认证器（U2F 64 字节、平台认证器 16~64 字节）
	// 都远小于此。varbinary 每字节就是一字节，512 的索引键长在 3072 上限内。
	//
	// last_used_at 与 createtime 分开：清单要同时给出「什么时候加的」与「上次用是什么
	// 时候」，前者永不变、后者每次登录都写。从未用过是 0，不是 createtime——把两者混起来
	// 会让一把从没用过的密钥看上去刚刚用过。
	//
	// (user_id, id) 的联合索引而不是单列 user_id：清单按账号取、按 id 倒序排，联合索引
	// 让排序直接走索引，不必回表再排。
	`
		CREATE TABLE webauthn_credentials (
		  id               bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id          bigint NOT NULL,
		  credential_id    varbinary(512) NOT NULL,
		  public_key       varbinary(1024) NOT NULL,
		  aaguid           varbinary(16) NOT NULL DEFAULT '',
		  sign_count       int unsigned NOT NULL DEFAULT 0,
		  transports       varchar(128) NOT NULL DEFAULT '',
		  name             varchar(64) NOT NULL,
		  backup_eligible  boolean NOT NULL DEFAULT false,
		  backup_state     boolean NOT NULL DEFAULT false,
		  last_used_at     bigint NOT NULL DEFAULT 0,
		  createtime       bigint NOT NULL DEFAULT 0,
		  updatetime       bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_webauthn_credentials_credential_id (credential_id),
		  KEY idx_webauthn_credentials_user (user_id, id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── agent_activity_daily（活跃统计的日滚存）──
	//
	// 活跃统计的唯一数据源。它存的是**计数**，一行是「某账号、某天、某台机器、某个维度
	// 组合下有几条对话」——没有标题、没有路径、没有对话内容。这条边界就是那个开关向用户
	// 承诺的东西，落在 schema 上就是这张表里根本没有那些列。
	//
	// 一条对话只落进一个维度组合，所以按任意维度子集 SUM 都是对的：热力图只按 day 求和，
	// 三张分布卡各按自己那一维求和，同一张表两用。
	//
	// day 存的是 char(10) 而不是 date，这一条看着像退步，是刻意的：这个日界**已经在别处
	// 定过了**——发起端按服务端时区把它切成 "2006-01-02" 报上来，前端拿它当热力图格子的
	// 键，下一次增量拉取又把它原样当 since_day 送回去。它的一生都是这个字符串。
	// 存成 date 会在每一次读上多一次转换，而 DSN 带 parseTime=True，date 回来是
	// time.Time；一旦有人整行扫回实体，那个 string 字段拿到的是
	// "2026-08-28T00:00:00+08:00"，而它会被原样当成下一次的 since_day。char(10) 没有
	// 时区语义可供重新解释，逐字节的排序恰好就是日期序，范围查询照样吃索引。真要做日期
	// 运算时 STR_TO_DATE 一句话的事。
	//
	// dims_hash 是六个维度的 STORED 生成列，参与唯一键。这不是为了省空间，而是必须：
	// 六个 varchar(255) 直接拼进唯一键有 5000+ 字节，超过 InnoDB 3072 字节的索引上限，
	// 建表当场就失败。让数据库自己算这个摘要（而不是应用算了再写）去掉了一整类 bug
	// ——应用与数据库对「什么算同一行」产生分歧时，upsert 会静默地变成插入，计数从此翻倍。
	//
	// 维度列一律 utf8mb4_0900_bin：同步标识是不透明标识，大小写不敏感的比较会把两个不同
	// 的标识认成同一个，两个 Agent 的计数并进一个桶——而这是一张只读作统计的表，并错了
	// 没人会发现。
	`
		CREATE TABLE agent_activity_daily (
		  id               bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id          bigint NOT NULL,
		  day              char(10) COLLATE utf8mb4_0900_bin NOT NULL,
		  peer_fingerprint varchar(255) COLLATE utf8mb4_0900_bin NOT NULL,
		  agent_sync_id    varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  backend_type     varchar(64) NOT NULL DEFAULT '',
		  provider_key     varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  model_key        varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  project_sync_id  varchar(255) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  session_count    int NOT NULL DEFAULT 0,
		  createtime       bigint NOT NULL DEFAULT 0,
		  updatetime       bigint NOT NULL DEFAULT 0,
		  dims_hash        binary(32) AS (UNHEX(SHA2(CONCAT_WS(0x1F,
		                     peer_fingerprint, agent_sync_id, backend_type,
		                     provider_key, model_key, project_sync_id), 256))) STORED NOT NULL,
		  UNIQUE KEY uk_agent_activity_daily_identity (user_id, day, dims_hash),
		  KEY idx_agent_activity_daily_machine (user_id, peer_fingerprint, day)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

	// ── user_settings（账号级设置）──
	//
	// 眼下只有活跃上报这一个开关，但它不该塞进 users：那是身份表，隐私状态与登录凭据
	// 放在一起，每一次读账号都会顺带把它带出来。activity_stats_enabled 默认 0——默认开
	// 等于替用户做了决定，而这个开关的全部意义就是「用户显式同意之后才上报」。
	//
	// activity_last_pull_at 是最近一次**成功拉取**的时刻，由 Pull 每轮写下，不管那一轮
	// 有没有拉到桶。它回答的是「这条管子还通着吗」，所以既不能拿
	// activity_stats_enabled_at（最近一次开启）顶替，也不能拿 agent_activity_daily 的
	// MAX(updatetime) 顶替——后者在一台一周没干活的机器上会停在一周前，而它其实一直在
	// 正常上报空结果。
	//
	// activity_backfill_from 是拉取的**下界日**，在开启那一刻写死：勾了「一并回填历史」
	// 就写空串（没有下界），没勾就写当天。它必须落在库里而不是当场跑一次回填——
	// since_day 取自「这台机器已经收到的最后一天」，一台从没上报过的机器那个值是空串，
	// 而空串的意思正是「把你有的全给我」。少了这一列，取消回填与勾上回填跑出来的结果
	// 一模一样，用户的选择静默失效；而写在库里，一台当时离线的机器几个月后回来，那个
	// 下界依然在。
	//
	// idx_user_settings_activity_enabled 让 ListEnabledUserIDs 是一次覆盖索引查找：
	// 只有 uk_user_settings_identity(user_id) 的话，按 activity_stats_enabled 过滤要
	// 全表扫描（决策 12）。
	`
		CREATE TABLE user_settings (
		  id                        bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
		  user_id                   bigint NOT NULL,
		  activity_stats_enabled    tinyint(1) NOT NULL DEFAULT 0,
		  activity_stats_enabled_at bigint NOT NULL DEFAULT 0,
		  activity_last_pull_at     bigint NOT NULL DEFAULT 0,
		  activity_backfill_from    char(10) COLLATE utf8mb4_0900_bin NOT NULL DEFAULT '',
		  createtime                bigint NOT NULL DEFAULT 0,
		  updatetime                bigint NOT NULL DEFAULT 0,
		  UNIQUE KEY uk_user_settings_identity (user_id),
		  KEY idx_user_settings_activity_enabled (activity_stats_enabled, user_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
}
