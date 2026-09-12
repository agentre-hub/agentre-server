import { describe, expect, it, vi } from "vitest";
import { rpcMethods } from "@agentre-hub/agentre-wire";

import { RelayError } from "@/lib/relayClient";

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

  // 图片是唯一允许传输的二进制：wire 上是**真图片字节**（Go 侧过 proto 时把
  // base64 解回了原始字节），面板要的是 base64，所以这一条路要再编回去。判据与
  // Go 侧同一条：contentType 是 image/*。
  it("图片按 base64 还原，不是拿 UTF-8 解出一串乱码", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const request = vi.fn().mockResolvedValue({
      content: png,
      contentType: "image/png",
    });
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "/srv/work",
    });

    const result = await ports.readFile("assets/logo.png");

    expect(result.content).toBe("iVBORw==");
    expect(result.contentType).toBe("image/png");
  });

  it("二进制标志原样透传，且不拿字节去凑正文", async () => {
    const request = vi.fn().mockResolvedValue({
      content: new Uint8Array(),
      contentType: "",
      binary: true,
    });
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "/srv/work",
    });

    const result = await ports.readFile("a.bin");

    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
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

/**
 * 失败归类（规格 2026-09-08 决策 4）。认的是**错误码**不是文案：message 是那台
 * 机器上的 Go 错误文本，改一个字就把判断打散；错误码是写进 wire 契约的稳定值。
 *
 * 归类只是在 reject 值上贴一个 `kind`，面板据此决定「给不给重试」——「文件不存在」
 * 是终态，给一个点下去必然还是失败的按钮比不给更糟。
 */
describe("读取失败的归类", () => {
  function portsThatFail(err: unknown) {
    return createFilePreviewPorts({
      client: { request: vi.fn().mockRejectedValue(err) } as never,
      cwd: "/srv/work",
    });
  }

  it("那台机器答「文件不存在」(-32043) → 贴成 notFound", async () => {
    const ports = portsThatFail(
      new RelayError(-32043, "workspacefs: not found", null),
    );

    await expect(ports.readFile("ghost.md")).rejects.toMatchObject({
      kind: "notFound",
    });
  });

  it("连接断了(-1) → 贴成 offline，面板据此给重试", async () => {
    const ports = portsThatFail(new RelayError(-1, "relay: 连接未就绪", null));

    await expect(ports.readFile("a.md")).rejects.toMatchObject({
      kind: "offline",
    });
  });

  it("没有 client 时同样算 offline —— 那台机器此刻够不着", async () => {
    const ports = createFilePreviewPorts({ client: null, cwd: "/srv/work" });

    await expect(ports.readFile("a.md")).rejects.toMatchObject({
      kind: "offline",
    });
  });

  // 还不知道工作根时（实况摘要没到 / 刚被清掉）一次请求都不发：空 root 发过去，
  // 那台机器答的是 -32042(workspacefs: no cwd) —— 一个本站认不出的码，面板只能
  // 把那句 Go 原文照抄给用户，再配一颗永远失败的重试。
  it("cwd 还是空的时候不往线上发空 root，按 offline 落定", async () => {
    // 桩成那台机器**真的**会怎么答一个空 root：-32042 是本站认不出的码，落到
    // 面板上就是一句 Go 原文加一颗永远失败的重试。
    const request = vi
      .fn()
      .mockRejectedValue(new RelayError(-32042, "workspacefs: no cwd", null));
    const ports = createFilePreviewPorts({
      client: { request } as never,
      cwd: "",
    });

    await expect(ports.readFile("a.md")).rejects.toMatchObject({
      kind: "offline",
    });
    await expect(ports.gitFileContent("a.md")).rejects.toMatchObject({
      kind: "offline",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("认不出的码不贴标记：如实显示它自己的文案 + 重试，不冒充已知失败", async () => {
    const ports = portsThatFail(new RelayError(-32040, "path refused", null));

    const err = await ports.readFile("../etc/passwd").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { kind?: string }).kind).toBeUndefined();
  });
});

/**
 * 对比档的左列：同一文件在 git HEAD 的版本（规格「取数与失败」）。
 *
 * 「不是 git 仓库」与「不在 HEAD」都不是失败，是**视图事实**：面板据此画空基线，
 * 而不是弹一个错误。把它们当失败会让「新加的文件」看起来像出了故障。
 */
describe("对比档的基线", () => {
  function portsWith(raw: unknown) {
    const request = vi.fn().mockResolvedValue(raw);
    return {
      request,
      ports: createFilePreviewPorts({
        client: { request } as never,
        cwd: "/srv/work",
      }),
    };
  }

  it("发 workspaceFsGitFileContent，并带上实况 cwd", async () => {
    const { request, ports } = portsWith({
      content: new TextEncoder().encode("v1\n"),
      hasHead: true,
    });

    await ports.gitFileContent("src/a.ts");

    expect(request).toHaveBeenCalledWith(rpcMethods.workspaceFsGitFileContent, {
      root: "/srv/work",
      relPath: "src/a.ts",
    });
  });

  it("HEAD 里那一版按 UTF-8 还原", async () => {
    const { ports } = portsWith({
      content: new TextEncoder().encode("旧的一版\n"),
      hasHead: true,
    });

    const result = await ports.gitFileContent("src/a.ts");

    expect(result.content).toBe("旧的一版\n");
    expect(result.hasHead).toBe(true);
  });

  it("不是 git 仓库：交出 notARepo，不报错", async () => {
    const { ports } = portsWith({ content: new Uint8Array(), notARepo: true });

    const result = await ports.gitFileContent("src/a.ts");

    expect(result.notARepo).toBe(true);
    expect(result.content).toBe("");
  });

  it("未跟踪 / 不在 HEAD：空基线（hasHead 为 false），同样不报错", async () => {
    const { ports } = portsWith({ content: new Uint8Array() });

    const result = await ports.gitFileContent("src/new.ts");

    // 断的是「假值」而不是恰好等于 false：包的契约把这两格标成可选，缺席就是
    // 没有基线（proto3 的 omitempty 同一条口径）。钉死表示法只会把一个等价的
    // 实现判红。
    expect(result.hasHead).toBeFalsy();
    expect(result.notARepo).toBeFalsy();
  });

  it("取基线也归类失败：连接断了贴 offline", async () => {
    const ports = createFilePreviewPorts({
      client: {
        request: vi.fn().mockRejectedValue(new RelayError(-1, "断了", null)),
      } as never,
      cwd: "/srv/work",
    });

    await expect(ports.gitFileContent("a.ts")).rejects.toMatchObject({
      kind: "offline",
    });
  });
});
