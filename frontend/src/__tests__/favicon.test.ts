import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * 控制台标签页的图标和桌面端是同一份 Agentre 标记：由共享包持有，这里只引用，不留副本。
 */
describe("console favicon", () => {
  it("Given the console index.html, When a browser tab loads it, Then the favicon is the shared Agentre mark", () => {
    const html = fs.readFileSync(
      path.join(FRONTEND_ROOT, "index.html"),
      "utf8",
    );
    const href =
      html.match(
        /<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/,
      )?.[1] ?? "";

    expect(href).toBe(
      "/node_modules/@agentre-hub/agentre-ui/src/engine/assets/images/logo-mark.svg",
    );
    // vite 按项目根解析这条绝对路径并打进 dist；文件不在，构建出来就是一个断链图标。
    expect(fs.existsSync(path.join(FRONTEND_ROOT, href))).toBe(true);
  });
});
