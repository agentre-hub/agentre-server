import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";
import i18n from "@/i18n";
import Device from "@/pages/Device";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
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
  expires_in: number;
};

function pending(over: Partial<Pending> = {}): Pending {
  return {
    device_kind: "desktop",
    platform: "macOS 15.2",
    version: "v0.4.1",
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
    { wrapper: ThemeProvider },
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

describe("授权确认：完整权限说明", () => {
  // 授权一台设备拿到的就是账号的完整权限——服务端没有任何一处按设备做过权限
  // 判断。因此这句说明不分档：authorize 接受的三种 kind 读到的是同一句话。
  it.each(["desktop", "agentred", "mobile"])(
    "kind 是 %s 时都出同一句完整权限说明",
    async (kind) => {
      mockFlow(pending({ device_kind: kind }));
      renderDevice();

      await waitForApproval();
      expect(
        screen.getByText(/full access to your AgentRe account/i),
      ).toBeTruthy();
      expect(screen.getByText(/arbitrary code and commands/i)).toBeTruthy();
    },
  );

  it("不再有中性档：agentred 与 desktop 读到的说明逐字相同", async () => {
    mockFlow(pending({ device_kind: "desktop" }));
    const { unmount } = renderDevice();
    await waitForApproval();
    const desktopCopy = screen.getByText(
      /full access to your AgentRe account/i,
    ).textContent;
    unmount();

    mockedApi.mockReset();
    mockFlow(pending({ device_kind: "agentred" }));
    renderDevice();
    await waitForApproval();
    expect(
      screen.getByText(/full access to your AgentRe account/i).textContent,
    ).toBe(desktopCopy);
  });
});

describe("授权确认：能力清单已整体消失", () => {
  it("确认屏上没有能力摘要那一行", async () => {
    mockFlow(pending());
    renderDevice();

    await waitForApproval();
    expect(screen.queryByText(/will be able to:/i)).toBeNull();
    expect(screen.queryByText(/Run coding agent tasks/i)).toBeNull();
    expect(screen.queryByText(/Connect as a client/i)).toBeNull();
    expect(screen.queryByText(/Browse project files/i)).toBeNull();
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

  // 用户在最后一秒点了「允许」：请求已经发到服务端，倒计时随后归零。
  // 本地那块表不是权威——服务端可能已经把这次授权收下了。此时抢先跳过期页
  // 会告诉用户「失败了」，而设备其实已经拿到访问权；用户再授权一次，
  // 名下于是多出一台自己没打算批两遍的设备。
  describe("请求在途时倒计时归零", () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("不抢跑到 /device/expired，等 approve 的结果", async () => {
      let release!: () => void;
      mockFlow(
        pending({ expires_in: 3 }),
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true });
          }),
      );
      renderDevice();

      await waitForApproval();
      approve();

      // 倒计时走完，approve 还没回来
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(screen.queryByTestId("at-expired")).toBeNull();

      // 服务端说成了，就该落成功屏
      await act(async () => {
        release();
      });
      expect(await screen.findByTestId("at-success")).toBeTruthy();
    });
  });
});

describe("授权确认：中文界面能力摘要", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("中文确认屏同样没有能力摘要", async () => {
    mockFlow(pending());
    renderDevice();

    await screen.findByRole("heading", {
      level: 1,
      name: "允许这台设备访问你的 AgentRe 账户？",
    });
    expect(screen.queryByText(/这台设备将获得能力：/)).toBeNull();
  });
});
