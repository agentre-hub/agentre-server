import { rpcMethods } from "@agentre-hub/agentre-wire";
/**
 * R15 / R16 的派发逻辑（从 web 发起新对话）。
 *
 * 与 Go 侧 workspace_svc.WebDispatchPlan 的视图对象同构：
 *   - 计划按序列出执行目标链每一档的原因（available / offline / unpaired /
 *     no_device / project_path_missing），Chosen 为 null = 全部档都不可用；
 *   - R15d 守卫：device_id 为空的「本机」档在浏览器语境下跳过，只在 agentred 里
 *     按顺序取第一档可用的；
 *   - R16：runtime.run 成功后立刻把这条对话保存进账号（POST /v1/saved-sessions），
 *     于是它不经手动保存就出现在「对话」页——发起即保存（2026-08-18-server-session-
 *     mirror 决策 2），镜像随即对它开始，account 持有的是完整的标题与转录。
 *   - R17：不注入 mcpServers（org / subagent / hook 的真身在桌面端），发起前由
 *     界面说明（见 newconv/DraftSession 里那条 R17 说明）。
 *
 * 路径（Cwd）随确认派发阶段的计划到达浏览器，供屏幕 25 呈现与派发 runtime.run——
 * 这是 R19 红线在主动派活场景下的唯一例外（见 workspace_svc.WebDispatchChoice）。
 */
import { runAckFromProtobuf, type RunParams } from "@agentre-hub/agentre-wire";

import { api } from "@/lib/api";
import { randomId } from "@/lib/randomId";
import { RelayClient, RelayError } from "@/lib/relayClient";
import { relayClientUrl } from "@/lib/relayUrl";
import { browserDisplayName, type RelayTicket } from "@/lib/relayTicket";

export type DispatchAvailability =
  "available" | "offline" | "unpaired" | "no_device" | "project_path_missing";

export interface DispatchTier {
  rank: number;
  /**
   * 这一档跨机稳定且逐档唯一的标识。「在哪台机器上跑」挑定的就是它——rank 是位置
   * 性的（重排后就变了），device_id 也不唯一（一台机器可挂多个 backend）。
   */
  backend_sync_id?: string;
  device_id?: number;
  device_name?: string;
  backend_type?: string;
  /** 目标设备种类（desktop / agentred）；无设备的档（本机相对 / 未配对）没有它。 */
  kind?: string;
  availability: DispatchAvailability;
  current: boolean;
}

export interface DispatchChoice {
  device_fingerprint: string;
  device_id: number;
  device_name: string;
  backend_type: string;
  /** 目标设备种类：desktop → org/subagent/hook 可用（R17），agentred → 不可用。 */
  kind?: string;
  cwd?: string;
}

export interface DispatchPlan {
  agent_sync_id: string;
  tiers: DispatchTier[];
  chosen: DispatchChoice | null;
  projects: { sync_id: string; name: string; configured: boolean }[];
}

export interface DispatchPlanQuery {
  agentSyncId: string;
  /** 空 = 不挑项目，一条不钉项目的自由会话（服务端据此不做项目路径判定）。 */
  projectSyncId?: string;
  /**
   * 用户在「在哪台机器上跑」里挑定的那一档。空 = 由服务端按序取第一个可用的。
   *
   * 挑档这件事只能由服务端重算：档结构（DispatchTier）上没有指纹也没有 cwd，
   * 只有 chosen 有——R19 的例外只开给选中的那一档。浏览器自己拼不出来。
   */
  targetBackendSyncId?: string;
}

/** 取某 Agent（+ 可选项目 + 可选执行档）的派发计划。
 *
 * 执行目标链按账号默认顺序（sort_order）解析 —— 用户在总览页排的就是它，所以
 * Chosen 与逐档原因天然跟着他排的顺序走，不需要任何调用方标识（决策 14）。
 *
 * 入参是结构体而不是并排三个 string：三个同步标识挨着传，写颠倒了 TypeScript
 * 一句话都不会说（都是 string），跑起来却会派到另一台机器上。 */
export async function fetchDispatchPlan(
  input: DispatchPlanQuery,
): Promise<DispatchPlan> {
  const qs = new URLSearchParams({ agent_sync_id: input.agentSyncId });
  if (input.projectSyncId) qs.set("project_sync_id", input.projectSyncId);
  if (input.targetBackendSyncId) {
    qs.set("target_backend_sync_id", input.targetBackendSyncId);
  }
  return api<DispatchPlan>(`/v1/workspace/dispatch-target?${qs.toString()}`);
}

/** R15d 守卫：跳过 device_id 为空的档，取按序第一档可用的 agentred。 */
export function pickFirstAvailable(tiers: DispatchTier[]): DispatchTier | null {
  return tiers.find((t) => t.availability === "available") ?? null;
}

/**
 * 会话号的纪元：2024-01-01T00:00:00Z。
 *
 * 定一个自己的起点而不是用 Unix 纪元，是为了把毫秒差压进 41 位（2^41 ms ≈ 69.7
 * 年，够到 2093 年）；剩下 12 位才装得下序列，两段合起来正好 53 位 —— JS 的
 * `number` 能精确表示的上限。多一位就会在 `BigInt(sid)` 过 wire、`String(sid)`
 * 过账号镜像 HTTP 的两条路上悄悄变成另一个号。
 */
export const SESSION_ID_EPOCH_MS = Date.UTC(2024, 0, 1);

/** 低位序列的进制（12 位）。高位乘它、低位加它，正好拼成 41 + 12。 */
export const SESSION_ID_SEQUENCE_SPAN = 4096;

/**
 * 逻辑时钟：只准往前。
 *
 * 系统时钟会倒回去（对时、改时区、休眠唤醒），而朴素的雪花在那一刻会把已经发过
 * 的那几毫秒原样重发一遍 —— 号直接重复。这里以「发过的最大毫秒」为准，系统时钟
 * 落在它后面时就地踏步，靠序列继续往下走。
 */
let lastMs = 0;
/** 这一毫秒已经发了几个。发满 4096 就把逻辑时钟推到下一毫秒，而不是绕回去。 */
let issuedThisMs = 0;
/**
 * 序列的**起点**是每个标签页各自随机抽的，不是固定 0。
 *
 * 同一浏览器的两个标签页可能在同一毫秒里各开一条对话；序列都从 0 起的话那是
 * **必撞**，而随机起点把它降回 1/4096。这是这套布局唯一还靠概率的地方 ——
 * 因为标签页之间没有可协调的东西（localStorage 的读-改-写不是原子的，
 * 在取号这条热路径上引入跨标签页竞态比它要解决的问题更糟）。
 */
let sequence = randomSequenceSeed();

function randomSequenceSeed(): number {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.getRandomValues) {
    const buf = new Uint32Array(1);
    webCrypto.getRandomValues(buf);
    return buf[0] % SESSION_ID_SEQUENCE_SPAN;
  }
  // 没有 WebCrypto 的环境（老 WebView、非安全上下文的某些实现）退回 Math.random：
  // 这一位只用来错开标签页，不承担任何安全语义。
  return Math.floor(Math.random() * SESSION_ID_SEQUENCE_SPAN);
}

/**
 * 新建会话的本地会话标识：53 位雪花（41 位毫秒 + 12 位序列），正整数、非零
 * （wire sessionId 语义，按对端隔离）。
 *
 * 为什么低位是**序列**而不是随机：批量导入（`importPorts.ts`）是在一个循环里
 * 连着要号的，一毫秒里几十上百个。纯随机在这里靠生日概率，序列是确定不撞。
 *
 * 一句话说清这套布局的收益边界：会话号在 daemon 与账号镜像两侧都是按
 * **(发起端指纹, 会话号)** 建键的（daemon 的 `runtimeSessionID`、镜像的决策 17），
 * 所以要防的从来只是「同一个浏览器自己撞自己」。这套布局对那个域是确定不撞的；
 * 跨标签页同毫秒那一格仍是 1/4096（见 `sequence` 的注释）。反过来说，它比此前
 * 那个 53 位均匀随机在**跨浏览器**那一格上是退步的 —— 但那一格本来就不共享
 * 键空间，撞了也互不相干。
 *
 * 「按时间有序」只在**毫秒这一层**成立：同一毫秒内的先后由序列决定，而序列的起点
 * 是随机的、走到 4095 会绕回 0，所以同一毫秒里后发的号可能更小。绕回不会让号重复
 * —— `issuedThisMs` 盯着这件事，发满 4096 就把逻辑时钟推到下一毫秒。
 *
 * 位运算在这里用不了：JS 的 `<<` / `|` 一律先截成 32 位，41 位的时间戳会被削掉
 * 一半。所以高位用乘法、低位用加法。
 */
export function newSessionId(): number {
  // 纪元之前的系统时钟（用户把日期调回 2020）会让号变成负数，而 backend 一律
  // 拒绝非正数会话 id。三者取最大，一次把「回拨」与「早于纪元」都挡掉。
  let ms = Math.max(Date.now(), lastMs, SESSION_ID_EPOCH_MS + 1);
  if (ms === lastMs) {
    if (issuedThisMs >= SESSION_ID_SEQUENCE_SPAN) {
      ms += 1;
      issuedThisMs = 0;
    }
  } else {
    issuedThisMs = 0;
  }
  lastMs = ms;
  issuedThisMs += 1;
  sequence = (sequence + 1) % SESSION_ID_SEQUENCE_SPAN;
  return (ms - SESSION_ID_EPOCH_MS) * SESSION_ID_SEQUENCE_SPAN + sequence;
}

/** 标题派生：首行 + 视觉截断（镜像桌面端 sessionTitleFromFirstMessage）。 */
export function deriveTitle(text: string): string {
  const first = text.trim().split("\n")[0]?.trim() ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first;
}

export interface DispatchedSession {
  sessionId: number;
  deviceId: number;
  deviceFingerprint: string;
  /**
   * 这条对话的标题 —— `deriveTitle(第一句话)`，就是这一次送给 daemon 的那一份。
   *
   * 交出来是为了落地那一屏的**第一帧**就说得出这条对话叫什么：`session.list` 要
   * 等中继票 + WS + attach，账号镜像那一行要等一次 HTTP，两条都没落地时详情头部
   * 只能退回 `#<会话号>`。而这个名字派发那一刻就在手里，没有理由让用户先看一串
   * 十六位数字。它不是猜的，也不会与落库那一份不一致 —— 同一个函数算的同一件事。
   */
  title: string;
  /**
   * 这条对话的**发起端**指纹 —— 就是这个浏览器的中继标识（`sourceClient.clientId`），
   * 与承载它的 `deviceFingerprint` 不是一回事。
   *
   * 落地那一屏（右栏 / 移动端下钻）拿它去问镜像的历史、去记「已读」，而账号里这条
   * 对话的身份键正是 (发起端指纹, 会话号)（决策 17，与上面那次保存报的完全一致）。
   * 交出机器指纹的话两处问的都是一个账号里不存在的身份：转录一帧都读不回来，
   * 「已读」也记在一条不存在的对话上。
   */
  peerFingerprint: string;
  /**
   * 这条对话钉住模型目标了没有。
   *
   * 跟随 Agent 绑定（没什么可钉）时恒为真。假只有一种含义：用户**选了**一个模型、
   * 第一轮也确实按它跑了，但那台机器没能把它记下来 —— 于是后续轮次会回到跟随
   * 绑定。这句话必须传出去，否则详情页会对着一条其实没钉住的对话显示「跟随
   * Agent 绑定」，而用户明明选过。
   */
  modelPinned: boolean;
}

export interface DispatchInput {
  plan: DispatchPlan;
  message: string;
  sourceClient: RelayTicket;
  /**
   * 已经建好的连接。草稿页开局就连上了选中那台机器（问权限档位用的正是它），
   * 给进来就复用：再开一条等于同一台机器上两条会话连接，而第一条的失败信息会被
   * 第二条覆盖。这次派发不负责关它 —— 不是这次建的。
   */
  client?: RelayClient;
  /**
   * 这一轮的权限档位。空 = 不带，由执行端按后端预设解析。
   *
   * 调用方必须先确认该后端**报出了**非空的档位集合再给：daemon 在 piagent 那一路
   * 把这个字段当远端 generation token 比对（`internal/daemon/handlers/runtime.go`），
   * 塞一个真档位进去会让那一轮被判成 stale。
   */
  permissionMode?: string;
  /**
   * 这条对话钉的模型目标。两格皆空 = 跟随 Agent 绑定：既不带过线也不去钉。
   */
  modelTarget?: { providerKey: string; modelKey: string };
}

export class DispatchConnectionError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DispatchConnectionError";
  }
}

export class DispatchRunError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DispatchRunError";
  }
}

/**
 * 发起：连到选中的那台 agentred → runtime.run（新会话）→ 立刻保存进账号（R16）。
 * 连接失败 / 派发失败都会抛错，由界面就地说明，不静默。
 */
export async function dispatchNewConversation(
  input: DispatchInput,
): Promise<DispatchedSession> {
  const choice = input.plan.chosen;
  if (!choice) throw new Error("no available exec target");
  const pinTarget =
    input.modelTarget && input.modelTarget.providerKey !== ""
      ? input.modelTarget
      : null;
  // 交出去与送过线的是同一个值，不是各算一次：`RunParams.title` 在生成的类型上是
  // 可选的，取回来会是 `string | undefined`。
  const title = deriveTitle(input.message);
  const params: RunParams = {
    sessionId: newSessionId(),
    title,
    // agentId 是**桌面端本地**自增主键，浏览器没有也不该编一个：账号级归属由
    // agentSyncId（决策 3 的 ULID）表达。Go 侧 RunParams.AgentID 没有 omitempty，
    // 生成的类型因此是必填 —— 显式 0 与此前省略这个键在 daemon 上解出的值相同。
    agentId: 0,
    agentSyncId: input.plan.agent_sync_id,
    cwd: choice.cwd ?? "",
    userText: input.message.trim(),
    // daemon 端按 {"type": ...} 解 backend（integration_test 的既有契约）。
    backend: { type: choice.backend_type },
    sourceDevice: input.sourceClient.clientId,
    sourceDeviceName: browserDisplayName(),
    // 档位与模型只在**用户真的定了**时才带：空串与省略在 daemon 上解出的值相同,
    // 但带一个空值等于浏览器在主张「就用空的」,而跟随绑定本来就是不主张。
    ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
    ...(pinTarget
      ? {
          llmProviderKey: pinTarget.providerKey,
          llmModelKey: pinTarget.modelKey,
        }
      : {}),
    // R17：不注入 mcpServers —— org / subagent / hook 是真身在桌面端的内置工具，
    // web 发起的对话用不了它们（发起前已由界面说明）。
  };
  const owned = input.client
    ? null
    : new RelayClient({
        url: relayClientUrl(
          choice.device_fingerprint,
          input.sourceClient.accessToken,
        ),
        jwt: input.sourceClient.accessToken,
        deviceFingerprint: input.sourceClient.clientId,
        reconnect: false,
      });
  const client = input.client ?? owned!;
  try {
    if (owned) {
      try {
        await owned.connect();
      } catch (error: unknown) {
        throw new DispatchConnectionError(error);
      }
    }
    const requestRun = async (runParams: RunParams) => {
      try {
        return await client.request(rpcMethods.runtimeRun, {
          ...runParams,
          agentId: BigInt(runParams.agentId),
          sessionId: BigInt(runParams.sessionId),
        } as never);
      } catch (error: unknown) {
        if (error instanceof RelayError && error.code === -1) {
          throw new DispatchConnectionError(error);
        }
        throw new DispatchRunError(error);
      }
    };
    let ack;
    if (choice.kind === "agentred" && choice.backend_type === "piagent") {
      const generationOwner = `web-pi-generation-${randomId()}`;
      const piParams = { ...params, permissionMode: generationOwner };
      try {
        const registration = runAckFromProtobuf(await requestRun(piParams));
        if (registration.sessionId !== params.sessionId) {
          throw new DispatchRunError(
            new Error("Pi registration acknowledged a different session"),
          );
        }
        const prepared = runAckFromProtobuf(await requestRun(piParams));
        const providerSessionId = prepared.providerSessionId?.trim() ?? "";
        if (
          prepared.sessionId !== params.sessionId ||
          providerSessionId === ""
        ) {
          throw new DispatchRunError(
            new Error("Pi preparation returned an invalid session identity"),
          );
        }
        ack = runAckFromProtobuf(
          await requestRun({
            ...piParams,
            providerSessionId,
          }),
        );
        if (
          ack.sessionId !== params.sessionId ||
          ack.providerSessionId?.trim() !== providerSessionId
        ) {
          throw new DispatchRunError(
            new Error("Pi start acknowledged a different prepared generation"),
          );
        }
      } catch (error: unknown) {
        try {
          await client.request(rpcMethods.runtimeAbort, {
            sessionId: BigInt(params.sessionId),
          });
        } catch {
          // 原始派发错误才是用户需要处理的事实；清理失败不能把它盖掉。
        }
        throw error;
      }
    } else {
      const raw = await requestRun({
        ...params,
      });
      ack = runAckFromProtobuf(raw);
    }
    // R16 的发起即保存是派发**成功之后**的收尾:ack 一到手,那台机器上就已经真真切切
    // 多了一条会话。保存写失败只是这条不会自动出现在「对话」页(用户仍能在会话详情
    // 里手动保存),把它报成派发失败会让界面说「联系不上这台机器,请重试」——用户一
    // 重试就凭空再开一条真会话,第一条还留在机器上跑。因此这一步不参与成败判定。
    //
    // 身份的两半分开报，因为对 web 派发它们不是同一个值：
    //   machine_fingerprint 是**承载**它的那台机器（镜像据它决定去连谁）；
    //   peer_fingerprint 是**发起**它的那一端 —— 就是这个浏览器。agentred 按
    //   (发起端指纹, 会话号) 解会话，它 daemon_sessions 上记的正是这个值。
    //
    // 这里曾经只报机器、并说「这台机器刚刚建出这条会话，它自己就是 peer」——
    // 那句话对桌面端成立（会话在本机 daemon 上建，不带 origin），对 web 派发不
    // 成立。混作一谈的后果是这条对话在镜像里永远匹配不上，账号里明明保存了，
    // 左栏却一行都没有。
    try {
      await api("/v1/saved-sessions", {
        method: "POST",
        body: JSON.stringify({
          machine_fingerprint: choice.device_fingerprint,
          peer_fingerprint: input.sourceClient.clientId,
          session_id: String(ack.sessionId),
        }),
      });
    } catch {
      // 保存没写上:会话已经建起来了,交给调用方照常跳转。
    }
    return {
      sessionId: ack.sessionId,
      deviceId: choice.device_id,
      deviceFingerprint: choice.device_fingerprint,
      title,
      peerFingerprint: input.sourceClient.clientId,
      modelPinned: pinTarget
        ? await pinModelTarget(client, ack.sessionId, pinTarget)
        : true,
    };
  } finally {
    // 只关自己建的那条:复用进来的连接还归调用方用。
    owned?.close();
  }
}

/**
 * 把这条对话钉的模型目标写到它自己身上。
 *
 * 为什么 run 带过一次还要再写一次：daemon 的 `runtime.run` 按轮 `resolveTarget`,
 * **不**写 `daemon_sessions` 的 provider_key / model_key（那两列由
 * `202608230001` 迁移引入,只有 `runtime.setModelTarget` 写）。只过线不钉住,用户选的
 * 模型第一轮生效、随后打开详情页却读回空 = 「跟随 Agent 绑定」——一句用户无法证伪
 * 的假话,正是 2026-08-23 那轮规格在治的东西。
 *
 * 派发时选中的那一台既是发起端也是承载者（这条对话就是这一刻由这条连接在它上面
 * 建出来的）,所以只写它一台,不做详情页那套「两台都写」。
 *
 * 写不上不抛错:派发已经成功,那台机器上真真切切多了一条按所选模型跑起来的会话。
 * 把它报成派发失败,用户一重试就凭空再开一条。
 */
async function pinModelTarget(
  client: RelayClient,
  sessionId: number,
  target: { providerKey: string; modelKey: string },
): Promise<boolean> {
  try {
    await client.request(rpcMethods.setModelTarget, {
      sessionId: BigInt(sessionId),
      providerKey: target.providerKey,
      modelKey: target.modelKey,
    });
    return true;
  } catch {
    return false;
  }
}
