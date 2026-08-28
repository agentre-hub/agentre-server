import { beforeEach, describe, expect, it, vi } from "vitest";
import { rpcMethods } from "@agentre-hub/agentre-wire";

const relayMocks = vi.hoisted(() => ({
  request: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("@/lib/relayClient", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    RelayClient: class {
      constructor(opts: unknown) {
        relayMocks.ctor(opts);
      }
      connect = relayMocks.connect;
      close = relayMocks.close;
      request = relayMocks.request;
    },
  };
});

vi.mock("@/lib/relayTicket", () => ({
  ensureRelayTicket: vi.fn(async () => ({
    accessToken: "tok",
    clientId: "browser-1",
  })),
}));

import { ApiError } from "@/lib/api";
import { RelayError } from "@/lib/relayClient";

import { createProjectFsPort } from "@/lib/projectFsPort";

/**
 * 本站这一侧的 `ProjectFsPort`（规格 2026-08-22 D 段）。
 *
 * 共用的那份选择器已经在包里测过了；这里只测**接缝**——中继那条通路翻成 port 时
 * 有没有翻对。包的测试全绿证明不了这一层接对了。
 */
describe("本站的 ProjectFsPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    relayMocks.connect.mockResolvedValue(undefined);
  });

  it("`.git` 是「当前目录是仓库」的判据，不进可选列表", async () => {
    relayMocks.request.mockResolvedValue({
      path: "/srv/work/atlas",
      entries: [
        { name: ".git", isDir: true, size: 0, mtime: 0 },
        { name: "cmd", isDir: true, size: 0, mtime: 0 },
      ],
    });
    const port = createProjectFsPort();
    const outcome = await port.listDir("fp-1", "/srv/work/atlas");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.isGitRepo).toBe(true);
    expect(outcome.result.entries.map((e) => e.name)).toEqual(["cmd"]);
    port.dispose();
  });

  it("文件留在清单里 —— 包会画成可见不可选，那是「这个目录是不是我要的」的上下文", async () => {
    relayMocks.request.mockResolvedValue({
      path: "/srv",
      entries: [
        { name: "notes.md", isDir: false, size: 1, mtime: 0 },
        { name: "shared", isDir: true, symlink: true, size: 0, mtime: 0 },
      ],
      truncated: true,
    });
    const port = createProjectFsPort();
    const outcome = await port.listDir("fp-1", "/srv");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.entries).toEqual([
      { name: "notes.md", isDir: false, symlink: undefined },
      { name: "shared", isDir: true, symlink: true },
    ]);
    expect(outcome.result.truncated).toBe(true);
    port.dispose();
  });

  it("按**错误码**分类，不按文案 —— 文案是那台机器的 Go 文本，改一个字判断就散了", async () => {
    const cases: [number, string][] = [
      [-32031, "denied"],
      [-32032, "notFound"],
      [-32033, "notDir"],
      [-32030, "refused"],
      [-32035, "invalidName"],
    ];
    for (const [code, kind] of cases) {
      relayMocks.request.mockRejectedValueOnce(
        new RelayError(code, "go text", null),
      );
      const port = createProjectFsPort();
      const outcome = await port.listDir("fp-1", "/x");
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.kind).toBe(kind);
      port.dispose();
    }
  });

  it("mkdir 重名交 exists，参数原样递过去", async () => {
    relayMocks.request.mockRejectedValue(
      new RelayError(-32034, "exists", null),
    );
    const port = createProjectFsPort();
    const outcome = await port.mkdir("fp-1", "/srv/work", "edge");
    expect(relayMocks.request).toHaveBeenCalledWith(rpcMethods.remoteFsMkdir, {
      parent: "/srv/work",
      name: "edge",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("exists");
    port.dispose();
  });

  it("同一台机器只连一次 —— 每次 listDir 都新建一条中继是浪费也是抖动", async () => {
    relayMocks.request.mockResolvedValue({ path: "/a", entries: [] });
    const port = createProjectFsPort();
    await port.listDir("fp-1", "/a");
    await port.listDir("fp-1", "/b");
    expect(relayMocks.ctor).toHaveBeenCalledTimes(1);
    port.dispose();
  });

  it("换一台机器就另起一条，dispose 时全部收掉", async () => {
    relayMocks.request.mockResolvedValue({ path: "/a", entries: [] });
    const port = createProjectFsPort();
    await port.listDir("fp-1", "/a");
    await port.listDir("fp-2", "/a");
    expect(relayMocks.ctor).toHaveBeenCalledTimes(2);
    port.dispose();
    expect(relayMocks.close).toHaveBeenCalledTimes(2);
  });

  it("连不上时交 disconnected，而不是一个说不清的 TypeError", async () => {
    relayMocks.connect.mockRejectedValue(new Error("ws refused"));
    const port = createProjectFsPort();
    const outcome = await port.listDir("fp-1", "/a");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("disconnected");
    port.dispose();
  });

  it("dispose 之后这份 port 还能再用 —— StrictMode 会先卸载一次再装回来", async () => {
    relayMocks.request.mockResolvedValue({ path: "/a", entries: [] });
    const port = createProjectFsPort();
    await port.listDir("fp-1", "/a");
    // React 18 的 StrictMode 在开发下把 effect 跑两遍：mount → cleanup → mount。
    // 中间那次 cleanup 会调 dispose，而 useMemo 交出来的还是**同一个** port。
    // 把 disposed 记成一个不可逆的闸，等于 `make dev` 下目录选择器永远说「连接断了」。
    port.dispose();
    const outcome = await port.listDir("fp-1", "/a");
    expect(outcome.ok).toBe(true);
    port.dispose();
  });

  it("上一次连挂了，下一次还能再试 —— 不把那台机器永久钉在失败上", async () => {
    relayMocks.connect.mockRejectedValueOnce(new Error("ws refused"));
    relayMocks.request.mockResolvedValue({ path: "/a", entries: [] });
    const port = createProjectFsPort();
    expect((await port.listDir("fp-1", "/a")).ok).toBe(false);
    expect((await port.listDir("fp-1", "/a")).ok).toBe(true);
    port.dispose();
  });
});

const restMocks = vi.hoisted(() => ({
  updateProject: vi.fn(),
  addProjectMember: vi.fn(),
  removeProjectMember: vi.fn(),
  fetchProjectMachines: vi.fn(),
  setProjectLocation: vi.fn(),
  deleteProjectLocation: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  setLocalPathOnMachine: vi.fn(),
  clearLocalPathOnMachine: vi.fn(),
}));

vi.mock("@/lib/projects", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  updateProject: restMocks.updateProject,
  addProjectMember: restMocks.addProjectMember,
  removeProjectMember: restMocks.removeProjectMember,
  fetchProjectMachines: restMocks.fetchProjectMachines,
  setProjectLocation: restMocks.setProjectLocation,
  deleteProjectLocation: restMocks.deleteProjectLocation,
  createProject: restMocks.createProject,
  deleteProject: restMocks.deleteProject,
}));

vi.mock("@/lib/projectLocalPath", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setLocalPathOnMachine: restMocks.setLocalPathOnMachine,
  clearLocalPathOnMachine: restMocks.clearLocalPathOnMachine,
}));

const {
  createProjectSettingsPorts,
  createProjectCreatePorts,
  createProjectDeletePorts,
} = await import("@/lib/projectPorts");

/**
 * REST 那一侧的接缝（规格 2026-08-22 B 段）。三个弹窗本身住在包里；这里问的是
 * 「写往哪去」有没有分对 —— 那正是本站与桌面端形状最不同的一处。
 */
describe("本站的项目 ports", () => {
  beforeEach(() => vi.clearAllMocks());

  it("改字段：包递的驼峰 parentId 翻成 wire 上的 parent_sync_id", async () => {
    restMocks.updateProject.mockResolvedValue({});
    const ports = createProjectSettingsPorts(createProjectFsPort());
    await ports.updateFields("p1", { name: "Atlas", parentId: "p9" });
    expect(restMocks.updateProject).toHaveBeenCalledWith("p1", {
      name: "Atlas",
      parent_sync_id: "p9",
    });
  });

  it("改字段失败：服务端自带文案的业务码原样透出，分类交 unknown", async () => {
    restMocks.updateProject.mockRejectedValue(
      new ApiError(1001, "同级下已经有一个叫 Atlas 的项目", 400),
    );
    const ports = createProjectSettingsPorts(createProjectFsPort());
    const outcome = await ports.updateFields("p1", { name: "Atlas" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("unknown");
    expect(outcome.failure.message).toContain(
      "同级下已经有一个叫 Atlas 的项目",
    );
  });

  it("机器清单：agentred 与桌面端各自的可写性由这里说出来", async () => {
    restMocks.fetchProjectMachines.mockResolvedValue([
      {
        deviceId: 1,
        deviceName: "build-01",
        kind: "agentred",
        fingerprint: "fp-a",
        online: false,
        configured: true,
        path: "/srv/a",
        locationSyncId: "loc-1",
      },
      {
        deviceId: 2,
        deviceName: "office-imac",
        kind: "desktop",
        fingerprint: "fp-d",
        online: false,
        configured: true,
        path: "",
        locationSyncId: "",
      },
    ]);
    const ports = createProjectSettingsPorts(createProjectFsPort());
    const machines = await ports.listMachines("p1");

    // agentred 的路径是账号级同步对象，服务端直写 —— 离线也配得了。
    expect(machines[0]).toMatchObject({
      id: "fp-a",
      kind: "agentred",
      writeNeedsOnline: false,
      removable: true,
    });
    // 桌面端的只住在它自己的上报组，要经中继喊它自己写 —— 它必须在线。
    expect(machines[1]).toMatchObject({
      id: "fp-d",
      kind: "desktop",
      writeNeedsOnline: true,
      removable: true,
    });
    // web 宿主没有「本机」那一行。
    expect(machines.some((m) => m.isSelf)).toBe(false);
  });

  it("写路径：agentred 走服务端直写，桌面端经中继喊它自己写", async () => {
    restMocks.setProjectLocation.mockResolvedValue({});
    restMocks.setLocalPathOnMachine.mockResolvedValue({});
    const ports = createProjectSettingsPorts(createProjectFsPort());
    const farm = {
      id: "fp-a",
      name: "build-01",
      kind: "agentred" as const,
      online: true,
      path: "",
      removable: false,
    };
    const peer = { ...farm, id: "fp-d", kind: "desktop" as const };

    await ports.setMachinePath("p1", farm, "/srv/a");
    expect(restMocks.setProjectLocation).toHaveBeenCalledWith(
      "p1",
      "fp-a",
      "/srv/a",
    );

    await ports.setMachinePath("p1", peer, "/home/w/a");
    expect(restMocks.setLocalPathOnMachine).toHaveBeenCalledWith(
      "fp-d",
      "p1",
      "/home/w/a",
    );
  });

  it("中继写失败按错误码分四类，不折成一句", async () => {
    restMocks.setLocalPathOnMachine.mockRejectedValue(
      new RelayError(-32052, "no such dir", null),
    );
    const ports = createProjectSettingsPorts(createProjectFsPort());
    const outcome = await ports.setMachinePath(
      "p1",
      {
        id: "fp-d",
        name: "d",
        kind: "desktop",
        online: true,
        path: "",
        removable: false,
      },
      "/nope",
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe("pathNotFound");
  });

  it("移除路径：agentred 删的是那条同步对象，桌面端喊它自己清", async () => {
    restMocks.deleteProjectLocation.mockResolvedValue({});
    restMocks.clearLocalPathOnMachine.mockResolvedValue({});
    restMocks.fetchProjectMachines.mockResolvedValue([
      {
        deviceId: 1,
        deviceName: "a",
        kind: "agentred",
        fingerprint: "fp-a",
        online: true,
        configured: true,
        path: "/srv/a",
        locationSyncId: "loc-1",
      },
    ]);
    const ports = createProjectSettingsPorts(createProjectFsPort());
    // 那条同步对象的 id 是 wire 细节，不进包的 view —— adapter 从自己刚读回来的
    // 那份清单里查，弹窗里能按到移除就一定先读过清单。
    await ports.listMachines("p1");
    await ports.clearMachinePath("p1", {
      id: "fp-a",
      name: "a",
      kind: "agentred",
      online: true,
      path: "/srv/a",
      removable: true,
    });
    expect(restMocks.deleteProjectLocation).toHaveBeenCalledWith("loc-1");

    await ports.clearMachinePath("p1", {
      id: "fp-d",
      name: "d",
      kind: "desktop",
      online: true,
      path: "",
      removable: true,
    });
    expect(restMocks.clearLocalPathOnMachine).toHaveBeenCalledWith(
      "fp-d",
      "p1",
    );
  });

  it("拿不到那条同步对象的 id 就当场说不知道，不拿空串去打端点", async () => {
    const ports = createProjectSettingsPorts(createProjectFsPort());
    // 没先读过清单 —— 空串打过去只会换回一个 404，用户读到的是「这次改动没生效」，
    // 而真实原因是这一层没接上。
    const outcome = await ports.clearMachinePath("p1", {
      id: "fp-a",
      name: "a",
      kind: "agentred",
      online: true,
      path: "/srv/a",
      removable: true,
    });
    expect(outcome.ok).toBe(false);
    expect(restMocks.deleteProjectLocation).not.toHaveBeenCalled();
  });

  it("新建：只送真的填了的键", async () => {
    restMocks.createProject.mockResolvedValue({ sync_id: "p9" });
    const ports = createProjectCreatePorts();
    // 这一端没有本机，所以挑本机目录与 git 探测两个 port 都不挂。
    expect(ports.pickLocalDirectory).toBeUndefined();
    expect(ports.probeGitRepo).toBeUndefined();

    const outcome = await ports.create({ name: "Atlas", parentId: "p1" });
    expect(restMocks.createProject).toHaveBeenCalledWith({
      name: "Atlas",
      parent_sync_id: "p1",
    });
    expect(outcome).toEqual({ ok: true, id: "p9" });
  });

  it("删除：失败时业务文案原样透出", async () => {
    restMocks.deleteProject.mockRejectedValue(
      new ApiError(1002, "还有活跃会话", 409),
    );
    const outcome = await createProjectDeletePorts().deleteProject("p1");
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.message).toContain("还有活跃会话");
  });
});
