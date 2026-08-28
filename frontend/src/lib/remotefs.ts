/**
 * `remotefs.*` —— 远端机器上的目录浏览，经中继裸传（规格 2026-08-20 决策 5、6）。
 *
 * **服务端一行代码都不需要改。** agentred 早就把 `remotefs.listDir` /
 * `remotefs.mkdir` 注册在静态 registry 上、用 `requireAuth` 守着，与浏览器控制台
 * 已经在用的 `session.pull` / `session.delete` 同一道守卫；中继是字节级透传。
 * **桌面端从 2026-08-21 起挂的是同一份 handler**（换成它自己那道账号守卫），
 * 因此这一份客户端对两类机器一视同仁——错误分类也是同一份。
 * 浏览器 → `/v1/relay/client` → 那台机器 → 原路回来，服务端不解析、不落库、
 * 不记正文——这条能力因此**不改变 R19 的守卫面**：那道守卫走的是响应结构体的反射面，
 * 中继帧不在那个面上。
 *
 * **形状在这里重新声明，不改 agentre 仓**（决策 6）：`@agentre-hub/agentre-wire` 的
 * dist 里没有 remotefs 形状，而它按 commit 钉在 package.json 上；先给那个包加、
 * 再推送、再挪钉子、再 install，四步跨两个仓，期间本仓对着新组件写不了测试。
 * 本仓已有两处同形先例（`agent_session_entity` 重新声明 `wire.SessionSummary`、
 * `sync_entity.GuardPayload`），它们同样在注释里写明了双维护义务：
 *
 *   **出处是 `agentre/internal/pkg/remotefs/wire/wire.go`。** 那边改了键名或错误码，
 *   这里要跟着改，两边都没有编译器会替我们发现。
 */
import { rpcMethods } from "@agentre-hub/agentre-wire";
import { RelayClient, RelayError } from "@/lib/relayClient";

export const MethodListDir = "remotefs.listDir";
export const MethodMkdir = "remotefs.mkdir";

/** Protobuf RPC 错误码，稳定 wire 值（wire.proto 的 -32030..-32035）。 */
export const RemoteFsErrorCode = {
  pathRefused: -32030,
  permDenied: -32031,
  notFound: -32032,
  notDir: -32033,
  mkdirExists: -32034,
  invalidName: -32035,
} as const;

export interface RemoteFsEntry {
  name: string;
  isDir: boolean;
  size: number;
  /** unix 秒。 */
  mtime: number;
  symlink?: boolean;
}

export interface ListDirResult {
  /** 那台机器解析后的绝对路径：请求里传空串就是它的 $HOME。 */
  path: string;
  entries: RemoteFsEntry[];
  /** 条目过多时为 true——只列出了前若干项，**不能假装这就是全部**。 */
  truncated: boolean;
}

/**
 * 一次失败落在哪一类。分得开是有代价才做的：「空目录」与「不让看」在界面上必须是
 * 两件不同的事，把权限拒绝画成一个空目录，用户会以为那台机器上什么都没有。
 */
export type RemoteFsFailureKind =
  | "denied"
  | "notFound"
  | "notDir"
  | "refused"
  | "exists"
  | "invalidName"
  | "disconnected"
  | "unknown";

export interface RemoteFsFailure {
  kind: RemoteFsFailureKind;
  message: string;
}

/** 有 client 才发得出请求：没有连接时如实给「掉线」，不抛一个说不清的 TypeError。 */
interface RemoteFsCaller {
  request: RelayClient["request"];
}

export async function listDir(
  client: RemoteFsCaller | null,
  path: string,
): Promise<ListDirResult> {
  if (!client) throw disconnected();
  const raw = await client.request(rpcMethods.remoteFsListDir, { path });
  return {
    path: raw?.path ?? path,
    entries: Array.isArray(raw?.entries)
      ? raw.entries.map((entry) => ({
          name: entry.name,
          isDir: entry.isDir,
          size: Number(entry.size),
          mtime: Number(entry.modTime),
          symlink: entry.symlink,
        }))
      : [],
    // `truncated` 在 wire 上是 omitempty：缺席即为 false，不是「不知道」。
    truncated: raw?.truncated === true,
  };
}

export async function mkdir(
  client: RemoteFsCaller | null,
  parent: string,
  name: string,
): Promise<{ path: string }> {
  if (!client) throw disconnected();
  const raw = await client.request(rpcMethods.remoteFsMkdir, { parent, name });
  return { path: raw?.path ?? joinPath(parent, name) };
}

function disconnected(): RelayError {
  return new RelayError(-1, "relay: 连接未就绪", null);
}

/**
 * 把一次失败翻成可分辨的一类。
 *
 * 认的是**错误码**而不是 message：message 是 agentred 那边的 Go 错误文本，改一个字
 * 就会把这里的判断打散，而错误码是写进 wire 契约的稳定值。认不出来的一律
 * `unknown` 并把原文带上——编一个类比说「不知道」更糟。
 */
export function classifyRemoteFsError(err: unknown): RemoteFsFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof RelayError)) return { kind: "unknown", message };
  switch (err.code) {
    case RemoteFsErrorCode.permDenied:
      return { kind: "denied", message };
    case RemoteFsErrorCode.notFound:
      return { kind: "notFound", message };
    case RemoteFsErrorCode.notDir:
      return { kind: "notDir", message };
    case RemoteFsErrorCode.pathRefused:
      return { kind: "refused", message };
    case RemoteFsErrorCode.mkdirExists:
      return { kind: "exists", message };
    case RemoteFsErrorCode.invalidName:
      return { kind: "invalidName", message };
    // -1 是 RelayClient 自己造的那一类（连接未就绪 / 客户端已关闭 / 断线）。
    case -1:
      return { kind: "disconnected", message };
    default:
      return { kind: "unknown", message };
  }
}

/** 当前目录是不是一个 Git 仓库：**判据只看这一次 listDir 的条目**，不额外发请求。 */
export function isGitRepo(entries: RemoteFsEntry[]): boolean {
  return entries.some((e) => e.name === ".git");
}

/** 只有目录能被选中做项目根，文件不列——列出来只会让人点了没反应。 */
export function directoriesOf(entries: RemoteFsEntry[]): RemoteFsEntry[] {
  return entries
    .filter((e) => e.isDir)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function joinPath(parent: string, name: string): string {
  if (parent === "/") return `/${name}`;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** 面包屑：`/srv/work` → [{name:"/",path:"/"},{name:"srv",…},{name:"work",…}]。 */
export function breadcrumbOf(path: string): { name: string; path: string }[] {
  const segments = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const segment of segments) {
    acc = `${acc}/${segment}`;
    out.push({ name: segment, path: acc });
  }
  return out;
}

/** 上一级；已经在根上就还是根。 */
export function parentOf(path: string): string {
  const crumbs = breadcrumbOf(path);
  return crumbs.length > 1 ? crumbs[crumbs.length - 2].path : "/";
}
