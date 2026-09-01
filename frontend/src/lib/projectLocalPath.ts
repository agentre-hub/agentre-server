/**
 * `project.*` —— 桌面端本机路径的写入，经中继裸传（规格 2026-08-21 决策 1）。
 *
 * **为什么不是一个 REST 端点。** 桌面端的本机路径不参与同步，只按 30 秒内容指纹
 * 单向上报给服务端，且是整份快照替换。服务端往那份快照里直写一行，那台机器下一次
 * 上报就把它冲掉——给它一个按钮等于给一个按了不生效的按钮（这正是 2026-08-20
 * 决策 4 当初的判断）。所以浏览器要改它，只能经中继喊到那台机器上去，由**它自己**
 * 写、自己重报。agentred 不同：它的路径是账号级同步对象，走
 * `/v1/workspace/org/project-locations` 那条 REST，服务端直写即可。
 *
 * 与 `remotefs.*` 同样，服务端在这条线上只是字节搬运：不解析、不落库、不记正文，
 * 因此这条能力**不改变 R19 的守卫面**。
 *
 * **形状在这里重新声明**（沿用 2026-08-20 决策 6 的双维护约定）：
 *
 *   **出处是 `agentre/internal/pkg/agentruntime/runtimes/remote/wire/wire.go`。**
 *   那边改了键名或错误码，这里要跟着改，两边都没有编译器会替我们发现。
 *
 * 与 `remotefs.*` 有一处不同：这几个方法住在**会生成 TS 的**那个 wire 包里，因此
 * `@agentre-hub/agentre-wire` 的 `dist` 里迟早会有同名的常量与编解码。等本仓把
 * `frontend/package.json` 上那枚 commit 钉子挪过去之后，这一份就该删掉改用它——
 * 留着两份是这个文件唯一的债。
 */
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { RelayClient, RelayError } from "@/lib/relayClient";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

export const MethodProjectSetLocalPath = "project.setLocalPath";
export const MethodProjectClearLocalPath = "project.clearLocalPath";

/** Protobuf RPC 错误码，稳定 wire 值（wire.proto 的 -32050..-32052）。 */
export const ProjectLocalPathErrorCode = {
  notSynced: -32050,
  invalidPath: -32051,
  pathNotFound: -32052,
} as const;

export interface ProjectLocalPathResult {
  /** 生效后的本机路径；移除之后为空。 */
  path: string;
  /** 为假即这个项目在那台机器上处于「本机未配置路径」。 */
  configured: boolean;
}

/**
 * 一次失败落在哪一类。
 *
 * `notSynced` 与其余几类**必须分得开**：项目可以先在 web 上建出来，那一刻目标机器
 * 可能还没把这一行拉下来——等一会儿就好，而把它折进「写失败了」会让人去查权限
 * 和磁盘。
 */
export type ProjectLocalPathFailureKind =
  "notSynced" | "invalidPath" | "pathNotFound" | "disconnected" | "unknown";

export interface ProjectLocalPathFailure {
  kind: ProjectLocalPathFailureKind;
  message: string;
}

/** 有 client 才发得出请求：没有连接时如实给「掉线」，不抛一个说不清的 TypeError。 */
interface ProjectLocalPathCaller {
  request: RelayClient["request"];
}

function decode(raw: unknown): ProjectLocalPathResult {
  const value = raw as Partial<ProjectLocalPathResult> | null | undefined;
  return {
    path: typeof value?.path === "string" ? value.path : "",
    // `configured` 缺席时按「没配上」处理：把一个读不出来的应答当成成功，
    // 会让界面显示一个那台机器上并不存在的状态。
    configured: value?.configured === true,
  };
}

export async function setDesktopLocalPath(
  client: ProjectLocalPathCaller | null,
  projectSyncId: string,
  path: string,
): Promise<ProjectLocalPathResult> {
  if (!client) throw disconnected();
  return decode(
    await client.request(rpcMethods.projectSetLocalPath, {
      projectSyncId,
      path,
    }),
  );
}

/**
 * 移除是**自己的方法**，不是「把路径设成空串」：后者在那一侧要么被路径校验挡下，
 * 要么真的写进去一个空路径，两种都不是用户要的「这台机器上先别管这个项目」。
 */
export async function clearDesktopLocalPath(
  client: ProjectLocalPathCaller | null,
  projectSyncId: string,
): Promise<ProjectLocalPathResult> {
  if (!client) throw disconnected();
  return decode(
    await client.request(rpcMethods.projectClearLocalPath, { projectSyncId }),
  );
}

function disconnected(): RelayError {
  return new RelayError(-1, "relay: 连接未就绪", null);
}

/**
 * 把一次失败翻成可分辨的一类。认的是**错误码**而不是 message——message 是那一侧的
 * Go 文本，改一个字就会把这里的判断打散。认不出来的一律 `unknown` 并带上原文。
 */
export function classifyProjectLocalPathError(
  err: unknown,
): ProjectLocalPathFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof RelayError)) return { kind: "unknown", message };
  switch (err.code) {
    case ProjectLocalPathErrorCode.notSynced:
      return { kind: "notSynced", message };
    case ProjectLocalPathErrorCode.invalidPath:
      return { kind: "invalidPath", message };
    case ProjectLocalPathErrorCode.pathNotFound:
      return { kind: "pathNotFound", message };
    // -1 是 RelayClient 自己造的那一类（连接未就绪 / 客户端已关闭 / 断线）。
    case -1:
      return { kind: "disconnected", message };
    default:
      return { kind: "unknown", message };
  }
}

/**
 * 两个「借一条连接、调一次、还回去」的外层。与 `fetchSkillCatalog` 同一形状——一次
 * 写入不值得自己建一条连接，而池子里通常已经有一条了（详情页开着的那条）。
 *
 * 还回去用的是 `release()` 而不是 `close()`：这条连接不是我们建的，也不归我们关。
 *
 * 拨不通、握手失败、对面报错都**抛**：调用方据此就地给出可分辨的说明，
 * 而不是拿一个成功的应答冒充。
 */
export async function setLocalPathOnMachine(
  fingerprint: string,
  projectSyncId: string,
  path: string,
): Promise<ProjectLocalPathResult> {
  return callOnMachine(fingerprint, (client) =>
    setDesktopLocalPath(client, projectSyncId, path),
  );
}

export async function clearLocalPathOnMachine(
  fingerprint: string,
  projectSyncId: string,
): Promise<ProjectLocalPathResult> {
  return callOnMachine(fingerprint, (client) =>
    clearDesktopLocalPath(client, projectSyncId),
  );
}

async function callOnMachine<T>(
  fingerprint: string,
  call: (client: ProjectLocalPathCaller) => Promise<T>,
): Promise<T> {
  if (!fingerprint) throw disconnected();
  return withRelayClient(machineTarget(fingerprint), (client) => call(client));
}
