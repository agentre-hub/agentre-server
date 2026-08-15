/**
 * R15 / R16 的派发逻辑单测（测试接缝 8 的 web 侧）：
 *   - R15d 守卫：从 web 派发时跳过 device_id 为空的「本机」档，只在 agentred 里按
 *     顺序取第一档可用的；全部不可用时返回 null（前端逐档渲染原因，不静默失败）。
 *   - R16：runtime.run 成功后立刻把自己这条关注上（账号级名单），于是新对话不经
 *     「关注」就出现在「对话」页。
 *   - R17：派发的 RunParams 不注入 mcpServers —— org / subagent / hook 用不了这件事
 *     在发起前由界面说明，逻辑层不注入这三个内置工具。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { RelayClient } from "@/lib/relayClient";
import {
  deriveTitle,
  dispatchNewConversation,
  fetchDispatchPlan,
  newSessionId,
  pickFirstAvailable,
  type DispatchPlan,
} from "@/lib/dispatch";
import { callerClientId } from "@/lib/execOrder";
import { MethodRun } from "@/lib/wire";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/relayClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClient")>();
  return { ...actual, RelayClient: vi.fn() };
});
vi.mock("@/lib/relayTicket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayTicket")>();
  return { ...actual, browserDisplayName: () => "Chrome · macOS" };
});
vi.mock("@/lib/execOrder", () => ({ callerClientId: vi.fn() }));

const mockedApi = vi.mocked(api);
const MockRelayClient = vi.mocked(RelayClient);
const mockCallerDeviceFingerprint = vi.mocked(callerClientId);

const availablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "skipped_for_web", current: false },
    {
      rank: 2,
      device_id: 20,
      device_name: "书房小主机",
      backend_type: "claudecode",
      availability: "offline",
      current: false,
    },
    {
      rank: 3,
      device_id: 21,
      device_name: "公司 Mac mini",
      backend_type: "codex",
      kind: "agentred",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-online",
    device_id: 21,
    device_name: "公司 Mac mini",
    backend_type: "codex",
    kind: "agentred",
    cwd: "/srv/agentre-server",
  },
  projects: [],
};

// R17：第一档可用的是桌面端时，派发计划选中它（kind=desktop），发起前界面据此
// 说明 org/subagent/hook 可用（见 NewConversationDialog）。逻辑层照常用 runtime.run
// 把对话建到那台桌面端上，不注入 mcpServers。
const desktopPlan: DispatchPlan = {
  ...availablePlan,
  tiers: [
    {
      rank: 1,
      device_id: 30,
      device_name: "家里 Mac mini",
      backend_type: "claudecode",
      kind: "desktop",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-desk",
    device_id: 30,
    device_name: "家里 Mac mini",
    backend_type: "claudecode",
    kind: "desktop",
    cwd: "/Users/wyz/agentre-server",
  },
};

const allUnavailablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "skipped_for_web", current: false },
    { rank: 2, availability: "unpaired", current: false },
    {
      rank: 3,
      device_id: 20,
      device_name: "书房小主机",
      availability: "offline",
      current: false,
    },
    {
      rank: 4,
      device_id: 21,
      device_name: "公司 Mac mini",
      availability: "project_path_missing",
      current: false,
    },
  ],
  chosen: null,
  projects: [],
};

function fakeClient() {
  return {
    connect: vi.fn(async () => {}),
    request: vi.fn(async (_method: string, _params?: unknown) => ({
      sessionId: 9001,
    })),
    close: vi.fn(),
  };
}

const sourceClient = {
  clientId: "fp-web",
  clientName: "Chrome · macOS",
  accessToken: "web-jwt",
};

beforeEach(() => {
  vi.clearAllMocks();
  MockRelayClient.mockImplementation((() => fakeClient()) as never);
});

describe("pickFirstAvailable（R15d 守卫）", () => {
  it("跳过 device_id 为空的档，只在 agentred 里按顺序取第一档可用的", () => {
    const got = pickFirstAvailable(availablePlan.tiers);
    expect(got?.device_name).toBe("公司 Mac mini");
    expect(got?.availability).toBe("available");
  });

  it("全部不可用时返回 null（逐档原因交给界面渲染，不静默失败）", () => {
    expect(pickFirstAvailable(allUnavailablePlan.tiers)).toBeNull();
  });

  it("本机档排在最前也不参与挑选（守卫断言：锁住块 1 R15d 在浏览器语境下的行为）", () => {
    const got = pickFirstAvailable([
      { rank: 1, availability: "skipped_for_web", current: false },
      {
        rank: 2,
        device_id: 5,
        device_name: "书房 Mac mini",
        availability: "available",
        current: true,
      },
    ]);
    expect(got?.device_id).toBe(5);
  });
});

describe("标题与本地会话标识", () => {
  it("从首条消息派生标题（首行 + 截断）", () => {
    expect(deriveTitle("  讲讲这个项目  \n第二行")).toBe("讲讲这个项目");
    expect(deriveTitle("x".repeat(80)).length).toBeLessThanOrEqual(61);
  });

  it("生成非零正整数会话标识（wire sessionId 语义）", () => {
    for (let i = 0; i < 20; i++) {
      const id = newSessionId();
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });
});

describe("dispatchNewConversation（R15 派发 + R16 自关注）", () => {
  it("向选中的 agentred 发 runtime.run，随后立刻把自己这条关注上（R16）", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation((() => client) as never);

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "讲讲这个项目",
      sourceClient,
    });

    // 连的是选中那一档（设备指纹在 URL 里，JWT 走 Authorization 头）。
    const constructorOpts = MockRelayClient.mock.calls[0][0] as {
      url: string;
      jwt: string;
      reconnect: boolean;
    };
    expect(constructorOpts.url).toContain("fp-online");
    expect(constructorOpts.url).toContain("web-jwt");
    expect(constructorOpts.jwt).toBe("web-jwt");
    // 一次性派发，不自动重连。
    expect(constructorOpts.reconnect).toBe(false);

    const [method, params] = client.request.mock.calls[0];
    const p = params as Record<string, unknown>;
    expect(method).toBe(MethodRun);
    expect(p.sessionId).toBeGreaterThan(0);
    expect(p.agentSyncId).toBe("agent-1");
    expect(p.cwd).toBe("/srv/agentre-server");
    expect(p.userText).toBe("讲讲这个项目");
    expect(p.title).toBe("讲讲这个项目");
    expect(p.backend).toEqual({ type: "codex" });
    expect(p.sourceDevice).toBe("fp-web");
    expect(p.sourceDeviceName).toBe("Chrome · macOS");
    // R17：不注入 mcpServers —— org / subagent / hook 用不了。
    expect(p.mcpServers).toBeUndefined();

    // R16：run 成功后立刻 POST /v1/follows，让这条不经「关注」就出现在「对话」页。
    expect(mockedApi).toHaveBeenCalledWith("/v1/follows", {
      method: "POST",
      body: JSON.stringify({
        device_fingerprint: "fp-online",
        session_id: "9001",
      }),
    });

    expect(out).toEqual({
      sessionId: 9001,
      deviceId: 21,
      deviceFingerprint: "fp-online",
    });
    expect(client.close).toHaveBeenCalled();
  });

  it("全部档不可用时直接抛错，不发任何中继帧", async () => {
    await expect(
      dispatchNewConversation({
        plan: allUnavailablePlan,
        message: "hi",
        sourceClient,
      }),
    ).rejects.toThrow("no available exec target");
    expect(MockRelayClient).not.toHaveBeenCalled();
    expect(mockedApi).not.toHaveBeenCalled();
  });

  // R17：目标是桌面端时，同一套 runtime.run 把对话建到那台桌面端上——带着第一句、
  // 发起方身份与那台机器上的项目路径；不注入 mcpServers（org/subagent/hook 是桌面端
  // 本机内置工具，可用性由发起前的界面按 kind=desktop 如实说明，不由浏览器注入）。
  it("目标是桌面端时向桌面端发 runtime.run 建会话（不注入 mcpServers）", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation((() => client) as never);

    const out = await dispatchNewConversation({
      plan: desktopPlan,
      message: "帮我看看这个项目",
      sourceClient,
    });

    const constructorOpts = MockRelayClient.mock.calls[0][0] as {
      url: string;
      jwt: string;
      reconnect: boolean;
    };
    expect(constructorOpts.url).toContain("fp-desk");
    expect(constructorOpts.jwt).toBe("web-jwt");
    expect(constructorOpts.reconnect).toBe(false);

    const [method, params] = client.request.mock.calls[0];
    const p = params as Record<string, unknown>;
    expect(method).toBe(MethodRun);
    expect(p.sessionId).toBeGreaterThan(0);
    expect(p.agentSyncId).toBe("agent-1");
    expect(p.cwd).toBe("/Users/wyz/agentre-server");
    expect(p.userText).toBe("帮我看看这个项目");
    expect(p.title).toBe("帮我看看这个项目");
    expect(p.backend).toEqual({ type: "claudecode" });
    expect(p.sourceDevice).toBe("fp-web");
    expect(p.sourceDeviceName).toBe("Chrome · macOS");
    expect(p.mcpServers).toBeUndefined();

    // R16：桌面端建会话成功后同样立刻关注自己这条。
    expect(mockedApi).toHaveBeenCalledWith("/v1/follows", {
      method: "POST",
      body: JSON.stringify({
        device_fingerprint: "fp-desk",
        session_id: "9001",
      }),
    });

    expect(out).toEqual({
      sessionId: 9001,
      deviceId: 30,
      deviceFingerprint: "fp-desk",
    });
    expect(client.close).toHaveBeenCalled();
  });

  // R16 的自关注是**派发成功之后**的收尾动作:runtime.run 一旦返回 ack,那台机器上
  // 就已经真真切切多了一条会话。此时把关注写失败(网络抖动 / server 500)报成派发
  // 失败,界面会说「联系不上这台机器,请重试」——用户一重试就凭空又开一条真会话,
  // 而第一条还留在机器上跑。关注写不进去只是这条不会自动出现在「对话」页,不该
  // 把已经成功的派发说成失败。
  it("自关注写失败不把已经成功的派发报成失败(否则重试会开出第二条真会话)", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation((() => client) as never);
    mockedApi.mockRejectedValue(new Error("follows unavailable"));

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "讲讲这个项目",
      sourceClient,
    });

    expect(client.request).toHaveBeenCalled();
    expect(out).toEqual({
      sessionId: 9001,
      deviceId: 21,
      deviceFingerprint: "fp-online",
    });
    expect(client.close).toHaveBeenCalled();
  });

  it("连接失败时抛错并释放连接，不静默", async () => {
    const client = fakeClient();
    client.connect.mockRejectedValue(new Error("connect refused"));
    MockRelayClient.mockImplementation((() => client) as never);

    await expect(
      dispatchNewConversation({
        plan: availablePlan,
        message: "hi",
        sourceClient,
      }),
    ).rejects.toThrow("connect refused");
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });
});

// 派发计划按**调用方设备自己的**排列解析：浏览器取计划时带上自己的指纹，
// 服务端据此重排执行目标链再走「取第一个可用」，Chosen 与逐档原因随之改变。
// 取不到设备身份时照常取计划（回落账号顺序，不报错）——派发不该因为一个偏好
// 读不到就失败，也不该为了凑一个指纹先把这台浏览器注册成一台设备。
describe("fetchDispatchPlan（按调用方设备的顺序解析）", () => {
  it("带上这台浏览器的设备指纹", async () => {
    mockCallerDeviceFingerprint.mockReturnValue(sourceClient.clientId);
    mockedApi.mockResolvedValue(availablePlan);

    const plan = await fetchDispatchPlan("agent-1", "proj-1");

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1&project_sync_id=proj-1&client_id=fp-web",
    );
    expect(plan).toBe(availablePlan);
  });

  it("这台浏览器还没有设备身份时照常取计划，不带指纹、也不注册一台", async () => {
    mockCallerDeviceFingerprint.mockReturnValue(null);
    mockedApi.mockResolvedValue(availablePlan);

    await fetchDispatchPlan("agent-1");

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1",
    );
  });
});
