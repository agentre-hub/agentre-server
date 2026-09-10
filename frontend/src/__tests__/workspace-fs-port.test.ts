import { describe, expect, it, vi } from "vitest";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { createFilePreviewPorts } from "@/lib/filePreviewPorts";

/**
 * 预览面的取数端口在本站这一侧的实现（规格 2026-09-08 「取数与失败」）。
 *
 * 面板本身在共享包里测过了；这里只测**接缝**：中继那条通路翻成
 * `FilePreviewPorts` 时有没有翻对 —— 发的是不是那个方法、带没带上实况 cwd、
 * wire 上的 `bytes` 有没有还原成面板要的字符串。
 */
describe("本站的 FilePreviewPorts", () => {
  it("readFile 发 workspaceFsReadFile，并带上这条会话的实况 cwd", async () => {
    const request = vi.fn().mockResolvedValue({
      content: new TextEncoder().encode("hello\n"),
      contentType: "",
    });
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "/srv/work",
    });

    await ports.readFile("docs/a.md");

    expect(request).toHaveBeenCalledWith(rpcMethods.workspaceFsReadFile, {
      root: "/srv/work",
      relPath: "docs/a.md",
    });
  });

  it("文本正文按 UTF-8 还原成字符串，而不是一串字节下标", async () => {
    const request = vi.fn().mockResolvedValue({
      content: new TextEncoder().encode("你好 world\n"),
      contentType: "",
    });
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "/srv/work",
    });

    const result = await ports.readFile("docs/a.md");

    expect(result.content).toBe("你好 world\n");
  });

  // 面板把这两格当**视图标志**（各出各自的说明、不渲染正文），不是失败；
  // 原样透传，宿主不重新解释。
  it("tooLarge / binary 原样透传", async () => {
    const request = vi.fn().mockResolvedValue({
      content: new Uint8Array(),
      contentType: "",
      tooLarge: true,
    });
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "/srv/work",
    });

    const result = await ports.readFile("big.log");

    expect(result.tooLarge).toBe(true);
    expect(result.content).toBe("");
  });

  // 没有连接就发不出请求：如实交出一个失败，而不是抛一个说不清的 TypeError。
  it("没有 client 时 readFile 失败，而不是静默返回空文件", async () => {
    const ports = createFilePreviewPorts({ client: null, cwd: "/srv/work" });

    await expect(ports.readFile("docs/a.md")).rejects.toThrow();
  });
});
