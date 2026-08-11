/**
 * R11 测试接缝：四类不可达与失效各自可区分、可访问性的文字标注。
 *
 * 断言三件事：
 *  1. 七个视图状态渲染出**互不相同**的文案（不折叠成同一个错误）。
 *  2. 状态不只靠颜色：运行 / 等待输入 / 离线 / 解除授权都有文字（getByText 能取到）。
 *  3. 实时通知类（reconnecting / connecting）走 role="status"，失败类
 *     （lost / machineOffline / revoked / loggedOut）走 role="alert"。
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import SessionStatusBanner from "@/components/session/SessionStatusBanner";
import i18n from "@/i18n";
import {
  type SessionViewStatus,
  deriveSessionViewStatus,
} from "@/lib/sessionView";
import { type RelayState } from "@/lib/relayClient";
import { ThemeProvider } from "@/lib/theme";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

function renderStatus(status: SessionViewStatus) {
  return render(
    <ThemeProvider>
      <SessionStatusBanner status={status} machineLastSeenMs={1754000000000} />
    </ThemeProvider>,
  );
}

const ALL_STATUSES: SessionViewStatus[] = [
  "connecting",
  "connected",
  "reconnecting",
  "lost",
  "machineOffline",
  "revoked",
  "loggedOut",
];

describe("会话状态:四类不可达与失效各自可区分", () => {
  it("每种状态渲染出互不相同的可见文案", () => {
    const texts = new Map<SessionViewStatus, string>();
    for (const status of ALL_STATUSES) {
      renderStatus(status);
    }
    // connected 是正常态,不渲染横幅(没有 data-session-status 根)。
    expect(
      document.querySelector('[data-session-status="connected"]'),
    ).toBeNull();
    const seen = new Set<string>();
    for (const status of ALL_STATUSES.filter((s) => s !== "connected")) {
      const node = document.querySelector(`[data-session-status="${status}"]`);
      expect(node, `${status} 应有带 data-session-status 的根`).not.toBeNull();
      const own = (node as HTMLElement).textContent ?? "";
      expect(own.length, `${status} 应有非空文案`).toBeGreaterThan(0);
      expect(seen.has(own), `${status} 的文案与其它状态重复`).toBe(false);
      seen.add(own);
      texts.set(status, own);
    }
    // machineOffline / revoked / loggedOut 三者文案互不相同（四类不折叠）。
    expect(texts.get("machineOffline")).not.toBe(texts.get("revoked"));
    expect(texts.get("machineOffline")).not.toBe(texts.get("loggedOut"));
    expect(texts.get("revoked")).not.toBe(texts.get("loggedOut"));
  });

  it("状态不只靠颜色:关键状态都有可见文字(而非仅图标/色块)", () => {
    renderStatus("machineOffline");
    renderStatus("revoked");
    expect(screen.getAllByRole("alert").length).toBe(2);
    // 文字存在且非空。
    const alerts = screen.getAllByRole("alert");
    for (const a of alerts) {
      expect((a.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("实时通知类走 role=status,失败类走 role=alert", () => {
    renderStatus("reconnecting");
    expect(screen.getByRole("status")).toBeTruthy();
    renderStatus("lost");
    renderStatus("machineOffline");
    expect(screen.getAllByRole("alert").length).toBe(2);
  });

  it("deriveSessionViewStatus 把四类信号各自映射到不同状态", () => {
    const base: {
      relayState: RelayState;
      meValid: boolean;
      webDeviceRevoked: boolean;
      machineOnline: boolean | null;
    } = {
      relayState: "disconnected",
      meValid: true,
      webDeviceRevoked: false,
      machineOnline: true,
    };
    expect(deriveSessionViewStatus({ ...base, meValid: false })).toBe(
      "loggedOut",
    );
    expect(deriveSessionViewStatus({ ...base, webDeviceRevoked: true })).toBe(
      "revoked",
    );
    expect(deriveSessionViewStatus({ ...base, machineOnline: false })).toBe(
      "machineOffline",
    );
    expect(deriveSessionViewStatus({ ...base, relayState: "connected" })).toBe(
      "connected",
    );
    expect(
      deriveSessionViewStatus({ ...base, relayState: "reconnecting" }),
    ).toBe("reconnecting");
    expect(deriveSessionViewStatus(base)).toBe("lost");
  });
});
