import { rpcMethods } from "@agentre-hub/agentre-wire";
/**
 * R15 / R16 的派发逻辑单测（测试接缝 8 的 web 侧）：
 *   - R15d 守卫：从 web 派发时跳过 device_id 为空的「本机」档，只在 agentred 里按
 *     顺序取第一档可用的；全部不可用时返回 null（前端逐档渲染原因，不静默失败）。
 *   - R16：runtime.run 成功后立刻把这条对话保存进账号（POST /v1/saved-sessions），
 *     于是新对话不经手动保存就出现在「对话」页——发起即保存（2026-08-18-server-
 *     session-mirror 决策 2），镜像随即对它开始。
 *   - R17：派发的 RunParams 不注入 mcpServers —— org / subagent / hook 用不了这件事
 *     在发起前由界面说明，逻辑层不注入这三个内置工具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "@/lib/api";
import { RelayClient, RelayError } from "@/lib/relayClient";
import {
  DispatchConnectionError,
  DispatchRunError,
  deriveTitle,
  dispatchNewConversation,
  fetchDispatchPlan,
  newSessionId,
  pickFirstAvailable,
  type DispatchPlan,
} from "@/lib/dispatch";

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

const mockedApi = vi.mocked(api);
const MockRelayClient = vi.mocked(RelayClient);

const availablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "no_device", current: false },
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
// 说明 org/subagent/hook 可用（见 newconv/DraftSession）。逻辑层照常用 runtime.run
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

const agentredPiPlan: DispatchPlan = {
  ...availablePlan,
  tiers: [
    {
      rank: 1,
      device_id: 40,
      device_name: "Pi 主机",
      backend_type: "piagent",
      kind: "agentred",
      availability: "available",
      current: true,
    },
  ],
  chosen: {
    device_fingerprint: "fp-pi",
    device_id: 40,
    device_name: "Pi 主机",
    backend_type: "piagent",
    kind: "agentred",
    cwd: "/srv/pi-project",
  },
};

const allUnavailablePlan: DispatchPlan = {
  agent_sync_id: "agent-1",
  tiers: [
    { rank: 1, availability: "no_device", current: false },
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
    request: vi.fn(
      async (_method: unknown, _params?: unknown): Promise<unknown> => ({
        sessionId: 9001,
      }),
    ),
    close: vi.fn(),
  };
}

const sourceClient = {
  clientId: "fp-web",
  clientName: "Chrome · macOS",
  accessToken: "web-jwt",
};

// RelayClient 是被 `new` 出来的。vitest 4 起，mock 收到构造调用会直接
// `Reflect.construct(impl)`，箭头函数不可构造（TypeError: ... is not a constructor），
// 所以假实现必须写成普通函数——构造调用返回对象即覆盖 this，拿到的还是这个假 client。
beforeEach(() => {
  vi.clearAllMocks();
  MockRelayClient.mockImplementation(function () {
    return fakeClient();
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
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
      { rank: 1, availability: "no_device", current: false },
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

describe("dispatchNewConversation（R15 派发 + R16 发起即保存）", () => {
  it("接受真实 Protobuf RPC 返回的 bigint 会话标识", async () => {
    const client = fakeClient();
    client.request.mockResolvedValueOnce({ sessionId: 9001n });
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "真实协议 ACK",
      sourceClient,
    });

    expect(out.sessionId).toBe(9001);
    expect(mockedApi).toHaveBeenCalledWith("/v1/saved-sessions", {
      method: "POST",
      body: expect.stringContaining('"session_id":"9001"'),
    });
  });

  it("向选中的 agentred 发 runtime.run，随后立刻把这条对话保存进账号（R16）", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

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
    expect(method).toBe(rpcMethods.runtimeRun);
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

    // R16：run 成功后立刻 POST /v1/saved-sessions，让这条对话保存进账号（发起即保存）。
    //
    // 身份的两半分开报：承载它的是那台 agentred，发起它的是这个浏览器。合成一个
    // 值的话这条对话在镜像里永远匹配不上 —— 账号里保存了，左栏却一行都没有。
    expect(mockedApi).toHaveBeenCalledWith("/v1/saved-sessions", {
      method: "POST",
      body: JSON.stringify({
        machine_fingerprint: "fp-online",
        peer_fingerprint: "fp-web",
        session_id: "9001",
      }),
    });

    expect(out).toEqual({
      sessionId: 9001,
      deviceId: 21,
      deviceFingerprint: "fp-online",
      // 交出去的必须是这条对话的**发起端**——就是这个浏览器。落地那一屏拿它去问
      // 镜像的历史与「已读」；给成机器指纹的话两处都在问一个账号里不存在的身份。
      peerFingerprint: "fp-web",
      // 跟随 Agent 绑定：没什么可钉，恒为真。
      modelPinned: true,
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
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

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
    expect(method).toBe(rpcMethods.runtimeRun);
    expect(p.sessionId).toBeGreaterThan(0);
    expect(p.agentSyncId).toBe("agent-1");
    expect(p.cwd).toBe("/Users/wyz/agentre-server");
    expect(p.userText).toBe("帮我看看这个项目");
    expect(p.title).toBe("帮我看看这个项目");
    expect(p.backend).toEqual({ type: "claudecode" });
    expect(p.sourceDevice).toBe("fp-web");
    expect(p.sourceDeviceName).toBe("Chrome · macOS");
    expect(p.mcpServers).toBeUndefined();

    // R16：桌面端建会话成功后同样立刻把这条保存进账号。目标换成桌面端不改变这件事：
    // 发起端仍是这个浏览器，承载它的是那台桌面机。
    expect(mockedApi).toHaveBeenCalledWith("/v1/saved-sessions", {
      method: "POST",
      body: JSON.stringify({
        machine_fingerprint: "fp-desk",
        peer_fingerprint: "fp-web",
        session_id: "9001",
      }),
    });

    expect(out).toEqual({
      sessionId: 9001,
      deviceId: 30,
      deviceFingerprint: "fp-desk",
      peerFingerprint: "fp-web",
      // 跟随 Agent 绑定：没什么可钉，恒为真。
      modelPinned: true,
    });
    expect(client.close).toHaveBeenCalled();
  });

  // R16 的发起即保存是**派发成功之后**的收尾动作:runtime.run 一旦返回 ack,那台机器上
  // 就已经真真切切多了一条会话。此时把保存写失败(网络抖动 / server 500)报成派发
  // 失败,界面会说「联系不上这台机器,请重试」——用户一重试就凭空又开一条真会话,
  // 而第一条还留在机器上跑。保存写不进去只是这条不会自动出现在「对话」页,不该
  // 把已经成功的派发说成失败。
  it("保存写失败不把已经成功的派发报成失败(否则重试会开出第二条真会话)", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);
    mockedApi.mockRejectedValue(new Error("saved-sessions unavailable"));

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
      peerFingerprint: "fp-web",
      // 跟随 Agent 绑定：没什么可钉，恒为真。
      modelPinned: true,
    });
    expect(client.close).toHaveBeenCalled();
  });

  it("连接失败时抛错并释放连接，不静默", async () => {
    const client = fakeClient();
    client.connect.mockRejectedValue(new Error("connect refused"));
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    await expect(
      dispatchNewConversation({
        plan: availablePlan,
        message: "hi",
        sourceClient,
      }),
    ).rejects.toEqual(expect.any(DispatchConnectionError));
    expect(client.request).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("连接成功后 runtime.run 失败时保留远端错误并标记为运行失败", async () => {
    const client = fakeClient();
    client.request.mockRejectedValue(
      new Error('exec: "claude": executable file not found in $PATH'),
    );
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    await expect(
      dispatchNewConversation({
        plan: availablePlan,
        message: "hi",
        sourceClient,
      }),
    ).rejects.toMatchObject({
      name: "DispatchRunError",
      message: 'exec: "claude": executable file not found in $PATH',
    } satisfies Partial<DispatchRunError>);
    expect(client.connect).toHaveBeenCalled();
    expect(client.close).toHaveBeenCalled();
  });

  it("连接复用期间 socket 未就绪时标记为连接失败，不谎称 Agent 启动失败", async () => {
    const client = fakeClient();
    client.request.mockRejectedValue(
      new RelayError(-1, "relay: 连接未就绪", null),
    );

    await expect(
      dispatchNewConversation({
        plan: availablePlan,
        message: "hi",
        sourceClient,
        client: client as never,
      }),
    ).rejects.toEqual(expect.any(DispatchConnectionError));
    expect(client.close).not.toHaveBeenCalled();
  });

  it("agentred 上的 Pi 用同一代身份完成注册、准备、启动后才算派发成功", async () => {
    const client = fakeClient();
    client.request
      .mockResolvedValueOnce({ sessionId: 7001 })
      .mockResolvedValueOnce({
        sessionId: 7001,
        providerSessionId: "pi-provider-1",
      })
      .mockResolvedValueOnce({
        sessionId: 7001,
        providerSessionId: "pi-provider-1",
      });
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);
    vi.spyOn(Math, "random").mockReturnValueOnce(
      (7001 - 1) / Number.MAX_SAFE_INTEGER,
    );

    const out = await dispatchNewConversation({
      plan: agentredPiPlan,
      message: "用 Pi 看看",
      sourceClient,
    });

    const runs = client.request.mock.calls.filter(
      ([method]) => method === rpcMethods.runtimeRun,
    );
    expect(runs).toHaveLength(3);
    const params = runs.map(([, value]) => value as Record<string, unknown>);
    expect(params.map((p) => p.sessionId)).toEqual([7001n, 7001n, 7001n]);
    expect(params[0].permissionMode).toEqual(expect.any(String));
    expect(params[0].permissionMode).not.toBe("");
    expect(params[1].permissionMode).toBe(params[0].permissionMode);
    expect(params[2].permissionMode).toBe(params[0].permissionMode);
    expect(params[0].providerSessionId).toBeUndefined();
    expect(params[1].providerSessionId).toBeUndefined();
    expect(params[2].providerSessionId).toBe("pi-provider-1");
    expect(out.sessionId).toBe(7001);
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });

  // Given 本站用 http 部署（`http://coding.local:8443` = 非安全上下文，那里
  // `crypto.randomUUID` 带 [SecureContext] 门槛、根本不存在）/ When 往 agentred 上的
  // Pi 派发 / Then 三步照常走完。
  //
  // 回归：这一代身份此前直接调 `crypto.randomUUID()`，在 http 部署上抛 TypeError。
  // 它既不是 DispatchRunError 也不是 DispatchConnectionError，草稿页于是落到兜底那
  // 一支，对着一台连得上的机器说「连不上 coding，请重试」——而一帧中继都没发出去。
  it("非安全上下文里（http 部署，没有 crypto.randomUUID）Pi 派发照常完成", async () => {
    const realCrypto = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: (buffer: Uint8Array) =>
        realCrypto.getRandomValues(buffer),
    });
    expect(typeof crypto.randomUUID).toBe("undefined");

    const client = fakeClient();
    client.request
      .mockResolvedValueOnce({ sessionId: 7003 })
      .mockResolvedValueOnce({
        sessionId: 7003,
        providerSessionId: "pi-provider-2",
      })
      .mockResolvedValueOnce({
        sessionId: 7003,
        providerSessionId: "pi-provider-2",
      });
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);
    vi.spyOn(Math, "random").mockReturnValueOnce(
      (7003 - 1) / Number.MAX_SAFE_INTEGER,
    );

    const out = await dispatchNewConversation({
      plan: agentredPiPlan,
      message: "用 Pi 看看",
      sourceClient,
    });

    const runs = client.request.mock.calls.filter(
      ([method]) => method === rpcMethods.runtimeRun,
    );
    expect(runs).toHaveLength(3);
    const owners = runs.map(
      ([, value]) => (value as Record<string, unknown>).permissionMode,
    );
    expect(owners[0]).toEqual(expect.any(String));
    expect(owners[0]).not.toBe("");
    expect(new Set(owners).size).toBe(1);
    expect(out.sessionId).toBe(7003);
  });

  it("Pi 注册后准备失败会清理这一代，且不保存未启动的会话", async () => {
    const client = fakeClient();
    client.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.runtimeAbort) return {};
      const runCount = client.request.mock.calls.filter(
        ([called]) => called === rpcMethods.runtimeRun,
      ).length;
      if (runCount === 1) return { sessionId: 7002 };
      throw new Error("Pi prepare failed");
    });
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);
    vi.spyOn(Math, "random").mockReturnValueOnce(
      (7002 - 1) / Number.MAX_SAFE_INTEGER,
    );

    await expect(
      dispatchNewConversation({
        plan: agentredPiPlan,
        message: "用 Pi 看看",
        sourceClient,
        client: client as never,
      }),
    ).rejects.toMatchObject({
      name: "DispatchRunError",
      message: "Pi prepare failed",
    });
    expect(client.request).toHaveBeenCalledWith(rpcMethods.runtimeAbort, {
      sessionId: 7002n,
    });
    expect(mockedApi).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();
  });
});

// 派发计划按账号默认顺序（sort_order）解析 —— 用户在总览页排的就是它，所以查询串
// 里不该出现任何调用方标识（决策 14 之前这里带 client_id，那一层已整个删掉）。
describe("fetchDispatchPlan", () => {
  it("查询串带上 Agent 与项目", async () => {
    mockedApi.mockResolvedValue(availablePlan);

    const plan = await fetchDispatchPlan({
      agentSyncId: "agent-1",
      projectSyncId: "proj-1",
    });

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1&project_sync_id=proj-1",
    );
    expect(plan).toBe(availablePlan);
  });

  it("不带项目时只有 Agent —— 不挑项目是一条自由会话，不是缺参数", async () => {
    mockedApi.mockResolvedValue(availablePlan);

    await fetchDispatchPlan({ agentSyncId: "agent-1" });

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1",
    );
  });

  // 「在哪台机器上跑」挑完那一档之后，浏览器要的是**那一档**的指纹与 cwd。
  // 档结构上没有这两样（只有 chosen 有），所以必须把选中的档报给服务端重算。
  it("挑了执行档时把它带进查询串", async () => {
    mockedApi.mockResolvedValue(availablePlan);

    await fetchDispatchPlan({
      agentSyncId: "agent-1",
      projectSyncId: "proj-1",
      targetBackendSyncId: "b-b",
    });

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1" +
        "&project_sync_id=proj-1&target_backend_sync_id=b-b",
    );
  });

  it("挑了执行档但没挑项目：项目这一键缺席，执行档照常带上", async () => {
    mockedApi.mockResolvedValue(availablePlan);

    await fetchDispatchPlan({
      agentSyncId: "agent-1",
      targetBackendSyncId: "b-b",
    });

    expect(mockedApi).toHaveBeenCalledWith(
      "/v1/workspace/dispatch-target?agent_sync_id=agent-1&target_backend_sync_id=b-b",
    );
  });
});

/**
 * 草稿页上定下的档位与模型（规格 2026-08-24「草稿页的两颗控件」）。
 *
 * 两件事在协议上是分开的：档位随 `runtime.run` 过线就地生效，而模型目标过线只
 * 管当轮 —— daemon 的 run 按轮 resolveTarget，不写 `daemon_sessions` 的那两列。
 * 所以钉住要在 ack 之后补一次 `runtime.setModelTarget`，否则用户选的模型第一轮
 * 生效、详情页却读回空 = 「跟随 Agent 绑定」。
 */
describe("dispatchNewConversation：草稿页定下的档位与模型", () => {
  it("档位与模型目标随第一句过线", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
      permissionMode: "acceptEdits",
      modelTarget: { providerKey: "pk-1", modelKey: "mk-1" },
    });

    const p = client.request.mock.calls[0][1] as Record<string, unknown>;
    expect(p.permissionMode).toBe("acceptEdits");
    expect(p.llmProviderKey).toBe("pk-1");
    expect(p.llmModelKey).toBe("mk-1");
  });

  it("跟随 Agent 绑定（两格皆空）时不带模型键过线，也不去钉", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
      modelTarget: { providerKey: "", modelKey: "" },
    });

    const p = client.request.mock.calls[0][1] as Record<string, unknown>;
    // 空串与「不带」在 daemon 上解出的值相同，但带一个空 provider 会让人以为
    // 浏览器在主张什么；跟随绑定就是不主张。
    expect(p.llmProviderKey).toBeUndefined();
    expect(p.llmModelKey).toBeUndefined();
    expect(
      client.request.mock.calls.some(([m]) => m === rpcMethods.setModelTarget),
    ).toBe(false);
    expect(out.modelPinned).toBe(true);
  });

  it("没给档位时不带 permissionMode 过线", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
    });

    const p = client.request.mock.calls[0][1] as Record<string, unknown>;
    expect(p.permissionMode).toBeUndefined();
  });

  it("ack 之后把模型目标钉在那条会话上（否则详情页读回空 = 跟随绑定）", async () => {
    const client = fakeClient();
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
      modelTarget: { providerKey: "pk-1", modelKey: "" },
    });

    const pin = client.request.mock.calls.find(
      ([m]) => m === rpcMethods.setModelTarget,
    );
    expect(pin).toBeTruthy();
    expect(pin?.[1]).toEqual({
      sessionId: 9001n,
      providerKey: "pk-1",
      modelKey: "",
    });
    expect(out.modelPinned).toBe(true);
  });

  // 派发已经成功，那台机器上真真切切多了一条按所选模型跑起来的会话。把钉不住
  // 报成派发失败，用户一重试就凭空再开一条 —— 与 R16 保存失败同一条规矩。
  it("钉不住不算派发失败，如实回报没钉住", async () => {
    const client = fakeClient();
    client.request.mockImplementation(async (method: unknown) => {
      if (method === rpcMethods.setModelTarget)
        throw new Error("unknown method");
      return { sessionId: 9001 };
    });
    MockRelayClient.mockImplementation(function () {
      return client;
    } as never);

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
      modelTarget: { providerKey: "pk-1", modelKey: "mk-1" },
    });

    expect(out.sessionId).toBe(9001);
    expect(out.modelPinned).toBe(false);
  });

  // 草稿页开局就连上了那台机器（问档位用的正是它）。再开一条等于同一台机器上
  // 两条会话连接，而第一条的失败信息会被第二条覆盖。
  it("给了现成连接就复用它，不再另开一条", async () => {
    const client = fakeClient();

    const out = await dispatchNewConversation({
      plan: availablePlan,
      message: "hi",
      sourceClient,
      client: client as never,
    });

    expect(MockRelayClient).not.toHaveBeenCalled();
    expect(client.connect).not.toHaveBeenCalled();
    // 连接不是这次派发建的，就不该由这次派发关掉：草稿页还要用它。
    expect(client.close).not.toHaveBeenCalled();
    expect(out.sessionId).toBe(9001);
  });
});
