/**
 * 「这个后端支持哪几档权限模式」——问执行端本人，不在这一侧按后端类型猜。
 *
 * 此前本站把 claudecode 的四档连同文案写死在详情页的调用点上，别的后端一律给空
 * 数组（于是控件整颗消失）。而 codex 实际有两档：本站既列不出它支持的，也会对别的
 * 后端列出它不支持的。桌面端从来不是这么干的——它读的是 runtime 自己报的能力矩阵。
 *
 * 过线的形状：`runtime.capabilities` 的 `capabilities` 字段是 Go 的
 * `capability.Capabilities` **原样透传**（wire.CapabilitiesResult 的注释写明这一点），
 * 而那个结构体**没有 json tag**，所以字段名就是 Go 的导出名：`Set` 与
 * `PermissionModeMeta.{AllowedModes,DefaultMode,SwitchableDuringTurn,Order}`。
 * 这里照它解，不额外兼容一套小驼峰——多写一套「以防哪天加了 tag」的容错，等于把
 * 一个还没发生的协议变更提前当成事实，真变的那天也不会有人发现这里其实一直在赌。
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
 * 空集合在契约里是「这个后端没有权限门」这句**肯定**的话，拿它冒充「此刻问不到」
 * 会让界面对着一台答不上来的机器说「这个后端没有权限档位」——一句用户无法证伪的
 * 假话。这与 skillCatalog 的 normalizeDiscovery 是同一条口径。
 */
export function decodePermissionModeMeta(
  raw: unknown,
): PermissionModeMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const caps = (raw as { capabilities?: unknown }).capabilities;
  if (typeof caps !== "object" || caps === null) return null;
  const meta = (caps as { PermissionModeMeta?: unknown }).PermissionModeMeta;
  if (typeof meta !== "object" || meta === null) return null;

  const m = meta as Record<string, unknown>;
  // AllowedModes 缺席（不是空数组，是根本没这个字段）同样算「没答」：这个字段是
  // 每个 runtime 都会报的，缺了说明解错了对象。
  if (!Array.isArray(m.AllowedModes)) return null;

  const allowedModes = stringArray(m.AllowedModes);
  const order = stringArray(m.Order);
  return {
    allowedModes,
    defaultMode: stringValue(m.DefaultMode),
    // order 为空时退回 allowedModes 的顺序，与桌面端 nextPermissionMode 的约定一致。
    order: order.length > 0 ? order : allowedModes,
    switchableDuringTurn: m.SwitchableDuringTurn === true,
  };
}
