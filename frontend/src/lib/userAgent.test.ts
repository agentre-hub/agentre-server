import { describe, expect, it } from "vitest";

import { parseUserAgent } from "@/lib/userAgent";

/**
 * 登录记录的「设备 · 浏览器」只是显示用的猜测：解析不出来时返回 null，调用方回退到
 * 原文。用例取自真实浏览器的 UA 形态，覆盖 iPhone / iPad / Android / Mac / Windows /
 * Linux 与 Safari / Chrome / Edge / Firefox 的组合。
 */
describe("parseUserAgent", () => {
  const cases: [string, string, { device: string; browser: string }][] = [
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      { device: "iPhone", browser: "Safari" },
    ],
    [
      "iPhone Chrome (CriOS)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1",
      { device: "iPhone", browser: "Chrome" },
    ],
    [
      "iPhone Firefox (FxiOS)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15",
      { device: "iPhone", browser: "Firefox" },
    ],
    [
      "iPad Safari",
      "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      { device: "iPad", browser: "Safari" },
    ],
    [
      "Android Chrome",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      { device: "Android", browser: "Chrome" },
    ],
    [
      "Android Edge (EdgA)",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0",
      { device: "Android", browser: "Edge" },
    ],
    [
      "Mac Chrome",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      { device: "Mac", browser: "Chrome" },
    ],
    [
      "Mac Safari",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
      { device: "Mac", browser: "Safari" },
    ],
    [
      "Mac Edge",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      { device: "Mac", browser: "Edge" },
    ],
    [
      "Mac Firefox",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0",
      { device: "Mac", browser: "Firefox" },
    ],
    [
      "Windows Chrome",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      { device: "Windows", browser: "Chrome" },
    ],
    [
      "Windows Edge",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      { device: "Windows", browser: "Edge" },
    ],
    [
      "Windows Firefox",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0",
      { device: "Windows", browser: "Firefox" },
    ],
    [
      "Linux Chrome",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      { device: "Linux", browser: "Chrome" },
    ],
    [
      "Linux Firefox",
      "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0",
      { device: "Linux", browser: "Firefox" },
    ],
  ];

  it.each(cases)("names %s as device · browser", (_name, ua, expected) => {
    expect(parseUserAgent(ua)).toEqual(expected);
  });

  it("returns null for a UA it cannot name, so the caller shows the raw string", () => {
    expect(parseUserAgent("curl/8.4.0")).toBeNull();
  });

  it("returns null for an empty UA", () => {
    expect(parseUserAgent("")).toBeNull();
  });
});
