/**
 * 预览面的取数端口在本站这一侧的实现（规格 2026-09-08「取数与失败」）。
 *
 * 共享包里的预览面板不认识中继，也不认识 wails —— 它只认 `FilePreviewPorts`。
 * 这份 adapter 把「浏览器 → `/v1/relay/client` → 那台机器的 `workspacefs.*`」
 * 那条通路裹成那个契约，与 `projectFsPort.ts` 对 `remotefs.*` 做的是同一件事。
 *
 * **`root` 由宿主闭包带着**：端口只收 relPath —— 「读哪台机器的哪个工作根」是
 * 宿主的身份问题。这里带的是**中继上的实况会话摘要**给出的 cwd（那台机器直接
 * 交给浏览器的，不进服务端的响应面，R19 因此不变）。
 *
 * **失败一律 reject**：面板会把它冒泡进自己的错误态，宿主不吞异常、不做 toast
 * —— 这是包的端口契约已经定下的。
 */
import type {
  FilePreviewFailure,
  FilePreviewPorts,
  GitFileContentResult,
  ReadFileResult,
} from "@agentre-hub/agentre-ui";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { RelayError, type RelayClient } from "@/lib/relayClient";

/** 有 client 才发得出请求：没有连接时如实给「掉线」，不抛一个说不清的 TypeError。 */
interface PreviewCaller {
  request: RelayClient["request"];
}

export interface FilePreviewPortDeps {
  client: PreviewCaller | null;
  /** 这条会话此刻在那台机器上的工作目录。空串表示还不知道，端口不该被调到。 */
  cwd: string;
}

function disconnected(): RelayError {
  return new RelayError(-1, "relay: 连接未就绪", null);
}

/**
 * workspacefs.* 的稳定 wire 错误码里，预览面区别对待的那一个。
 *
 * 出处是 `agentre/internal/pkg/workspacefs/wire/wire.go`（-32040..-32043 是本族
 * 的稳定段）。那边改了码值这里要跟着改，两边都没有编译器会替我们发现 —— 与
 * `remotefs.ts` 顶上那条双维护义务同一条。
 */
const WorkspaceFsErrorCode = {
  notFound: -32043,
} as const;

/**
 * 给失败贴上面板认得的分类标记（规格决策 4）。
 *
 * 认**错误码**不认文案：message 是那台机器上的 Go 错误文本，改一个字就把判断
 * 打散。认不出的一律不贴 —— 包对没有 `kind` 的失败按「未归类」处理，如实显示
 * 它自己的文案加重试，那比冒充一个已知失败诚实。
 */
function classify(err: unknown): unknown {
  if (!(err instanceof RelayError)) return err;
  if (err.code === WorkspaceFsErrorCode.notFound) {
    return Object.assign(err, {
      kind: "notFound",
    } satisfies FilePreviewFailure);
  }
  // -1 是 RelayClient 自己造的那一类（连接未就绪 / 已关闭 / 断线）：那台机器
  // 此刻够不着，过会儿可能就回来了 —— 这是唯一给重试按钮的失败态。
  if (err.code === -1) {
    return Object.assign(err, { kind: "offline" } satisfies FilePreviewFailure);
  }
  return err;
}

/**
 * wire 上 `content` 是 `bytes`，两种正文共用这一格：
 *
 * - 文本 / markdown / 代码：就是 UTF-8 正文的字节，解码成字符串。
 * - 图片：**真图片字节**（Go 侧在过 proto 时把 base64 解回了原始字节），面板要的
 *   是 base64，所以这里再编回去。判据与 Go 侧同一条：`contentType` 是 image/*。
 *
 * 两条路分开是因为「渲染什么」的判定住在包里（`previewKind`），宿主只负责把
 * 字节还原成包约定的那两种字符串。
 */
function decodeContent(raw: unknown, contentType: string): string {
  // 判的是「是不是一段 ArrayBuffer 视图」而不是 `instanceof Uint8Array`：后者按
  // realm 分身份，jsdom 与模块各自的 Uint8Array 不是同一个构造器，同一段字节会
  // 被判成"不是字节"然后静默变成空文件。
  const bytes = ArrayBuffer.isView(raw)
    ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    : typeof raw === "string"
      ? new TextEncoder().encode(raw)
      : new Uint8Array();
  if (bytes.length === 0) return "";
  if (contentType.startsWith("image/")) return base64Of(bytes);
  return new TextDecoder().decode(bytes);
}

/**
 * 分块编码，不用 `btoa(String.fromCharCode(...bytes))`：后者对一张几 MB 的图会
 * 把参数铺成几百万个实参，直接爆栈（与 relayClient 里那处同一个理由）。
 */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function createFilePreviewPorts(
  deps: FilePreviewPortDeps,
): FilePreviewPorts {
  return {
    async readFile(path: string): Promise<ReadFileResult> {
      if (!deps.client) throw classify(disconnected());
      const raw = await deps.client
        .request(rpcMethods.workspaceFsReadFile, {
          root: deps.cwd,
          relPath: path,
        })
        .catch((err: unknown) => {
          throw classify(err);
        });
      const contentType = raw?.contentType ?? "";
      return {
        content: decodeContent(raw?.content, contentType),
        // proto3 的 omitempty 语义：缺席即 false，不是「不知道」。
        ...(contentType ? { contentType } : {}),
        ...(raw?.binary === true ? { binary: true } : {}),
        ...(raw?.tooLarge === true ? { tooLarge: true } : {}),
      };
    },

    async gitFileContent(path: string): Promise<GitFileContentResult> {
      if (!deps.client) throw classify(disconnected());
      const raw = await deps.client
        .request(rpcMethods.workspaceFsGitFileContent, {
          root: deps.cwd,
          relPath: path,
        })
        .catch((err: unknown) => {
          throw classify(err);
        });
      // notARepo / hasHead 是**视图事实**不是失败：不是 git 仓库、或这个文件还
      // 不在 HEAD 里，面板据此画空基线。当成错误会让「新加的文件」看起来像出了
      // 故障。proto3 的 omitempty：缺席即 false。
      return {
        content: decodeContent(raw?.content, ""),
        ...(raw?.notARepo === true ? { notARepo: true } : {}),
        ...(raw?.hasHead === true ? { hasHead: true } : {}),
      };
    },
  };
}
