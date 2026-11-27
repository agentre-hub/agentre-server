/**
 * 新版本提示（规格 2026-11-25 决策 B1，对比稿 d8 B）。
 *
 * sw.js 一侧（回答 check-update、比较入口）由 sw-script.test.ts 管；这里管页面一侧：
 * 启动与回到前台时去问、收到 "update-available" 才出提示条、可关闭、回前台再出；
 * 「重新加载」只在人点了之后才 reload——不强制刷新。版本不符的横幅（页面旧的那一
 * 方向）给同一颗「重新加载」。
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AppShell from "@/components/AppShell";
import SessionStatusBanner from "@/components/session/SessionStatusBanner";
import UpdateAvailableBar from "@/components/UpdateAvailableBar";
import { startUpdateWatch } from "@/hooks/use-update-available";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

vi.mock("@/lib/accountChannel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accountChannel")>();
  return { ...actual, startAccountChannel: vi.fn(() => ({ stop: () => {} })) };
});

const ENTRY = "/assets/index-aaa.js";

/** 假的 navigator.serviceWorker：能派发 message、记下发给 controller 的消息。 */
function fakeContainer(opts: { controlled?: boolean } = {}) {
  const target = new EventTarget();
  const postMessage = vi.fn();
  return Object.assign(target, {
    controller: opts.controlled === false ? null : { postMessage },
    startMessages: vi.fn(),
    postMessage,
    deliver(data: unknown) {
      act(() => {
        target.dispatchEvent(new MessageEvent("message", { data }));
      });
    },
  });
}

/** 假的 document：可切前后台；入口脚本照真实产物的形状给。 */
function fakeDoc() {
  const target = new EventTarget();
  const doc = Object.assign(target, {
    visibilityState: "visible" as DocumentVisibilityState,
    querySelector: (selector: string) =>
      selector.includes('type="module"')
        ? { getAttribute: (name: string) => (name === "src" ? ENTRY : null) }
        : null,
    goTo(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      act(() => {
        target.dispatchEvent(new Event("visibilitychange"));
      });
    },
  });
  return doc;
}

const realLocation = window.location;
let reload: ReturnType<typeof vi.fn>;
let stop: (() => void) | undefined;

function watch(opts: { controlled?: boolean } = {}) {
  const container = fakeContainer(opts);
  const doc = fakeDoc();
  stop = startUpdateWatch({
    container: container as unknown as ServiceWorkerContainer,
    doc: doc as unknown as Document,
  });
  return { container, doc };
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...realLocation, reload },
  });
  vi.mocked(api).mockReset();
  vi.mocked(api).mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  stop?.();
  stop = undefined;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: realLocation,
  });
});

const CHECK = { type: "check-update", entry: ENTRY };

describe("startUpdateWatch", () => {
  it("启动就问一次，带上页面正在跑的入口脚本", () => {
    const { container } = watch();

    expect(container.postMessage).toHaveBeenCalledWith(CHECK);
    expect(container.startMessages).toHaveBeenCalled();
  });

  it("回到前台再问；切到后台不问", () => {
    const { container, doc } = watch();
    container.postMessage.mockClear();

    doc.goTo("hidden");
    expect(container.postMessage).not.toHaveBeenCalled();

    doc.goTo("visible");
    expect(container.postMessage).toHaveBeenCalledWith(CHECK);
  });

  it("页面还没被 SW 接管（首次安装）时不问也不抛", () => {
    expect(() => watch({ controlled: false })).not.toThrow();
  });
});

describe("提示条", () => {
  it("收到 update-available 才出「控制台有新版本 · 重新加载」；不强制刷新", () => {
    const { container } = watch();
    render(<UpdateAvailableBar />);
    expect(screen.queryByText("控制台有新版本")).toBeNull();

    container.deliver({ type: "something-else" });
    expect(screen.queryByText("控制台有新版本")).toBeNull();

    container.deliver({ type: "update-available" });
    expect(screen.getByText("控制台有新版本")).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });

  it("点「重新加载」才 reload", () => {
    const { container } = watch();
    render(<UpdateAvailableBar />);
    container.deliver({ type: "update-available" });

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("可关闭；下次回到前台再出（页面仍是旧的）", () => {
    const { container, doc } = watch();
    render(<UpdateAvailableBar />);
    container.deliver({ type: "update-available" });

    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("控制台有新版本")).toBeNull();

    doc.goTo("hidden");
    expect(screen.queryByText("控制台有新版本")).toBeNull();
    doc.goTo("visible");
    expect(screen.getByText("控制台有新版本")).toBeTruthy();
  });

  it("两颗按钮的点按区都不小于 44px", () => {
    const { container } = watch();
    render(<UpdateAvailableBar />);
    container.deliver({ type: "update-available" });

    for (const name of ["重新加载", "关闭提示"]) {
      expect(screen.getByRole("button", { name }).className).toMatch(
        /\b(h-11|min-h-11|size-11)\b/,
      );
    }
  });
});

describe("外壳里的提示条", () => {
  function renderShell(ui: React.ReactElement) {
    return render(
      <MemoryRouter initialEntries={["/chat"]}>
        <ThemeProvider>{ui}</ThemeProvider>
      </MemoryRouter>,
    );
  }

  it("外壳自己画页头的页：提示条在外壳里", () => {
    const { container } = watch();
    renderShell(<AppShell title="Devices">page content</AppShell>);
    container.deliver({ type: "update-available" });

    const shell = screen.getByTestId("app-shell");
    expect(within(shell).getByText("控制台有新版本")).toBeTruthy();
  });

  it("页面自己画页头的手机页：提示条照样出、按得到", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...matchMedia(query),
      matches: query.includes("max-width"),
    })) as typeof window.matchMedia;
    try {
      const { container } = watch();
      renderShell(<AppShell ownHeader>page content</AppShell>);
      container.deliver({ type: "update-available" });

      fireEvent.click(
        within(screen.getByTestId("app-shell")).getByRole("button", {
          name: "重新加载",
        }),
      );
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      window.matchMedia = matchMedia;
    }
  });
});

describe("版本不符横幅的「重新加载」", () => {
  function renderBanner(detail: string) {
    return render(
      <MemoryRouter>
        <SessionStatusBanner
          status="protocolMismatch"
          protocolMismatchDetail={detail}
          onStartNew={() => {}}
        />
      </MemoryRouter>,
    );
  }

  it("页面旧的那一方向（控制台更新后即可连接）：给「重新加载」，按下 reload", () => {
    renderBanner(
      'peer speaks wire protocol version "0.3.0", this build speaks "0.4.0"; both ends must run the same release',
    );

    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("机器旧：重新加载救不了，照旧只给设备页", () => {
    renderBanner(
      'peer speaks wire protocol version "0.5.0", this build speaks "0.4.0"; both ends must run the same release',
    );

    expect(screen.queryByRole("button", { name: "重新加载" })).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
  });
});
