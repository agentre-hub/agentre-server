import { rpcMethods } from "@agentre-hub/agentre-wire";
/**
 * 技能目录取数（`@/lib/skillCatalog`）：浏览器经中继问**那一档所在的那台机器**
 * 「你上面装了哪些技能包」，替掉此前的「手打 skill id」。
 *
 * 三件事在这一层钉死：
 *   1. 中继按通道寻址 —— 通道必须声明这一档的 `machine:<fingerprint>`，否则拨到的
 *      不是这台机器；请求带的是**调用方报进去的**授权集（agentred 上没有组织
 *      架构库，见 wire 的 rpcMethods.skillCatalog 注释）。
 *   2. `discovery` 三态各自保真：`unavailable` / `unsupported` 都会带回空
 *      `packs`，把它们读成「这台机器没有技能」正是协议注释点名不许的那一步。
 *   3. 认不出的 `discovery` 取值降级成 `unavailable`（「答不出」）而不是 `ok`：
 *      往「问不出来」偏是安全的，往「没有包」偏会让界面撒谎。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RelayClient } from "@/lib/relayClient";
import { ensureRelayTicket } from "@/lib/relayTicket";
import {
  fetchSkillCatalog,
  fetchSkillCommands,
  parseSkillAuthorizations,
  serializeSkillAuthorizations,
  setSkillTriState,
  skillTriState,
} from "@/lib/skillCatalog";
import { relayClientPool } from "@/lib/relayClientPool";

vi.mock("@/lib/relayClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClient")>();
  return { ...actual, RelayClient: vi.fn() };
});
vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, ensureRelayTicket: vi.fn() };
});

const MockRelayClient = vi.mocked(RelayClient);
const mockedTicket = vi.mocked(ensureRelayTicket);

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function stubRelay(result: unknown): FakeClient {
  const fake: FakeClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    request: vi.fn().mockResolvedValue(result),
    close: vi.fn(),
  };
  MockRelayClient.mockImplementation(function () {
    return fake;
  } as never);
  return fake;
}

beforeEach(() => {
  // 中继连接现在是池化的（relayClientPool）：不收掉的话，上一条用例建的那条会被
  // 下一条借走，于是每一条都读到上一条打的桩。
  relayClientPool.closeAll();
  MockRelayClient.mockReset();
  mockedTicket.mockReset();
  mockedTicket.mockResolvedValue({
    accessToken: "ticket-token",
    expiresAt: Date.now() + 120_000,
    peerFingerprint: "browser-1",
    clientName: "Chrome · macOS",
  });
});

describe("fetchSkillCatalog", () => {
  it("拨到这一档所在的那台机器，并把这一档的授权集报进去", async () => {
    const fake = stubRelay({
      packs: [
        {
          id: "agentre/web",
          name: "Web",
          description: "上网找东西",
          skills: ["search", "fetch"],
          installed: true,
          enabled: true,
          globallyEnabled: false,
        },
      ],
      discovery: "ok",
    });

    const got = await fetchSkillCatalog({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [{ id: "agentre/web", enabled: true }],
    });

    const opts = MockRelayClient.mock.calls[0][0];
    // 目标在**通道**上声明（决策 10/11）：技能目录是机器作用域的操作，走 machine:。
    expect(opts.target).toBe("machine:fp-online");
    await expect(opts.credential()).resolves.toBe("ticket-token");
    expect(fake.request).toHaveBeenCalledWith(rpcMethods.skillCatalog, {
      backendType: "claudecode",
      authorized: [{ id: "agentre/web", enabled: true }],
    });
    // 不再由调用方 close：连接归池子，用完只是还回去（withRelayClient 的 release）。
    expect(fake.close).not.toHaveBeenCalled();

    expect(got.discovery).toBe("ok");
    expect(got.packs).toHaveLength(1);
    expect(got.packs[0].skills).toEqual(["search", "fetch"]);
  });

  it("unavailable：空目录不等于「这台机器没有技能」，如实报答不出", async () => {
    stubRelay({ packs: [], discovery: "unavailable" });
    const got = await fetchSkillCatalog({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [],
    });
    expect(got.discovery).toBe("unavailable");
    expect(got.packs).toEqual([]);
  });

  it("unsupported：这类后端根本没有技能这一说，是稳定答案", async () => {
    stubRelay({ packs: [], discovery: "unsupported" });
    const got = await fetchSkillCatalog({
      fingerprint: "fp-online",
      backendType: "builtin",
      authorized: [],
    });
    expect(got.discovery).toBe("unsupported");
  });

  it("认不出的 discovery 取值降级成 unavailable，绝不当成 ok", async () => {
    stubRelay({ packs: [], discovery: "brand-new-state" });
    const got = await fetchSkillCatalog({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [],
    });
    expect(got.discovery).toBe("unavailable");
  });

  it("拨不通就抛（界面据此降级成「列不出可添加的包」），不假装是空目录", async () => {
    const fake: FakeClient = {
      connect: vi.fn().mockRejectedValue(new Error("relay: 连接失败")),
      request: vi.fn(),
      close: vi.fn(),
    };
    MockRelayClient.mockImplementation(function () {
      return fake;
    } as never);
    await expect(
      fetchSkillCatalog({
        fingerprint: "fp-offline",
        backendType: "claudecode",
        authorized: [],
      }),
    ).rejects.toThrow();
    // 连不上那一条**要**关掉：池子当场把这个失败条目摘掉，不留给下一个人捡。
    expect(fake.close).toHaveBeenCalled();
  });

  it("没有指纹的档（本机相对引用）连拨都不拨", async () => {
    await expect(
      fetchSkillCatalog({
        fingerprint: "",
        backendType: "claudecode",
        authorized: [],
      }),
    ).rejects.toThrow();
    expect(MockRelayClient).not.toHaveBeenCalled();
  });
});

describe("三态：继承全局 / 强制开 / 强制关", () => {
  it("授权集里没有这一项 = 继承全局", () => {
    expect(skillTriState([], "agentre/web")).toBe("inherit");
    expect(skillTriState([{ id: "a", enabled: true }], "agentre/web")).toBe(
      "inherit",
    );
  });

  it("显式 enabled 决定强制开还是强制关", () => {
    const authorized = [
      { id: "a", enabled: true },
      { id: "b", enabled: false },
    ];
    expect(skillTriState(authorized, "a")).toBe("on");
    expect(skillTriState(authorized, "b")).toBe("off");
  });

  it("切回「继承」是把这一项从授权集里拿掉，而不是写一条 enabled:false", () => {
    const authorized = [{ id: "a", enabled: true }];
    expect(setSkillTriState(authorized, "a", "inherit")).toEqual([]);
    expect(setSkillTriState(authorized, "a", "off")).toEqual([
      { id: "a", enabled: false },
    ]);
    expect(setSkillTriState([], "b", "on")).toEqual([
      { id: "b", enabled: true },
    ]);
  });

  it("解析容错：不是数组 / 解不动的 JSON 都当空授权，不炸掉整个详情", () => {
    expect(parseSkillAuthorizations(undefined)).toEqual([]);
    expect(parseSkillAuthorizations("not json")).toEqual([]);
    expect(parseSkillAuthorizations(`{"granted":[]}`)).toEqual([]);
    expect(parseSkillAuthorizations(`[{"id":"a","enabled":true}]`)).toEqual([
      { id: "a", enabled: true },
    ]);
    expect(serializeSkillAuthorizations([{ id: "a", enabled: false }])).toBe(
      `[{"id":"a","enabled":false}]`,
    );
  });
});

/**
 * 命令清单取数（`fetchSkillCommands`）：与目录同一条中继、同一套三态判别，问的却是
 * 另一件事 —— **输入框里打得出来的名字**。
 *
 * 它与 `fetchSkillCatalog` 的差别只有两处，两处都有理由：
 *   1. 多带一个 `cwd` —— 项目级 skill（`<cwd>/.claude/skills`）只在那个目录下才解析
 *      得出来，而「这一轮在哪跑」是会话的事实，那台机器不该去猜。
 *   2. 回的是命令而不是包 —— 包只是它的一半，另一半（CLI 自己解析的 user /
 *      project / system skill）配不了、也不在授权表里，却恰恰是日常打得最多的。
 */
describe("fetchSkillCommands", () => {
  it("拨到这一档所在的那台机器，带上授权集与这一轮的 cwd", async () => {
    const fake = stubRelay({
      commands: [
        { name: "superpowers:brainstorming", description: "先想清楚" },
        { name: "cago" },
      ],
      discovery: "ok",
    });

    const got = await fetchSkillCommands({
      fingerprint: "fp-online",
      backendType: "claudecode",
      cwd: "/srv/project",
      authorized: [{ id: "agentre/web", enabled: true }],
    });

    expect(MockRelayClient.mock.calls[0][0].target).toBe("machine:fp-online");
    expect(fake.request).toHaveBeenCalledWith(rpcMethods.skillCommands, {
      backendType: "claudecode",
      cwd: "/srv/project",
      authorized: [{ id: "agentre/web", enabled: true }],
    });

    expect(got.discovery).toBe("ok");
    expect(got.commands).toEqual([
      { name: "superpowers:brainstorming", description: "先想清楚" },
      // 描述可以为空：CLI 原生解析出来的 skill 常常只有一个裸名字。
      { name: "cago", description: undefined },
    ]);
  });

  it("unavailable：空清单不等于「这台机器没有 skill」", async () => {
    stubRelay({ commands: [], discovery: "unavailable" });
    const got = await fetchSkillCommands({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [],
    });
    expect(got.discovery).toBe("unavailable");
    expect(got.commands).toEqual([]);
  });

  it("认不出的判别值一律降级成「答不出」，不冒充 ok", async () => {
    stubRelay({ commands: [], discovery: "who-knows" });
    const got = await fetchSkillCommands({
      fingerprint: "fp-online",
      backendType: "claudecode",
      authorized: [],
    });
    expect(got.discovery).toBe("unavailable");
  });

  it("没有可拨的机器时不发出一次注定失败的连接", async () => {
    stubRelay({ commands: [], discovery: "ok" });
    await expect(
      fetchSkillCommands({
        fingerprint: "",
        backendType: "claudecode",
        authorized: [],
      }),
    ).rejects.toThrow();
    expect(MockRelayClient).not.toHaveBeenCalled();
  });
});
