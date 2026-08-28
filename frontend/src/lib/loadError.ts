/**
 * 一次读失败该给用户看什么。
 *
 * 只有 ApiError 才带可展示的服务端文案；其余(代理返回非 JSON 的 502 → SyntaxError、
 * 离线 → TypeError)同样是失败，必须说出来 —— 静默吞掉会让页面渲染成「还没有任何
 * 设备」，而用户名下的设备一台没少。
 *
 * `fallbackKey` 是调用方那一页自己的兜底文案键：同一套判断，各页说各页的话。
 */
import { ApiError } from "@/lib/api";

export function loadErrorText(
  e: unknown,
  t: (key: string) => string,
  fallbackKey: string,
): string {
  return e instanceof ApiError ? e.message : t(fallbackKey);
}
