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
 */
import {
  ErrCodePortForwardDisabled,
  ErrCodePortForwardInvalidPort,
  ErrCodePortForwardNotDeclared,
  ErrCodePortForwardPortTaken,
  rpcMethods,
} from "@agentre-hub/agentre-wire";

import { RelayError } from "@/lib/relayClient";
import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/**
 * 一条声明在本站的适配形状。
 *
 * 与线上形状的差别只有 id：wire 上是 int64（`bigint`），而共享包的
 * `PortForwardMappingView.id` 是字符串（宿主主键原样带过来）。收在这里转一次，
 * 免得每个调用点各转各的。时间戳这一屏不用，不带。
 */
export interface PortForwardDeclaration {
  id: string;
  port: number;
  name: string;
  enabled: boolean;
}

/**
 * 这条映射的访问地址（决策 4：地址里的设备用 `device_id`）。
 *
 * **尾斜杠是必须的**，但不是为了省一跳重定向：服务端路由是一整条通配尾段
 * `/fw/*forward`（`internal/api/portforward/route.go`），`/fw/12/3000` 与
 * `/fw/12/3000/` 都直接进处理器、都被剥成 `/`，谁都不吃 301
 * （`TestForward_TrailingSlashBehaviourIsPinned` 钉着这条）。
 *
 * 真正的理由在**浏览器这一侧**：不带尾斜杠时，被转发应用自己那些相对链接会以
 * `/fw/12/` 为基准解析，`foo.js` 落到 `/fw/12/foo.js` 上——那不是一条转发地址。
 * 带上尾斜杠，基准才是这条映射的根。
 *
 * 给的是绝对地址而不是路径：这一格是**要被复制走**的，复制出来贴进另一个标签页
 * 的地址栏才有意义；而显示与复制必须是同一个串，否则「复制地址」拿走的就不是
 * 屏幕上那一条。
 */
export function portForwardAddress(deviceId: number, port: number): string {
  return `${window.location.origin}/fw/${deviceId}/${port}/`;
}

interface WireMapping {
  id: bigint;
  port: number;
  name: string;
  enabled: boolean;
}

function toDeclaration(raw: WireMapping): PortForwardDeclaration {
  return {
    id: String(raw.id),
    port: raw.port,
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

export async function createPortForward(
  fingerprint: string,
  port: number,
  name: string,
): Promise<PortForwardDeclaration> {
  const raw = await withRelayClient(machineTarget(fingerprint), (client) =>
    client.request(rpcMethods.portForwardCreate, { port, name }),
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
 */
export type PortForwardFailureKind =
  | "gone"
  | "disabled"
  | "portTaken"
  | "invalidPort"
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
      return { kind: "portTaken", message };
    case ErrCodePortForwardInvalidPort:
      return { kind: "invalidPort", message };
    // -1 是 RelayClient 自己造的那一类（连接未就绪 / 客户端已关闭 / 断线 / 超时）。
    case -1:
      return { kind: "disconnected", message };
    default:
      return { kind: "unknown", message };
  }
}
