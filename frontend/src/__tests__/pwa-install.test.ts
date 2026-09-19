import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 安装性契约守卫。
 *
 * manifest 与 index.html 的头部是「安装入口」这件事的全部实现，但它们都不经过
 * 任何构建期类型检查：改错一个键、引一张不存在的图，肉眼看上去和正确的一模一样，
 * 浏览器只是在后台把「添加到主屏幕」悄悄拿掉。这条守卫读真实文件，把安装所必需的
 * 那几项钉死：
 *
 * - name / short_name / start_url / display 在允许集合里；
 * - 192 与 512 图标都存在，且 src 指向的 PNG 真的在磁盘上；
 * - 没有 prefer_related_applications（它会改变安装语义）；
 * - index.html 里 manifest / apple-touch-icon / theme-color / viewport-fit 都在；
 * - 没有 user-scalable=no / maximum-scale —— 禁止缩放是这一层明确不要的东西。
 *
 * 文件名与语义的细节见 docs/design.md 的 PWA 小节。真正的浏览器安装行为（尤其
 * iOS 的「添加到主屏幕」）没有任何 jsdom 用例能覆盖，只能上真机。
 */
const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const readFrontendFile = (relative: string) =>
  fs.readFileSync(path.join(FRONTEND_ROOT, relative), "utf8");

const manifest = JSON.parse(
  readFrontendFile("public/manifest.webmanifest"),
) as {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: { src?: string; sizes?: string; type?: string; purpose?: string }[];
  prefer_related_applications?: boolean;
};

const indexHtml = readFrontendFile("index.html");

const ALLOWED_DISPLAY = ["standalone", "fullscreen", "minimal-ui", "browser"];
const ALLOWED_START_URL = ["/", "./", "/index.html"];

describe("PWA 安装契约", () => {
  it("name 与 short_name 是同一份可读的品牌名", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(typeof manifest.name).toBe("string");
    expect(typeof manifest.short_name).toBe("string");
  });

  it("start_url 与 display 落在允许集合里", () => {
    expect(ALLOWED_START_URL).toContain(manifest.start_url);
    expect(ALLOWED_DISPLAY).toContain(manifest.display);
  });

  it("同时有 192 与 512 的 any 与 maskable 图标，且文件真实存在", () => {
    const icons = manifest.icons ?? [];
    const find = (sizes: string, purpose: string) =>
      icons.find((icon) => icon.sizes === sizes && icon.purpose === purpose);

    for (const [sizes, purpose] of [
      ["192x192", "any"],
      ["512x512", "any"],
      ["192x192", "maskable"],
      ["512x512", "maskable"],
    ] as const) {
      const icon = find(sizes, purpose);
      expect(icon, `manifest 缺少 ${sizes} 的 ${purpose} 图标`).toBeTruthy();
      expect(icon?.type).toBe("image/png");
      expect(icon?.src?.startsWith("/")).toBe(true);
      const onDisk = path.join(
        FRONTEND_ROOT,
        "public",
        icon!.src!.replace(/^\//, ""),
      );
      expect(
        fs.existsSync(onDisk),
        `${icon?.src} 在磁盘上不存在：${onDisk}`,
      ).toBe(true);
    }
  });

  it("不声明 prefer_related_applications", () => {
    expect(manifest).not.toHaveProperty("prefer_related_applications");
  });

  it("index.html 声明了 manifest 与 apple-touch-icon", () => {
    expect(indexHtml).toMatch(
      /<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"/,
    );
    expect(indexHtml).toMatch(
      /<link[^>]*rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon-180\.png"/,
    );
  });

  it("index.html 为深浅两色各给一条 theme-color", () => {
    expect(indexHtml).toMatch(
      /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme: light\)"[^>]*content="#fafafa"/,
    );
    expect(indexHtml).toMatch(
      /<meta[^>]*name="theme-color"[^>]*media="\(prefers-color-scheme: dark\)"[^>]*content="#18191b"/,
    );
  });

  it("viewport 带 viewport-fit=cover 好让安全区变量有值", () => {
    const viewport = indexHtml.match(
      /<meta[^>]*name="viewport"[^>]*content="([^"]*)"/,
    );
    expect(viewport).toBeTruthy();
    expect(viewport![1]).toContain("viewport-fit=cover");
  });

  it("从不禁止缩放：没有 user-scalable=no，也没有 maximum-scale", () => {
    expect(indexHtml).not.toContain("user-scalable=no");
    expect(indexHtml).not.toContain("maximum-scale");
  });
});
