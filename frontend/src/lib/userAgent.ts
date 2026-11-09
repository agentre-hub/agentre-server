/**
 * 把 User-Agent 猜成「设备 · 浏览器」，只用于登录记录的显示。
 *
 * 猜错只影响显示：页面上的撤销动作是「登出其它全部」，不针对单条，当前会话由服务端
 * 的 `current` 标出而不是靠这里解析（规格决策 13）。认不出来时返回 null，调用方回退
 * 到原文截断。
 *
 * 判定顺序有讲究：iPhone 的 UA 里也带 "like Mac OS X"，Android 的 UA 里带 "Linux"，
 * Edge / Chrome 的 UA 里带 "Safari"，所以要先认更具体的那一个。
 */

export interface ParsedUserAgent {
  device: string;
  browser: string;
}

const DEVICES: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/Macintosh|Mac OS X/, "Mac"],
  [/Linux|X11/, "Linux"],
];

const BROWSERS: [RegExp, string][] = [
  [/EdgA\/|EdgiOS\/|Edg\//, "Edge"],
  [/FxiOS\/|Firefox\//, "Firefox"],
  [/CriOS\/|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

function firstMatch(ua: string, table: [RegExp, string][]): string | null {
  for (const [pattern, name] of table) {
    if (pattern.test(ua)) return name;
  }
  return null;
}

export function parseUserAgent(ua: string): ParsedUserAgent | null {
  const device = firstMatch(ua, DEVICES);
  const browser = firstMatch(ua, BROWSERS);
  if (!device || !browser) return null;
  return { device, browser };
}
