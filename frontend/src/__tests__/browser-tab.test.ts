import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * 控制台标签页的身份：图标是共享包持有的那枚满版瓦片，这里只引用，不留副本；标题里的
 * 产品名跟桌面端 productName 同一个写法。
 *
 * 用瓦片而不是同目录的裸 mark logo-mark.svg：后者 33/480 的描边落到 16px 标签页上只
 * 剩约 1px，还是浅蓝渐变，白底几乎看不见；瓦片的深底板能把轮廓兜住。裸 mark 留给顶栏
 * 和引擎面板那些已经有背景的位置。
 */
describe("console browser tab", () => {
  it("Given the console index.html, When a browser tab loads it, Then the favicon is the shared Agentre tile", () => {
    const html = fs.readFileSync(
      path.join(FRONTEND_ROOT, "index.html"),
      "utf8",
    );
    const href =
      html.match(
        /<link rel="icon" type="image\/svg\+xml" href="([^"]+)"/,
      )?.[1] ?? "";

    expect(href).toBe(
      "/node_modules/@agentre-hub/agentre-ui/src/engine/assets/images/logo-tile.svg",
    );
    // vite 按项目根解析这条绝对路径并打进 dist；文件不在，构建出来就是一个断链图标。
    expect(fs.existsSync(path.join(FRONTEND_ROOT, href))).toBe(true);
  });

  it("Given the console index.html, When a browser tab shows its title, Then the product name is written Agentre", () => {
    const html = fs.readFileSync(
      path.join(FRONTEND_ROOT, "index.html"),
      "utf8",
    );

    expect(html).toContain("<title>Agentre Server</title>");
  });
});
