import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { SessionBackLink } from "@/components/session/SessionDetailHeader";

/**
 * 手机会话页左上角的返回（2026-11-19 手机形态排查）。
 *
 * 它此前是一个 `<Link to="/chat…">`：每点一次返回都**压一格**列表进历史，历史变成
 * 列表 → 对话 → 列表 → 对话……之后系统的侧滑返回 / 安卓返回键会把人带回刚离开的那条
 * 对话。手机页头的其余返回（MobileNav 的 useMobileBack）早已是「有本站历史就退一格」。
 */
const originalMatchMedia = window.matchMedia;

function mockMobileViewport() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width: 767px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  return (
    <>
      <div data-testid="where">{location.pathname + location.search}</div>
      <div data-testid="nav-type">{type}</div>
    </>
  );
}

function renderBack(entries: string[]) {
  render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <SessionBackLink to="/chat?axis=agent&agent=a1" />
      <Where />
    </MemoryRouter>,
  );
  return screen.getByRole("link", { name: "Back" });
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  window.history.replaceState(null, "");
});

describe("SessionBackLink", () => {
  it("Given 手机上从列表点进来, When 点返回, Then 退回历史上一格而不是再压一格列表", () => {
    mockMobileViewport();
    window.history.replaceState({ idx: 1 }, "");
    const back = renderBack(["/chat?axis=agent&agent=a1", "/chat/c-1"]);

    fireEvent.click(back);

    expect(screen.getByTestId("where").textContent).toBe(
      "/chat?axis=agent&agent=a1",
    );
    expect(screen.getByTestId("nav-type").textContent).toBe("POP");
  });

  it("Given 手机上直接打开深链（没有本站历史）, When 点返回, Then 原地换成列表，不把人带出本站", () => {
    mockMobileViewport();
    window.history.replaceState({ idx: 0 }, "");
    const back = renderBack(["/chat/c-1"]);

    fireEvent.click(back);

    expect(screen.getByTestId("where").textContent).toBe(
      "/chat?axis=agent&agent=a1",
    );
    expect(screen.getByTestId("nav-type").textContent).toBe("REPLACE");
  });

  it("Given 桌面, When 点返回, Then 仍是一个普通链接", () => {
    window.history.replaceState({ idx: 1 }, "");
    const back = renderBack(["/chat?axis=agent&agent=a1", "/chat/c-1"]);

    fireEvent.click(back);

    expect(screen.getByTestId("nav-type").textContent).toBe("PUSH");
  });
});
