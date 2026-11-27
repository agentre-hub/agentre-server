/**
 * 操作反馈与确认（规格 2026-11-25 F2 / F3 / F7，对比稿 a6 B、a7 B）：
 *   - 长按「停止这一轮」：行上立即「正在停止…」，失败顶部「没停下来 · 重试」；
 *   - 输入框 ■ 的停止失败同样出声；
 *   - 删除失败：对话框内一行原因、按钮恢复可点；
 *   - 手机上退出登录 / 删除对话是底部确认 sheet（44px 满宽、危险键在上），桌面不变；
 *   - 端口转发「打开」手机上先拿到地址、就地给一个链接，不在 await 之后 window.open。
 */
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DevicePortForward } from "@/components/devices/DevicePortForward";
import DeleteSessionDialog from "@/components/session/DeleteSessionDialog";
import { useTurnStop } from "@/components/session/useTurnStop";
import { UserMenu } from "@/components/UserMenu";
import i18n from "@/i18n";
import { api, ApiTimeoutError } from "@/lib/api";
import { withRelayClient } from "@/lib/relayClientPool";
import {
  setDeleteFailure,
  clearDeleteFailure,
} from "@/pages/chat/useSessionIndex";
import {
  stopRowTurn,
  useStoppingRows,
  STOP_SETTLE_MS,
} from "@/pages/chat/stopRowTurn";
import { allocatePortForwardLink, listPortForwards } from "@/lib/portForward";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});
vi.mock("@/lib/relayClientPool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/relayClientPool")>();
  return { ...actual, withRelayClient: vi.fn() };
});
vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});
vi.mock("@/lib/portForward", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portForward")>();
  return {
    ...actual,
    listPortForwards: vi.fn(),
    allocatePortForwardLink: vi.fn(),
  };
});
vi.mock("sonner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sonner")>();
  return { ...actual, toast: { ...actual.toast, error: vi.fn() } };
});

const mockedWithClient = vi.mocked(withRelayClient);
const mockedToastError = vi.mocked(toast.error);
const originalMatchMedia = window.matchMedia;

function setViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile && query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function row(over: Partial<MirrorIndexRow> = {}): MirrorIndexRow {
  return {
    key: "k-1",
    conversationId: "c-1",
    sessionId: 0,
    deviceId: 1,
    fingerprint: "fp-a",
    machineFingerprint: "fp-a",
    agentSyncId: "ag-1",
    updatedAt: 1,
    title: "跑着呢",
    lifecycleState: "running",
    saved: true,
    ...over,
  } as MirrorIndexRow;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedWithClient.mockReset();
  mockedToastError.mockReset();
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue(undefined);
  setViewport(false);
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

describe("长按停止：行上的「正在停止…」与失败提示（F2）", () => {
  it("点下去立即标记这一行在停止；重复点不再发第二次", async () => {
    let release!: () => void;
    mockedWithClient.mockImplementation(
      () => new Promise<unknown>((r) => (release = () => r(undefined))),
    );
    const hook = renderHook(() => useStoppingRows());
    const r = row({ conversationId: "c-repeat" });

    let first!: Promise<void>;
    act(() => {
      first = stopRowTurn(r);
    });
    expect(hook.result.current.has("c-repeat")).toBe(true);
    void stopRowTurn(r);
    expect(mockedWithClient).toHaveBeenCalledTimes(1);

    release();
    await act(async () => {
      await first;
    });
    // 请求成功不等于停下了：标记留着，直到这一轮的状态自己落下或超出等待上限。
    expect(hook.result.current.has("c-repeat")).toBe(true);
  });

  it("请求成功后超出等待上限放下标记，行不会永远挂着「正在停止…」", async () => {
    vi.useFakeTimers();
    mockedWithClient.mockResolvedValue(undefined);
    const hook = renderHook(() => useStoppingRows());
    await act(async () => {
      await stopRowTurn(row({ conversationId: "c-settle" }));
    });
    expect(hook.result.current.has("c-settle")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(STOP_SETTLE_MS + 1);
    });
    expect(hook.result.current.has("c-settle")).toBe(false);
  });

  it("失败：放下标记，顶部提示「没停下来」带原因与重试，重试再发一次", async () => {
    mockedWithClient.mockRejectedValueOnce(new ApiTimeoutError("/v1/x", 15000));
    const hook = renderHook(() => useStoppingRows());
    await act(async () => {
      await stopRowTurn(row({ conversationId: "c-fail" }));
    });

    expect(hook.result.current.has("c-fail")).toBe(false);
    expect(mockedToastError).toHaveBeenCalledTimes(1);
    const [title, opts] = mockedToastError.mock.calls[0] as [
      string,
      { description?: string; action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Couldn't stop it");
    expect(opts.description).toBeTruthy();
    expect(opts.action.label).toBe("Retry");

    mockedWithClient.mockResolvedValueOnce(undefined);
    await act(async () => {
      opts.action.onClick();
    });
    expect(mockedWithClient).toHaveBeenCalledTimes(2);
    expect(hook.result.current.has("c-fail")).toBe(true);
  });
});

describe("输入框 ■ 的停止失败（F2）", () => {
  it("请求失败：停止键放开，顶部提示「没停下来」带重试；重试再发一次", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new ApiTimeoutError("/v1/x", 15000))
      .mockResolvedValueOnce({});
    const { result } = renderHook(() =>
      useTurnStop({
        clientRef: { current: { request } as never },
        originRef: { current: "fp-a" },
        sid: "c-1",
        running: true,
      }),
    );
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.stopping).toBe(false);
    const [title, opts] = mockedToastError.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void } },
    ];
    expect(title).toBe("Couldn't stop it");
    expect(opts.action.label).toBe("Retry");
    await act(async () => {
      opts.action.onClick();
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.current.stopping).toBe(true);
  });
});

describe("删除失败：对话框内一行原因，按钮恢复可点（F2）", () => {
  function renderDialog() {
    const onConfirm = vi.fn();
    render(
      <MemoryRouter>
        <DeleteSessionDialog
          open
          onOpenChange={() => {}}
          machineName="书房"
          machineOnline
          machineKind="agentred"
          onConfirm={onConfirm}
        />
      </MemoryRouter>,
    );
    return { onConfirm };
  }
  afterEach(() => act(() => clearDeleteFailure()));

  it("桌面：失败原因写在对话框里，确认键仍可点；清掉后原因消失", async () => {
    const { onConfirm } = renderDialog();
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => setDeleteFailure(new ApiTimeoutError("/v1/x", 15000)));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/delet/i);
    const confirm = screen.getByTestId("delete-session-confirm");
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    act(() => clearDeleteFailure());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("手机：是底部确认 sheet，删除键在上、取消在下，44px 满宽，失败原因在 sheet 内", async () => {
    setViewport(true);
    const { onConfirm } = renderDialog();
    const sheet = await screen.findByTestId("confirm-sheet");
    const buttons = within(sheet).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Delete", "Cancel"]),
    );
    const names = buttons
      .filter((b) => ["Delete", "Cancel"].includes(b.textContent ?? ""))
      .map((b) => b.textContent);
    expect(names).toEqual(["Delete", "Cancel"]);
    for (const b of buttons.filter((b) =>
      ["Delete", "Cancel"].includes(b.textContent ?? ""),
    )) {
      expect(b.className).toContain("h-11");
      expect(b.className).toContain("w-full");
    }
    act(() => setDeleteFailure(new ApiTimeoutError("/v1/x", 15000)));
    expect((await within(sheet).findByRole("alert")).textContent).toMatch(
      /delet/i,
    );
    const del = screen.getByTestId("delete-session-confirm");
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("退出登录确认（F3）", () => {
  const me = {
    user_id: 1,
    email: "dev@agentre.dev",
    display_name: "Dev User",
    avatar_url: "",
    github_login: "dev",
    csrf_token: "t",
  };
  function openSignOut() {
    render(
      <MemoryRouter>
        <UserMenu me={me} compact />
      </MemoryRouter>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Account menu" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Sign out/i }));
  }

  it("手机：先弹底部 sheet，没确认前不登出；危险键在上、44px 满宽；取消留在原处", async () => {
    setViewport(true);
    openSignOut();
    const sheet = await screen.findByTestId("confirm-sheet");
    expect(api).not.toHaveBeenCalled();
    const buttons = within(sheet).getAllByRole("button");
    expect(buttons[0].textContent).toBe("Sign out");
    expect(buttons[0].className).toContain("h-11");
    expect(buttons[0].className).toContain("w-full");
    expect(buttons[1].textContent).toBe("Cancel");
    fireEvent.click(buttons[1]);
    await waitFor(() =>
      expect(screen.queryByTestId("confirm-sheet")).toBeNull(),
    );
    expect(api).not.toHaveBeenCalled();
  });

  it("手机：确认后才登出", async () => {
    setViewport(true);
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });
    openSignOut();
    const sheet = await screen.findByTestId("confirm-sheet");
    fireEvent.click(within(sheet).getAllByRole("button")[0]);
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith("/v1/auth/logout", { method: "POST" }),
    );
  });
});

describe("端口转发「打开」（F7）", () => {
  beforeEach(() => {
    vi.mocked(listPortForwards).mockResolvedValue([
      {
        id: "7",
        port: 3000,
        target: "localhost:3000",
        name: "Vite",
        enabled: true,
      },
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  function renderForward() {
    // 失败提示（FailureNotice）带「重新登录」的 next，要在 Router 里渲染。
    render(
      <MemoryRouter>
        <DevicePortForward deviceId={12} fingerprint="fp" offline={false} />
      </MemoryRouter>,
    );
  }
  async function tapOpen() {
    const open = await screen.findByRole("button", {
      name: "Open in a new tab",
    });
    fireEvent.click(open);
  }

  it("手机：先拿到地址，就地给一个链接，不调用 window.open（点链接才开新页）", async () => {
    setViewport(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.mocked(allocatePortForwardLink).mockResolvedValue({
      url: "https://abcd.fw.example/",
    } as never);
    renderForward();
    await tapOpen();

    const link = (await screen.findByTestId(
      "port-forward-open-link",
    )) as HTMLAnchorElement;
    expect(link.href).toBe("https://abcd.fw.example/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    expect(open).not.toHaveBeenCalled();
  });

  it("手机：拿不到地址就在原处报错，没有链接也没有空白页", async () => {
    setViewport(true);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.mocked(allocatePortForwardLink).mockRejectedValue(
      new ApiTimeoutError("/v1/x", 15000),
    );
    renderForward();
    await tapOpen();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("port-forward-open-link")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("桌面：仍是点击里同步开空白页再导航（原流程不变）", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    vi.mocked(allocatePortForwardLink).mockResolvedValue({
      url: "https://abcd.fw.example/",
    } as never);
    renderForward();
    await tapOpen();
    expect(window.open).toHaveBeenCalledWith("", "_blank");
    await waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        "https://abcd.fw.example/",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(screen.queryByTestId("port-forward-open-link")).toBeNull();
  });
});
