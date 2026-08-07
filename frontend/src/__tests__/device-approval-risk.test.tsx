import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "@/lib/api";
import i18n from "@/i18n";
import Device from "@/pages/Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// Device 经 AuthLayout 挂了 AppControls，后者要读 useTheme()。真实
// ThemeProvider 会在 readStored() 里摸 localStorage——这台机器的 Node 版本下
// jsdom 的 window.localStorage 解析成 undefined（Node 自带的实验性 Storage
// 抢占了 jsdom 的实现），是与本测试无关的环境缺陷，绕开即可。
vi.mock("@/lib/theme", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/theme")>();
  return {
    ...actual,
    useTheme: () => ({
      theme: "system" as const,
      resolved: "light" as const,
      setTheme: vi.fn(),
    }),
  };
});

const mockedApi = vi.mocked(api);

const ME = {
  user_id: 1,
  email: "codfrm@example.com",
  display_name: "Cod Frm",
  avatar_url: "",
  github_login: "codfrm",
  csrf_token: "csrf",
};

type Pending = {
  device_kind: string;
  platform: string;
  version: string;
  capabilities: Record<string, boolean>;
  expires_in: number;
};

function pending(over: Partial<Pending> = {}): Pending {
  return {
    device_kind: "desktop",
    platform: "macOS 15.2",
    version: "v0.4.1",
    capabilities: { compute: true, client: true, file_browse: true },
    // 8 分 12 秒，与画板 10 上的过期条一致
    expires_in: 492,
    ...over,
  };
}

/** pending 查得到；approve / deny 的结果由 action 决定。 */
function mockFlow(info: Pending, action?: () => Promise<unknown>) {
  mockedApi.mockImplementation(async (path: string) => {
    if (path.startsWith("/v1/auth/me")) return ME;
    if (path.startsWith("/v1/oauth/device/pending")) return info;
    if (path.startsWith("/v1/oauth/device/")) {
      if (!action) throw new ApiError(30001, "unexpected action: " + path, 500);
      return action();
    }
    throw new ApiError(30001, "unexpected call: " + path, 500);
  });
}

/** 落到哪条路由，以及带过去的 router state。 */
function Probe({ name }: { name: string }) {
  const { state } = useLocation();
  return <div data-testid={`at-${name}`}>{JSON.stringify(state ?? null)}</div>;
}

function renderDevice() {
  return render(
    <MemoryRouter initialEntries={["/device?user_code=A4F-7Q2"]}>
      <Routes>
        <Route path="/device" element={<Device />} />
        <Route path="/device/success" element={<Probe name="success" />} />
        <Route path="/device/denied" element={<Probe name="denied" />} />
        <Route path="/device/expired" element={<Probe name="expired" />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** 确认区渲染出来（H1 是这一屏唯一的一级标题）。 */
function waitForApproval() {
  return screen.findByRole("heading", { level: 1, name: /allow this device/i });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.history.replaceState({}, "", "/device?user_code=A4F-7Q2");
  mockedApi.mockReset();
});

describe("授权确认：整页区域而不是对话框", () => {
  it("查到 pending 记录时确认区就地渲染，页面上没有任何 dialog", async () => {
    mockFlow(pending());
    renderDevice();

    await waitForApproval();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("设备面板给出这台设备的真实信息", async () => {
    mockFlow(pending());
    renderDevice();

    await waitForApproval();
    expect(screen.getByText("macOS 15.2 · v0.4.1")).toBeTruthy();
    // 大号确认码照画板 10，带连字符
    expect(screen.getByText("A4F-7Q2")).toBeTruthy();
  });
});

describe("授权确认：风险文案由 capabilities.compute 决定", () => {
  it("compute 为真时讲明这是计算节点、可执行任意代码", async () => {
    mockFlow(
      pending({ device_kind: "desktop", capabilities: { compute: true } }),
    );
    renderDevice();

    await waitForApproval();
    expect(screen.getByText(/compute node/i)).toBeTruthy();
    expect(screen.getByText(/arbitrary code/i)).toBeTruthy();
  });

  it("compute 不在能力里时换成中性说明，即使 kind 是 agentred", async () => {
    mockFlow(
      pending({ device_kind: "agentred", capabilities: { client: true } }),
    );
    renderDevice();

    await waitForApproval();
    // 「计算节点」这几个字仍会作为 kind 标签出现在设备面板里，
    // 所以认风险文案里独有的那句
    expect(screen.queryByText(/arbitrary code/i)).toBeNull();
    expect(screen.queryByText(/it runs coding agents as you/i)).toBeNull();
    expect(screen.getByText(/connects to your AgentRe account/i)).toBeTruthy();
  });
});

describe("授权确认：能力清单", () => {
  it("已收录的三个键各自出标题与说明", async () => {
    mockFlow(pending());
    renderDevice();

    await waitForApproval();
    expect(screen.getByText(/run coding agent tasks/i)).toBeTruthy();
    expect(screen.getByText(/claude code/i)).toBeTruthy();
    expect(screen.getByText(/connect as a client/i)).toBeTruthy();
    expect(screen.getByText(/browse project files/i)).toBeTruthy();
  });

  it("未收录的键原样展示键名，并说明控制台尚未收录它", async () => {
    mockFlow(pending({ capabilities: { "session.remote_start": true } }));
    renderDevice();

    await waitForApproval();
    expect(screen.getByText("session.remote_start")).toBeTruthy();
    expect(screen.getByText(/no description for it yet/i)).toBeTruthy();
    // 不许替未收录的键编一句说明
    expect(screen.queryByText(/run coding agent tasks/i)).toBeNull();
  });

  it("值为 false 的能力不出现在清单里", async () => {
    mockFlow(pending({ capabilities: { compute: true, file_browse: false } }));
    renderDevice();

    await waitForApproval();
    expect(screen.getByText(/run coding agent tasks/i)).toBeTruthy();
    expect(screen.queryByText(/browse project files/i)).toBeNull();
  });
});

describe("授权确认：过期倒计时", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("从 expires_in 起算，并逐秒往下走", async () => {
    mockFlow(pending({ expires_in: 492 }));
    renderDevice();

    await waitForApproval();
    expect(screen.getByText(/8m 12s/)).toBeTruthy();

    await advance(60_000);
    expect(screen.getByText(/7m 12s/)).toBeTruthy();
  });

  it("倒计时归零即过期，落到 /device/expired", async () => {
    mockFlow(pending({ expires_in: 5 }));
    renderDevice();

    await waitForApproval();
    await advance(5_000);
    expect(screen.getByTestId("at-expired")).toBeTruthy();
  });

  it("aria-live 只在分钟变化时改口播，不逐秒播报", async () => {
    mockFlow(pending({ expires_in: 492 }));
    const { container } = renderDevice();

    await waitForApproval();
    const live = () =>
      container.querySelector('[aria-live="polite"]')?.textContent ?? "";
    const first = live();
    expect(first).toMatch(/about 8 minutes/i);

    // 秒数变了，播报内容一个字都不能变
    await advance(1_000);
    expect(screen.getByText(/8m 11s/)).toBeTruthy();
    expect(live()).toBe(first);

    // 跨过分钟边界才换一句
    await advance(12_000);
    expect(live()).toMatch(/about 7 minutes/i);
  });
});

describe("授权确认：拒绝", () => {
  function deny() {
    fireEvent.click(screen.getByRole("button", { name: /^deny$/i }));
  }

  it("拒绝成功后落到 /device/denied", async () => {
    mockFlow(pending(), async () => null);
    renderDevice();

    await waitForApproval();
    deny();
    expect(await screen.findByTestId("at-denied")).toBeTruthy();
  });

  it("拒绝时后端回 30202（已过期）落到 /device/expired", async () => {
    mockFlow(pending(), async () => {
      throw new ApiError(30202, "expired_token", 410);
    });
    renderDevice();

    await waitForApproval();
    deny();
    expect(await screen.findByTestId("at-expired")).toBeTruthy();
  });
});

describe("授权确认：允许", () => {
  function approve() {
    fireEvent.click(screen.getByRole("button", { name: /allow access/i }));
  }

  it("允许成功后落到 /device/success，并把设备信息带过去", async () => {
    mockFlow(pending(), async () => ({ device_kind: "desktop" }));
    renderDevice();

    await waitForApproval();
    approve();

    const at = await screen.findByTestId("at-success");
    expect(JSON.parse(at.textContent ?? "null")).toEqual({
      kind: "desktop",
      platform: "macOS 15.2",
      version: "v0.4.1",
    });
  });

  it("允许时后端回 30202（已过期）落到 /device/expired", async () => {
    mockFlow(pending(), async () => {
      throw new ApiError(30202, "expired_token", 410);
    });
    renderDevice();

    await waitForApproval();
    approve();
    expect(await screen.findByTestId("at-expired")).toBeTruthy();
  });

  it("其余失败留在确认屏并以 Alert 说明", async () => {
    mockFlow(pending(), async () => {
      throw new ApiError(30001, "boom", 500);
    });
    renderDevice();

    await waitForApproval();
    approve();

    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    expect(screen.queryByTestId("at-expired")).toBeNull();
    expect(screen.queryByTestId("at-success")).toBeNull();
  });
});

describe("授权确认：中文文案照画板 10", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("标题、代码确认块与脚注用画板上的中文", async () => {
    mockFlow(pending());
    renderDevice();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "允许这台设备访问你的 AgentRe 账户？",
      }),
    ).toBeTruthy();
    expect(screen.getByText("确认这串代码与设备上显示的完全一致")).toBeTruthy();
    expect(screen.getByText("这台设备将获得以下能力")).toBeTruthy();
    expect(
      screen.getByText("你可以随时在 控制台 → 设备 中撤销这台设备的访问权限。"),
    ).toBeTruthy();
  });

  // spec「i18n」：「中文文案以稿子上的原文为准」。未收录能力那句在画板 10 上
  // 是 cap-unknown 那行的 Desc，写全了「设备声明了此能力」这半句——
  // 少掉它，用户读到的就只剩控制台的自述，看不出这个键是设备自己报上来的。
  it("未收录能力的说明用画板 10 的原话", async () => {
    mockFlow(pending({ capabilities: { "filesystem.write": true } }));
    renderDevice();

    await screen.findByRole("heading", {
      level: 1,
      name: "允许这台设备访问你的 AgentRe 账户？",
    });
    expect(screen.getByText("filesystem.write")).toBeTruthy();
    expect(
      screen.getByText(
        "设备声明了此能力，但控制台尚未收录它的说明——未知键一律原样展示，不隐藏",
      ),
    ).toBeTruthy();
  });
});
