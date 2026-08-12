/**
 * 审计页（Pencil 正式画板 bKvB4）：
 *
 * 忠实呈现正式信息层级——TopBar 标题、筛选行、事件表卡、右列凭证卡；但审计后端
 * 当前不存在（范围外），所以：
 *   - 事件表、凭证区都只给诚实空态（EmptyState），不显示示例事件/IP/令牌/时间；
 *   - 筛选 chips 用共享 FilterChip 的 disabled 形态（无真实筛选能力 → 非按钮、
 *     aria-disabled、不进焦点序），不冒充可用筛选；
 *   - 不渲染 CSV 导出 / 撤销单个凭证 / 忽略告警等无后端假动作；
 *   - 不渲染画板里的「这里记什么」旁白卡；
 *   - 桌面双栏、移动单列（flex-col → lg:flex-row），颜色全走语义 token。
 *
 * 文案断言统一走 i18n.t()：新增审计文案键后测试仍成立，不硬编码具体文案。
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import Audit from "@/pages/Audit";
import { api } from "@/lib/api";
import i18n from "@/i18n";
import { ThemeProvider } from "@/lib/theme";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockedApi = vi.mocked(api);

const originalMatchMedia = window.matchMedia;

/** 把视口 mock 成移动（≤767px）。仅这一条查询匹配，其它（如深色偏好）不匹配。 */
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

beforeEach(async () => {
  await i18n.changeLanguage("en");
  mockedApi.mockReset();
  // 审计无后端；外壳的锦上添花数据（follows/devices/me）也一律失败 → 无数据态。
  mockedApi.mockRejectedValue(new Error("network down"));
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
});

function renderAudit() {
  return render(
    <MemoryRouter>
      <Audit />
    </MemoryRouter>,
    { wrapper: ThemeProvider },
  );
}

describe("Audit（bKvB4）正式页面层级", () => {
  it("TopBar title 槽显示页面标题（nav.audit）——SideNav 也有一个「Audit」导航项，必须限定在 banner 内", async () => {
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText(i18n.t("nav.audit"))).toBeTruthy();
  });

  it("事件表与凭证区都是诚实空态（共享 EmptyState）", async () => {
    renderAudit();
    const events = await screen.findByTestId("audit-events-empty");
    const credentials = screen.getByTestId("audit-credentials-empty");
    // EmptyState 的图标圈 + 标题都在（诚实空态可被辅助技术识别）。
    expect(within(events).getByTestId("empty-icon")).toBeTruthy();
    expect(
      within(events).getByText(i18n.t("audit.events.emptyTitle")),
    ).toBeTruthy();
    expect(within(credentials).getByTestId("empty-icon")).toBeTruthy();
    expect(
      within(credentials).getByText(i18n.t("audit.credentials.emptyTitle")),
    ).toBeTruthy();
  });

  it("筛选行呈现 bKvB4 的筛选信息层级，但全部是共享 FilterChip 的 disabled 形态（诚实：无筛选能力，不是按钮、aria-disabled、不进焦点序）", async () => {
    renderAudit();
    for (const id of [
      "audit-filter-all",
      "audit-filter-device-auth",
      "audit-filter-token",
      "audit-filter-revoke",
    ]) {
      const chip = await screen.findByTestId(id);
      // disabled 形态：非按钮（span）、aria-disabled=true。
      expect(chip.tagName).toBe("SPAN");
      expect(chip.getAttribute("aria-disabled")).toBe("true");
      expect(chip.getAttribute("tabindex")).toBeNull();
    }
    // 它们不是可点按钮，不冒充可用筛选。
    expect(
      screen.queryByRole("button", { name: i18n.t("audit.filters.all") }),
    ).toBeNull();
  });

  it("事件表列头（时间/事件/对象/来源/结果）保留 bKvB4 表头层级", async () => {
    renderAudit();
    for (const key of [
      "audit.table.time",
      "audit.table.event",
      "audit.table.object",
      "audit.table.source",
      "audit.table.result",
    ]) {
      expect(screen.getByText(i18n.t(key))).toBeTruthy();
    }
  });
});

describe("Audit 双语渲染：en 与 zh-CN 都输出翻译文案而非原始 audit.* 键", () => {
  it("zh-CN：页面渲染中文产品文案，正文不含任何原始 audit.* 键", async () => {
    await i18n.changeLanguage("zh-CN");
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    // 筛选、表头、空态标题、凭证卡标题都应是中文文案（缺键 fallback 会输出键本身）。
    expect(screen.getByText("全部")).toBeTruthy();
    expect(screen.getByText("时间")).toBeTruthy();
    expect(screen.getByText("暂无审计事件")).toBeTruthy();
    expect(screen.getByText("活跃凭证")).toBeTruthy();
    expect(screen.getByText("暂无活跃凭证")).toBeTruthy();
    // 原始键（形如 audit.filters.* / audit.credentials.*）绝不作为可见文本出现。
    expect(screen.queryByText(/audit\./)).toBeNull();
    expect(document.body.textContent).not.toContain("audit.filters");
    expect(document.body.textContent).not.toContain("audit.credentials");
  });

  it("en：页面渲染英文产品文案，正文不含任何原始 audit.* 键", async () => {
    await i18n.changeLanguage("en");
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    expect(screen.getByText("All")).toBeTruthy();
    expect(screen.getByText("Time")).toBeTruthy();
    expect(screen.getByText("No audit events yet")).toBeTruthy();
    expect(screen.getByText("Active credentials")).toBeTruthy();
    expect(screen.getByText("No active credentials")).toBeTruthy();
    expect(screen.queryByText(/audit\./)).toBeNull();
    expect(document.body.textContent).not.toContain("audit.filters");
    expect(document.body.textContent).not.toContain("audit.credentials");
  });
});

describe("Audit 诚实边界：无假数据、无假动作、无旁白", () => {
  it("不显示示例事件/IP/令牌/设备名/时间（设计稿样本一个都不进 UI）", async () => {
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    for (const sample of [
      "书房 Mac mini",
      "203.0.113.7",
      "198.51.100.24",
      "MacBook Pro",
      "agentre/0.4.2",
      "指纹 a91f2c",
      "Token refresh",
      "Old token replay",
    ]) {
      expect(screen.queryByText(sample)).toBeNull();
    }
  });

  it("无 CSV 导出 / 撤销凭证 / 忽略告警等无后端假动作按钮", async () => {
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    expect(screen.queryByRole("button", { name: /export/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /csv/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /revoke/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /ignore/i })).toBeNull();
  });

  it("无「这里记什么」旁白卡及其范围解释", async () => {
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    expect(screen.queryByText(/这里记什么|What goes here/i)).toBeNull();
    expect(screen.queryByText(/服务端不留|agent.*local/i)).toBeNull();
  });
});

describe("Audit 桌面 / 移动结构", () => {
  it("桌面：双栏容器（左事件区 + 右 320px 凭证区）", async () => {
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    expect(screen.getByTestId("audit-credentials-empty")).toBeTruthy();
    const body = screen.getByTestId("audit-body");
    // 移动优先单列 → 桌面 lg 断点转双栏（CSS 契约）。
    expect(body.className).toContain("flex-col");
    expect(body.className).toContain("lg:flex-row");
    const aside = screen.getByTestId("audit-credentials");
    expect(aside.className).toContain("lg:w-[320px]");
  });

  it("移动：单列堆叠（flex-col），事件区与凭证区都在，无横向双栏", async () => {
    mockMobileViewport();
    renderAudit();
    await screen.findByTestId("audit-events-empty");
    expect(screen.getByTestId("audit-credentials-empty")).toBeTruthy();
    const body = screen.getByTestId("audit-body");
    // 移动优先单列 → 桌面 lg 断点转双栏（CSS 契约，不依赖外壳移动形态）。
    expect(body.className).toContain("flex-col");
    expect(body.className).toContain("lg:flex-row");
  });
});
