/**
 * device_kind → 展示名。
 *
 * 三处要同一套规则：确认屏（DeviceApproval）、成功屏（DeviceSuccess）、
 * 设备列表（Devices）。各写一份的下场是「同一个 kind 在三屏上叫三个名字」，
 * 或者其中一处忘了兜底、把 `device.kind.foo` 这串死键名摆到用户脸上。
 *
 * t 的类型写成 `(key: string) => string` 而不是 i18next 的 TFunction：
 * 这里查的是运行期拼出来的动态键，与 loadErrorText 同一手法。
 */
export function deviceKindLabel(
  kind: string,
  t: (key: string) => string,
): string {
  const key = `device.kind.${kind}`;
  const translated = t(key);
  // i18next 查不到时把键原样返回，此时回退到后端给的原文。
  return translated === key ? kind : translated;
}

/**
 * device_kind → 设备行图标（Pencil 设备页 R1 的 lucide 图标语义）。
 *
 * 桌面/移动设备行都要画同一个 kind 的同一枚图标，集中在这里避免两处漂移。
 * 装饰图标一律 aria-hidden（accessibility：不制造重复朗读）。
 *
 * DEVICE_KIND_ICONS 是模块级常量：页面用 `<DEVICE_KIND_ICONS[kind] ?? Cpu>`
 * 的成员表达式取图标，避免在渲染期“创建”组件（react-hooks/static-components）。
 */
import { Cpu, Laptop, Server, Smartphone } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const DEVICE_KIND_ICONS: Record<string, LucideIcon> = {
  agentred: Server,
  desktop: Laptop,
  mobile: Smartphone,
};

export function deviceKindIcon(kind: string): LucideIcon {
  return DEVICE_KIND_ICONS[kind] ?? Cpu;
}
