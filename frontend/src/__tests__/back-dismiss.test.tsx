/**
 * 手机上的浮层进历史（规格 2026-11-25 D1）：浮层开着时历史里有一条它的记号，
 * 系统返回退掉这一条 = 关浮层、停在原页；从界面关掉浮层则把这一条退掉，历史不变长。
 * 用 MemoryRouter 的 navigate(-1) 当「系统返回」。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { vi } from "vitest";
import { ThemeProvider, TouchProvider } from "@agentre-hub/agentre-ui";

import i18n from "@/i18n";
import SessionDetailHeader from "@/components/session/SessionDetailHeader";
import type { MirrorIndexRow } from "@/pages/chat/chatRows";
import { PhoneChatIndex } from "@/pages/chat/PhoneChatIndex";
import { PhoneScopeSheet } from "@/pages/chat/PhoneScopeSheet";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useBackDismiss } from "@/hooks/use-back-dismiss";

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

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function Overlay({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  useBackDismiss(open, () => setOpen(false));
  return (
    <div>
      <button onClick={() => setOpen(true)}>open-{name}</button>
      {open && (
        <div data-testid={`overlay-${name}`}>
          <button onClick={() => setOpen(false)}>close-{name}</button>
        </div>
      )}
    </div>
  );
}

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  const type = useNavigationType();
  return (
    <div>
      <span data-testid="path">{location.pathname}</span>
      <span data-testid="navtype">{type}</span>
      <button onClick={() => navigate(-1)}>system-back</button>
      <button onClick={() => navigate("/other")}>go-other</button>
      <button onClick={() => navigate("/page?x=1", { replace: true })}>
        replace-self
      </button>
    </div>
  );
}

function renderPage(names: string[] = ["a"]) {
  return render(
    <MemoryRouter initialEntries={["/prev", "/page"]} initialIndex={1}>
      <Probe />
      {names.map((n) => (
        <Overlay key={n} name={n} />
      ))}
    </MemoryRouter>,
  );
}

const path = () => screen.getByTestId("path").textContent;
const back = () => fireEvent.click(screen.getByText("system-back"));

describe("useBackDismiss", () => {
  it("手机：系统返回关掉浮层并停在原页", () => {
    setViewport(true);
    renderPage();
    fireEvent.click(screen.getByText("open-a"));
    expect(screen.getByTestId("overlay-a")).toBeTruthy();
    back();
    expect(screen.queryByTestId("overlay-a")).toBeNull();
    expect(path()).toBe("/page");
  });

  it("手机：从界面关浮层把记号退掉，历史不变长（再返回直接回上一页）", () => {
    setViewport(true);
    renderPage();
    fireEvent.click(screen.getByText("open-a"));
    fireEvent.click(screen.getByText("close-a"));
    expect(screen.queryByTestId("overlay-a")).toBeNull();
    expect(path()).toBe("/page");
    back();
    expect(path()).toBe("/prev");
  });

  it("手机：嵌套的浮层由内向外逐层关", () => {
    setViewport(true);
    renderPage(["a", "b"]);
    fireEvent.click(screen.getByText("open-a"));
    fireEvent.click(screen.getByText("open-b"));
    back();
    expect(screen.queryByTestId("overlay-b")).toBeNull();
    expect(screen.getByTestId("overlay-a")).toBeTruthy();
    back();
    expect(screen.queryByTestId("overlay-a")).toBeNull();
    expect(path()).toBe("/page");
    back();
    expect(path()).toBe("/prev");
  });

  it("手机：浮层开着时路由换走，浮层跟着收起，也不再多退一格", () => {
    setViewport(true);
    renderPage();
    fireEvent.click(screen.getByText("open-a"));
    fireEvent.click(screen.getByText("go-other"));
    expect(path()).toBe("/other");
    expect(screen.queryByTestId("overlay-a")).toBeNull();
    expect(path()).toBe("/other");
  });

  it("手机：浮层开着时页面 replace 了地址，浮层留着，返回键仍先关浮层", () => {
    setViewport(true);
    renderPage();
    fireEvent.click(screen.getByText("open-a"));
    fireEvent.click(screen.getByText("replace-self"));
    expect(screen.getByTestId("overlay-a")).toBeTruthy();
    back();
    expect(screen.queryByTestId("overlay-a")).toBeNull();
    expect(path()).toBe("/page");
    // replace 没有多留一条：再返回直接回上一页。
    back();
    expect(path()).toBe("/prev");
  });

  it("桌面：不碰历史，开关浮层都不产生导航", () => {
    setViewport(false);
    renderPage();
    fireEvent.click(screen.getByText("open-a"));
    expect(screen.getByTestId("navtype").textContent).toBe("POP");
    fireEvent.click(screen.getByText("close-a"));
    expect(screen.getByTestId("navtype").textContent).toBe("POP");
    act(() => back());
    expect(path()).toBe("/prev");
  });
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <MemoryRouter initialEntries={["/prev", "/chat"]} initialIndex={1}>
      <ThemeProvider>
        <TouchProvider touch>
          <Probe />
          {children}
        </TouchProvider>
      </ThemeProvider>
    </MemoryRouter>
  );
}

describe("各处浮层接上了返回键", () => {
  it("范围弹层：系统返回关掉它，停在原页", () => {
    setViewport(true);
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>show-scope</button>
          <PhoneScopeSheet
            open={open}
            onOpenChange={setOpen}
            tab="project"
            onTabChange={() => {}}
            selected={{ kind: "all" }}
            projects={[]}
            agentGroups={[]}
            machines={[]}
            onSelect={() => {}}
          />
        </>
      );
    }
    render(
      <Shell>
        <Host />
      </Shell>,
    );
    fireEvent.click(screen.getByText("show-scope"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    back();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(path()).toBe("/chat");
  });

  it("对话信息：系统返回关掉它，停在原页", () => {
    setViewport(true);
    render(
      <Shell>
        <SessionDetailHeader
          isPage
          immersive
          sid="s1"
          identity={null}
          agent={null}
          agentPending={false}
          project={null}
          displayTitle="标题"
          machineName="box"
          machineOnline
          status="connected"
          running={false}
          decisionPending={false}
          stopping={false}
        />
      </Shell>,
    );
    fireEvent.click(screen.getByTestId("session-detail-menu-trigger"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    back();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(path()).toBe("/chat");
  });

  function renderIndex(rows: MirrorIndexRow[] = []) {
    const noop = vi.fn();
    function Host() {
      const [q, setQ] = useState("");
      return (
        <PhoneChatIndex
          scopeKey="all"
          scopeTitle="All"
          subtitle={{ text: "" }}
          onOpenScope={noop}
          onCompose={noop}
          searchQuery={q}
          onSearchChange={setQ}
          searchCount={0}
          settled
          rows={rows}
          filter="all"
          onFilterChange={noop}
          counts={{ attention: 0, running: 0, unread: 0 }}
          agents={[]}
          projects={[]}
          hideAgent={false}
          sessionPath={() => "/chat/x"}
          stopTurnOf={() => undefined}
          filterAgentOf={() => undefined}
          filterMachineOf={() => undefined}
          onDelete={noop}
          onSave={noop}
          hasOnlineMachine
          onFindOnMachine={noop}
          hasMore={false}
          loadingMore={false}
          loadMoreFailed={false}
          onLoadMore={noop}
        />
      );
    }
    return render(
      <Shell>
        <Host />
      </Shell>,
    );
  }

  it("搜索态：系统返回退出搜索，停在原页", () => {
    setViewport(true);
    renderIndex();
    fireEvent.click(
      screen.getByRole("button", { name: "Search conversation titles" }),
    );
    expect(screen.getByRole("searchbox")).toBeTruthy();
    back();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(path()).toBe("/chat");
  });

  it("搜索态：点「取消」后焦点落回搜索键（触发它的控件已卸载过一次）", () => {
    setViewport(true);
    renderIndex();
    const search = screen.getByRole("button", {
      name: "Search conversation titles",
    });
    fireEvent.click(search);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Search conversation titles" }),
    );
    // 取消把记号退掉了：再返回回到上一页。
    back();
    expect(path()).toBe("/prev");
  });

  // 长按菜单（D1 / I1 收尾）：菜单是 Radix 的，自己不进历史；宿主用包的
  // onMenuOpenChange 登记记号，返回键走 menuOpen={false} 关掉它。
  const phoneRow = (key: string, title: string) =>
    ({
      key,
      id: key,
      conversationId: key,
      sessionId: 0,
      title,
      lifecycleState: "idle",
      updatedAt: Date.now(),
      machineFingerprint: "fp",
      deviceId: 1,
      saved: true,
    }) as unknown as MirrorIndexRow;

  function longPress(title: string) {
    fireEvent.contextMenu(screen.getByText(title));
  }

  it("长按菜单：系统返回只关菜单，停在原页", async () => {
    setViewport(true);
    renderIndex([phoneRow("a", "第一条")]);
    expect(path()).toBe("/chat");
    longPress("第一条");
    expect(screen.getByRole("menu")).toBeTruthy();
    back();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(path()).toBe("/chat");
    // 记号已被返回键用掉：再返回才是上一页。
    back();
    expect(path()).toBe("/prev");
  });

  it("长按菜单：选一项关菜单后记号退掉，历史不变长", async () => {
    setViewport(true);
    renderIndex([phoneRow("a", "第一条")]);
    longPress("第一条");
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete/i }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(path()).toBe("/chat");
    back();
    expect(path()).toBe("/prev");
  });

  it("长按菜单：先后长按两行，各行菜单各自开关，返回一次只收最后那个", async () => {
    setViewport(true);
    renderIndex([phoneRow("a", "第一条"), phoneRow("b", "第二条")]);
    longPress("第一条");
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    longPress("第二条");
    await waitFor(() => expect(screen.getAllByRole("menu")).toHaveLength(1));
    back();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(path()).toBe("/chat");
    back();
    expect(path()).toBe("/prev");
  });

  it("桌面宽度：长按菜单不碰历史", async () => {
    setViewport(false);
    renderIndex([phoneRow("a", "第一条")]);
    longPress("第一条");
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // 没压过记号：一次返回就回上一页。
    back();
    expect(path()).toBe("/prev");
  });

  it("长按菜单贴在被按的那一行下方（包的锚定记号），行是 44px 触屏档", () => {
    setViewport(true);
    renderIndex([phoneRow("a", "第一条")]);
    longPress("第一条");
    const menu = screen.getByRole("menu");
    expect(menu.dataset.slot).toBe("context-menu-content");
    // 锚定过的菜单带 data-anchor-side（jsdom 量位置全是 0，只认包写的这一记号）。
    expect(["below", "above"]).toContain(menu.dataset.anchorSide);
    for (const item of screen.getAllByRole("menuitem"))
      expect(item.className).toContain("min-h-11");
  });
});
