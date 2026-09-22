/**
 * `portForward.*` 的**声明族**（list / create / setEnabled / delete），经中继裸传。
 *
 * **服务端一行代码都不需要改**，与 `remotefs.ts` 同一条路：这四个方法早就注册在
 * agentred 与桌面端两侧的静态 registry 上（`@agentre-hub/agentre-wire` 的
 * `host-contract.gen.ts` 把它们同时列进两类对端的可答方法），中继是字节级透传。
 * 浏览器 → `/v1/relay/client` → 那台机器 → 原路回来，服务端不解析、不落库 ——
 * 这条能力因此**不改变 R19 的守卫面**：那道守卫走的是响应结构体的反射面，中继帧
 * 不在那个面上。
 *
 * **流族（open / write / close / ack）刻意不在这里。** 那四个是连接级的转发流，
 * 由服务端那一侧的 Go 代理与设备对接；浏览器发出的是普通 HTTP 请求，一个字节都
 * 不经这条 RPC 通道。前端引用它们就是把两条通路搅在一起。
 *
 * 方法名与错误码都由 `@agentre-hub/agentre-wire` 供给，这个文件不自己抄一份。
 *
 * **地址不再是拼出来的。**（规格 2026-09-21「地址与路由」）此前 `portForwardAddress`
 * 用 `${origin}/fw/${deviceId}/${port}/` 现算一条路径；那条路由已经不存在——按
 * Host 分发的转发域 `<前缀>.<base_domain>` 取代了它。地址现在要向服务端要
 * （`allocatePortForwardLink`），这个文件因此多了一段与四个声明方法**不同源**的
 * 逻辑：那四个是中继裸传到设备，这一段是打本站自己的 `/v1/port-forwards/links`
 * （会话 + CSRF，见 `@/lib/api`）。两段错误也因此分两套分辨函数，不能用同一个
 * `classify*`：一个认的是 wire 错误码，一个认的是 HTTP 状态码。
 */
import {
  ErrCodePortForwardDisabled,
  ErrCodePortForwardInvalidTarget,
  ErrCodePortForwardNotDeclared,
  ErrCodePortForwardPortTaken,
  rpcMethods,
} from "@agentre-hub/agentre-wire";

import { ApiError, api } from "@/lib/api";
import { RelayError } from "@/lib/relayClient";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/**
 * 一条声明在本站的适配形状。
 *
 * 与线上形状的差别只有 id：wire 上是 int64（`bigint`），而共享包的
 * `PortForwardMappingView.id` 是字符串（宿主主键原样带过来）。收在这里转一次，
 * 免得每个调用点各转各的。时间戳这一屏不用，不带。
 *
 * `target` 是设备规范化之后的目标（形如 `"http://127.0.0.1:3000"`），总是带着
 * 端口；行上按共享包的 `formatPortForwardTarget` 显示——环回目标只显示端口，
 * 其余显示完整目标（规格「控制台界面」）。
 */
export interface PortForwardDeclaration {
  id: string;
  /** 仍然由设备算出来，只给排序用（`byPort`）——包内不排序，排法归宿主。 */
  port: number;
  target: string;
  name: string;
  enabled: boolean;
}

interface WireMapping {
  id: bigint;
  port: number;
  name: string;
  enabled: boolean;
  target: string;
  insecure: boolean;
}

function toDeclaration(raw: WireMapping): PortForwardDeclaration {
  return {
    id: String(raw.id),
    port: raw.port,
    target: raw.target,
    name: raw.name,
    enabled: raw.enabled,
  };
}

/** 按端口排：包内不排序（免得两端排法分叉），排法归宿主。 */
export function byPort(
  list: PortForwardDeclaration[],
): PortForwardDeclaration[] {
  return [...list].sort((a, b) => a.port - b.port);
}

export async function listPortForwards(
  fingerprint: string,
): Promise<PortForwardDeclaration[]> {
  const raw = await withRelayClient(machineTarget(fingerprint), (client) =>
    client.request(rpcMethods.portForwardList, {}),
  );
  return byPort((raw?.mappings ?? []).map(toDeclaration));
}

/**
 * 新增一条声明。目标接受三种写法（纯端口 / `host:port` / `http(s)://host[:port]`），
 * `insecure` 只对显式 https 目标有意义——判定权威恒在设备侧，这里原样透传
 * （规格「映射与目标」决策 8）。
 */
export async function createPortForward(
  fingerprint: string,
  target: string,
  name: string,
  insecure: boolean,
): Promise<PortForwardDeclaration> {
  const raw = await withRelayClient(machineTarget(fingerprint), (client) =>
    client.request(rpcMethods.portForwardCreate, { target, name, insecure }),
  );
  // 落库之后那一行由设备定（id、启用位都不猜）；答不出行就是协议出了问题。
  if (!raw?.mapping) throw new RelayError(-1, "relay: 应答里没有映射", raw);
  return toDeclaration(raw.mapping);
}

export async function setPortForwardEnabled(
  fingerprint: string,
  id: string,
  enabled: boolean,
): Promise<PortForwardDeclaration> {
  const raw = await withRelayClient(machineTarget(fingerprint), (client) =>
    client.request(rpcMethods.portForwardSetEnabled, {
      id: BigInt(id),
      enabled,
    }),
  );
  if (!raw?.mapping) throw new RelayError(-1, "relay: 应答里没有映射", raw);
  return toDeclaration(raw.mapping);
}

export async function deletePortForward(
  fingerprint: string,
  id: string,
): Promise<void> {
  await withRelayClient(machineTarget(fingerprint), (client) =>
    client.request(rpcMethods.portForwardDelete, { id: BigInt(id) }),
  );
}

/**
 * 一次失败落在哪一类。
 *
 * 认的是**错误码**而不是 message：message 是设备那边的 Go 错误文本，改一个字就会把
 * 这里的判断打散，而错误码写在 wire 契约上。认不出来的一律 `unknown` 并带上原文。
 *
 * `gone` 与 `disabled` 说的是「手上这份列表已经旧了」——别的客户端刚改过；调用方据此
 * 重取，而不是把一句机器原话摆到用户面前。
 *
 * `targetTaken` / `invalidTarget` 是 2026-09-21 从「端口」改收「目标」之后的叫法
 * （原 `portTaken` / `invalidPort`）：`ErrCodePortForwardPortTaken` 这个码名字沿用
 * 历史（见设备侧 `portforward.ErrPortTaken` 的注释），语义已经是「目标已经声明过」。
 */
export type PortForwardFailureKind =
  | "gone"
  | "disabled"
  | "targetTaken"
  | "invalidTarget"
  | "disconnected"
  | "unknown";

export interface PortForwardFailure {
  kind: PortForwardFailureKind;
  message: string;
}

export function classifyPortForwardError(err: unknown): PortForwardFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (!(err instanceof RelayError)) {
    // 走到这里说明连通道都没开起来（票没换到 / 那台机器接不上），不是对端答了个
    // 错误码 —— 对用户而言这是「够不着」，不是「这次操作本身不对」。
    return { kind: "disconnected", message };
  }
  switch (err.code) {
    case ErrCodePortForwardNotDeclared:
      return { kind: "gone", message };
    case ErrCodePortForwardDisabled:
      return { kind: "disabled", message };
    case ErrCodePortForwardPortTaken:
      return { kind: "targetTaken", message };
    case ErrCodePortForwardInvalidTarget:
      return { kind: "invalidTarget", message };
    // -1 是 RelayClient 自己造的那一类（连接未就绪 / 客户端已关闭 / 断线 / 超时）。
    case -1:
      return { kind: "disconnected", message };
    default:
      return { kind: "unknown", message };
  }
}

// ── 分配前缀（`/v1/port-forwards/links`） ────────────────────────────────────

/**
 * `POST /v1/port-forwards/links` 的响应（S2 `internal/api/portforwardlink.
 * CreateResponse`）：对同一个 (设备, 映射 id) 重复调用，拿到的永远是同一个前缀
 * （规格「地址与路由」的「分配前缀」）。
 */
export interface PortForwardLink {
  prefix: string;
  url: string;
}

/**
 * 对自己名下的一台设备、一条映射 id 申请（或复用）转发子域地址。
 *
 * 会话 + CSRF 走 `@/lib/api` 的 `api()`（cookie 会话 + `X-CSRF-Token`，与这一页
 * 别的写请求同一条路），不经中继——这条端点在服务端自己身上，不打那台设备。
 */
export function allocatePortForwardLink(
  deviceId: number,
  mappingId: string,
): Promise<PortForwardLink> {
  return api<PortForwardLink>("/v1/port-forwards/links", {
    method: "POST",
    body: JSON.stringify({
      device_id: deviceId,
      mapping_id: Number(mappingId),
    }),
  });
}

/**
 * 分配前缀这条路失败落在哪一类。与 `classifyPortForwardError` 分开：那一个认的是
 * wire 错误码（对端是设备），这一个认的是 HTTP 状态码（对端是本站自己）。
 *
 * `unavailable`：部署没配 `base_domain`（503，`code.PortForwardLinksUnavailable`）—
 * 服务端的应答文案已经是「这个部署此刻提供不了端口转发」这句人话（与账号页
 * `loadErrorText` 同一条口径：`ApiError.message` 本身就是可展示的服务端文案，这里
 * 不再拷贝一份），调用方原样显示即可。
 *
 * `notFound`：设备不是这个账号的、映射已撤销或不存在（404，与今天「设备不是你的」
 * 同一个口径）。手上这一行大概率是被并发操作抢先删掉的——调用方据此重取列表，
 * 而不是把一句机器原话摆到用户面前。
 */
export type PortForwardLinkFailureKind = "unavailable" | "notFound" | "unknown";

export interface PortForwardLinkFailure {
  kind: PortForwardLinkFailureKind;
  message: string;
}

export function classifyPortForwardLinkError(
  err: unknown,
): PortForwardLinkFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof ApiError) {
    if (err.status === 503) return { kind: "unavailable", message };
    if (err.status === 404) return { kind: "notFound", message };
  }
  return { kind: "unknown", message };
}
