/**
 * 手机上的「步骤」进历史（规格 2026-11-25 D2）：添加设备的各步骤有自己的历史项，
 * 系统返回回到上一步、最后回到列表；从界面（✕）关闭则把压进去的几条一并退掉，
 * 历史不会越点越长。用 MemoryRouter 的 navigate(-1) 当「系统返回」。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ThemeProvider } from "@agentre-hub/agentre-ui";

import { AddDeviceGuide } from "@/components/AddDeviceGuide";
import i18n from "@/i18n";

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

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="path">{location.pathname}</span>
      <button onClick={() => navigate(-1)}>system-back</button>
    </>
  );
}

function Host() {
  const [open, setOpen] = useState(true);
  return open ? (
    <AddDeviceGuide compact onClose={() => setOpen(false)} />
  ) : (
    <p data-testid="list">list</p>
  );
}

function renderGuide() {
  return render(
    <MemoryRouter initialEntries={["/prev", "/devices"]} initialIndex={1}>
      <ThemeProvider>
        <Probe />
        <Host />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const back = () => fireEvent.click(screen.getByText("system-back"));
const stepOf = () =>
  screen.getByTestId("add-device-step-body").querySelector("h2, h3, p")
    ?.textContent;

describe("添加设备各步骤进历史（D2）", () => {
  it("系统返回逐步回到上一步，第 1 步再返回回到列表而不是离开设备页", async () => {
    setViewport(true);
    renderGuide();
    const first = stepOf();
    fireEvent.click(
      screen.getByRole("button", { name: /I have the device code/ }),
    );
    await waitFor(() => expect(stepOf()).not.toBe(first));
    const second = stepOf();

    back();
    await waitFor(() => expect(stepOf()).toBe(first));
    expect(screen.getByTestId("path").textContent).toBe("/devices");

    back();
    await waitFor(() => expect(screen.getByTestId("list")).toBeTruthy());
    expect(screen.getByTestId("path").textContent).toBe("/devices");
    expect(second).not.toBe(first);
  });

  it("走到第 2 步后点 ✕：压进去的几条一并退掉，再返回就是上一页", async () => {
    setViewport(true);
    renderGuide();
    fireEvent.click(
      screen.getByRole("button", { name: /I have the device code/ }),
    );
    await waitFor(() => expect(screen.getByTestId("add-device-step-body")));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByTestId("list")).toBeTruthy());
    back();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });

  it("从步骤条一下跳到第 3 步：返回仍是 3 → 2 → 1 → 列表，✕ 退掉三层", async () => {
    setViewport(true);
    renderGuide();
    const first = stepOf();
    fireEvent.click(screen.getByRole("button", { name: /^Step 3:/ }));
    await waitFor(() => expect(stepOf()).not.toBe(first));
    const third = stepOf();

    back();
    await waitFor(() => expect(stepOf()).not.toBe(third));
    const second = stepOf();
    expect(second).not.toBe(first);
    back();
    await waitFor(() => expect(stepOf()).toBe(first));
    back();
    await waitFor(() => expect(screen.getByTestId("list")).toBeTruthy());
    expect(screen.getByTestId("path").textContent).toBe("/devices");
  });

  it("第 3 步点 ✕：三层记号都退掉，再返回就是上一页", async () => {
    setViewport(true);
    renderGuide();
    fireEvent.click(screen.getByRole("button", { name: /^Step 3:/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByTestId("list")).toBeTruthy());
    back();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });

  it("桌面宽度不碰历史", async () => {
    setViewport(false);
    renderGuide();
    fireEvent.click(
      screen.getByRole("button", { name: /I have the device code/ }),
    );
    back();
    expect(screen.getByTestId("path").textContent).toBe("/prev");
  });
});
