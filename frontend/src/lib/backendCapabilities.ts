/**
 * 「这个后端支持哪几档权限模式」——问执行端本人，不在这一侧按后端类型猜。
 *
 * 此前本站把 claudecode 的四档连同文案写死在详情页的调用点上，别的后端一律给空
 * 数组（于是控件整颗消失）。而 codex 实际有两档：本站既列不出它支持的，也会对别的
 * 后端列出它不支持的。桌面端从来不是这么干的——它读的是 runtime 自己报的能力矩阵。
 *
 * 过线的形状：中继上的应答是 Protobuf 的 `agentre.wire.RuntimeCapabilitiesResponse`
 * （`RelayClient.request` 的返回类型就是 `MessageShape<M["response"]>`）。权限档位在
 * 它自己那一格 `permission_mode` 上，字段名按 protobuf-es 的小驼峰：
 * `permissionMode.{allowedModes,defaultMode,switchableDuringTurn,order}`；
 * `capabilities` 则是一串 `CapabilityEntry`，与档位无关。
 *
 * 只解这一种形状，不额外兼容上一代那份 Go 导出名的 JSON 透传
 * （`capabilities.PermissionModeMeta.AllowedModes`）：它在中继改走 Protobuf 之后
 * 一次都不会再出现，留着只会让「解不动」这件事更难被发现——上一版正是照那份形状解的，
 * 于是每一台机器上的每一条对话都恒定解成 null，界面常驻一句「这台机器此刻列不出
 * 权限档位」，而权限档位控件整颗消失。
 */

/** 一个 runtime 报出来的权限档位元数据。 */
export interface PermissionModeMeta {
  /** 这个 runtime 允许的全部档位。**空数组 = 这个后端没有权限门**，不是「没答」。 */
  allowedModes: string[];
  /** 没有显式选择时该用哪一档；可能为空串（runtime 不指定）。 */
  defaultMode: string;
  /** Shift+Tab 的循环顺序；空 = 同 allowedModes 顺序。 */
  order: string[];
  /** 轮次进行中能不能切（codex 不能）。 */
  switchableDuringTurn: boolean;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * 解 `runtime.capabilities` 的应答。
 *
 * 解不动（对端太老、字段缺失、形状不对）时返回 **null**，而不是一份空的档位集合：
 * 空集合在契约里是「这个后端没有权限门」这句**肯定**的话，界面据此静默地不摆控件；
 * 拿它冒充「此刻问不到」，一台答不上来的机器就会被当成一台本来就没有权限门的机器
 * 悄悄放过，用户连「这里为什么空着」都问不出来。这与 skillCatalog 的
 * normalizeDiscovery 是同一条口径。
 */
export function decodePermissionModeMeta(
  raw: unknown,
): PermissionModeMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const meta = (raw as { permissionMode?: unknown }).permissionMode;
  // 这一格是 optional message：对端没报（太老 / 这条路答不出来）时它压根不在，
  // 那就是「没答」。
  if (typeof meta !== "object" || meta === null) return null;

  const m = meta as Record<string, unknown>;
  // allowedModes 缺席（不是空数组，是根本没这个字段）同样算「没答」：repeated 字段
  // 在 protobuf-es 上恒是数组，缺了说明解错了对象。
  if (!Array.isArray(m.allowedModes)) return null;

  const allowedModes = stringArray(m.allowedModes);
  const order = stringArray(m.order);
  return {
    allowedModes,
    defaultMode: stringValue(m.defaultMode),
    // order 为空时退回 allowedModes 的顺序，与桌面端 nextPermissionMode 的约定一致。
    order: order.length > 0 ? order : allowedModes,
    switchableDuringTurn: m.switchableDuringTurn === true,
  };
}
