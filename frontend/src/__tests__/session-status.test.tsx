/**
 * 状态横幅（规格 2026-08-21「连接态与失败态」决策 1 / 3 / 4 / 17）。
 *
 * 断言的是**三档形态**，不再是「九个状态各一段红字」：
 *  A 瞬态自愈（connecting / reconnecting）—— 横幅一个字都不渲染，它搬去了详情头部。
 *  B 阻断可恢复（lost / machineOffline / desktopAppNotRunning /
 *    pinnedAgentredUnavailable）—— 结论 + 后果 + 至多一个出口。
 *  C 终态只读（deviceRevoked / loggedOut）—— 中性色，loggedOut 就地给「重新登录」。
 *
 * 仍然钉住此前那两条不变量：每个状态的文案互不相同（不折叠成同一个错误），
 * 状态不只靠颜色（每一档都有可见文字 + 图标）。
 */
import { statusConfig, type AgentStatus } from "@agentre-hub/agentre-ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SessionConnectionIndicator from "@/components/session/SessionConnectionIndicator";
import SessionStatusBanner, {
  tierOf,
} from "@/components/session/SessionStatusBanner";
import i18n from "@/i18n";
import {
  type SessionViewStatus,
  classifySendFailure,
  computeContextUsage,
  deriveSessionViewStatus,
  formatRelativeTime,
  formatTokens,
  matchesRowSearch,
  matchesSessionFilter,
  sessionTitle,
  statusDotClass,
} from "@/lib/sessionView";
import { RelayError, type RelayState } from "@/lib/relayClient";
import { ThemeProvider } from "@agentre-hub/agentre-ui";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

// 有一条用例会把时钟冻住来断言相对时间。它一旦在断言处抛出，假时钟就留在了后面
// 每一条用例上——失败会从那一条一路串到文件末尾，真正的红点被埋掉。
afterEach(() => {
  vi.useRealTimers();
});

const NOW = 1754000000000;

/**
 * 「机器离线」那一档的文案归共享包所有（组件走 `useUiTranslation()` =
 * `agentreUi` namespace），所以断言也去问包，而不是问本站的 `translation`。
 */
const uiText = (key: string, vars?: Record<string, string>) =>
  i18n.t(key, { ns: "agentreUi", ...vars });

function renderStatus(
  status: SessionViewStatus,
  props: Partial<React.ComponentProps<typeof SessionStatusBanner>> = {},
) {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <SessionStatusBanner status={status} onStartNew={() => {}} {...props} />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 一个状态的横幅根（渲染出来才有）。 */
function bannerOf(status: SessionViewStatus): HTMLElement | null {
  return document.querySelector(`[data-session-status="${status}"]`);
}

const ALL_STATUSES: SessionViewStatus[] = [
  "connecting",
  "connected",
  "reconnecting",
  "lost",
  "machineOffline",
  "desktopAppNotRunning",
  "pinnedAgentredUnavailable",
  "deviceRevoked",
  "loggedOut",
];

/** 会渲染出横幅的那些（A 档与正常态都不渲染）。 */
const BANNER_STATUSES: SessionViewStatus[] = [
  "lost",
  "machineOffline",
  "desktopAppNotRunning",
  "pinnedAgentredUnavailable",
  "deviceRevoked",
  "loggedOut",
];

describe("状态横幅:三档形态", () => {
  it("tierOf 把九个状态分成三档:正常态没有档", () => {
    expect(tierOf("connected")).toBeNull();
    expect(tierOf("connecting")).toBe("transient");
    expect(tierOf("reconnecting")).toBe("transient");
    for (const status of [
      "lost",
      "machineOffline",
      "desktopAppNotRunning",
      "pinnedAgentredUnavailable",
    ] as SessionViewStatus[]) {
      expect(tierOf(status), status).toBe("blocking");
    }
    expect(tierOf("deviceRevoked")).toBe("final");
    expect(tierOf("loggedOut")).toBe("final");
  });

  it("A 档与正常态一个字都不渲染——过程态不占内容区(决策 2)", () => {
    for (const status of [
      "connected",
      "connecting",
      "reconnecting",
    ] as SessionViewStatus[]) {
      const { container } = renderStatus(status);
      expect(container.firstChild, `${status} 不该渲染横幅`).toBeNull();
    }
  });

  it("每个横幅都有标题 + 说明两段,且标题互不相同", () => {
    const titles = new Set<string>();
    for (const status of BANNER_STATUSES) {
      renderStatus(status, { machineName: "mac-mini" });
      const root = bannerOf(status);
      expect(root, `${status} 应有带 data-session-status 的根`).not.toBeNull();
      const title = within(root as HTMLElement).getByTestId(
        "status-banner-title",
      );
      const body = within(root as HTMLElement).getByTestId(
        "status-banner-body",
      );
      expect(title.textContent?.trim(), `${status} 标题不该为空`).toBeTruthy();
      expect(body.textContent?.trim(), `${status} 说明不该为空`).toBeTruthy();
      expect(
        titles.has(title.textContent as string),
        `${status} 的标题与别的状态重复`,
      ).toBe(false);
      titles.add(title.textContent as string);
    }
  });

  it("状态不只靠颜色:每一档都有图标 + 可见文字,图标对读屏隐藏", () => {
    for (const status of BANNER_STATUSES) {
      renderStatus(status);
      const root = bannerOf(status) as HTMLElement;
      const icon = root.querySelector("svg");
      expect(icon, `${status} 应有图标`).not.toBeNull();
      expect(
        icon?.getAttribute("aria-hidden"),
        `${status} 的图标应对读屏隐藏(文字已经说了同一件事)`,
      ).toBe("true");
      expect((root.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("B / C 两档走 role=alert + assertive(A 档已经不渲染,不再有 status 角色)", () => {
    for (const status of BANNER_STATUSES) {
      renderStatus(status);
      const root = bannerOf(status) as HTMLElement;
      expect(root.getAttribute("role"), status).toBe("alert");
      expect(root.getAttribute("aria-live"), status).toBe("assertive");
    }
  });

  /**
   * 三档在**类名**上分得开。jsdom 量不到颜色，钉的是 token 名：
   *  - 连不上 / 机器不在 = destructive 家族（需要去别处处理）
   *  - 读得了写不了      = status-waiting 家族（暂时受限，不是故障）
   *  - 终态              = 中性（secondary），既成事实不是警报
   * 三者共用一个 token 家族的话，用户就分不出「等一下」「去处理」「接受它」。
   */
  it("可自行恢复 / 需去别处 / 终态三种配色互不相同", () => {
    const cls = (status: SessionViewStatus) => {
      renderStatus(status);
      return (bannerOf(status) as HTMLElement).className;
    };
    const offline = cls("machineOffline");
    const pinned = cls("pinnedAgentredUnavailable");
    const revoked = cls("deviceRevoked");

    expect(offline).toContain("destructive");
    expect(pinned).toContain("status-waiting");
    expect(revoked).toContain("secondary");
    // 终态不得借用任何一种告警色：它不是故障。
    expect(revoked).not.toContain("destructive");
    expect(revoked).not.toContain("status-waiting");
  });

  it("横幅吸顶:往下读一屏,输入框为什么灰着的解释还在(决策 3)", () => {
    renderStatus("machineOffline");
    expect((bannerOf("machineOffline") as HTMLElement).className).toContain(
      "sticky",
    );
  });

  it("账号登出就地给「重新登录」,用的是早就写好、却从没被引用过的那个键", () => {
    renderStatus("loggedOut");
    const root = bannerOf("loggedOut") as HTMLElement;
    const link = within(root).getByRole("link", {
      name: i18n.t("session.relogin"),
    });
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("目标机不在时给「查看设备」,并且至多一个动作", () => {
    // machineOffline 不在这里：它的出口已经统一成「新建一个会话」（见下一条）。
    // 剩下这两档仍旧是「查看设备」——同一类「目标够不着」给了两种出路，是本轮
    // 没裁的口子，记在这里而不是假装它不存在。
    for (const status of [
      "desktopAppNotRunning",
      "pinnedAgentredUnavailable",
    ] as SessionViewStatus[]) {
      renderStatus(status, { machineName: "mac-mini" });
      const root = bannerOf(status) as HTMLElement;
      const actions = within(root).getByTestId("status-banner-action");
      expect(actions.children.length, `${status} 至多一个动作`).toBe(1);
      expect(within(actions).getByRole("link").getAttribute("href")).toBe(
        "/devices",
      );
    }
  });

  /**
   * 「机器离线」这一档整个搬去了共享包（`MachineOfflineBanner`）：桌面端与本站
   * 原本各画过一份，说的还不是同一件事——桌面端讲「为什么不会自动换机器」，本站
   * 讲「历史还读得到、消息不会排队」。同一个用户在两端遇到同一件事得到两种解释，
   * 所以正文取并集，住进包里。本站在这里只剩「按下去往哪走」。
   */
  it("机器离线说的是包里那套并集文案,本站不再自留一份", () => {
    renderStatus("machineOffline", { machineName: "mac-mini" });
    const root = bannerOf("machineOffline") as HTMLElement;
    const body = within(root).getByTestId("status-banner-body").textContent!;
    expect(within(root).getByTestId("status-banner-title").textContent).toBe(
      uiText("sessionStatus.machineOffline.title", { machine: "mac-mini" }),
    );
    expect(body).toContain(uiText("sessionStatus.machineOffline.body"));
  });

  /**
   * 出口统一成「新建一个会话」。「查看设备」不把人往前推——横幅刚说完「离线 ·
   * 最后在线 3小时前」，点进去看到的还是那句话。
   */
  it("机器离线的出口是「新建一个会话」,按下去调的是本站接住的那个回调", () => {
    const onStartNew = vi.fn();
    renderStatus("machineOffline", { machineName: "mac-mini", onStartNew });
    const root = bannerOf("machineOffline") as HTMLElement;
    const actions = within(root).getByTestId("status-banner-action");
    expect(actions.children.length).toBe(1);
    const button = within(actions).getByRole("button", {
      name: uiText("sessionStatus.machineOffline.startNew"),
    });
    fireEvent.click(button);
    expect(onStartNew).toHaveBeenCalledOnce();
  });

  it("连接彻底断了才给「重新连接」,而且只在调用方接得住时才摆", () => {
    const onReconnect = vi.fn();
    renderStatus("lost", { onReconnect });
    const withHandler = within(bannerOf("lost") as HTMLElement).getByRole(
      "button",
    );
    withHandler.click();
    expect(onReconnect).toHaveBeenCalledOnce();

    // 没人接得住就不摆一个按下去什么都不会发生的按钮。
    renderStatus("deviceRevoked");
    expect(
      within(bannerOf("deviceRevoked") as HTMLElement).queryByRole("button"),
    ).toBeNull();
  });

  it("机器名认得出来就说出来,认不出来也不编一个占位名", () => {
    renderStatus("machineOffline", { machineName: "mac-mini" });
    expect(
      within(bannerOf("machineOffline") as HTMLElement).getByTestId(
        "status-banner-title",
      ).textContent,
    ).toContain("mac-mini");

    document.body.innerHTML = "";
    renderStatus("machineOffline");
    const generic = within(
      bannerOf("machineOffline") as HTMLElement,
    ).getByTestId("status-banner-title").textContent;
    expect(generic?.trim()).toBeTruthy();
    expect(generic).not.toContain("undefined");
  });

  /**
   * 最后在线用的是**相对**时间。此前横幅里是 `toLocaleString()` 的完整机器格式
   * （`2026/8/21 14:32:07`），而同一屏别处的时间都是「3 小时前」——两套时间口径
   * 并存，读者要自己换算。
   */
  it("最后在线跟随全站的相对时间口径,精确时刻挂在 title 上备查", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lastSeen = NOW - 3 * 3600_000;
    renderStatus("machineOffline", {
      machineName: "mac-mini",
      machineLastSeenMs: lastSeen,
    });
    const time = within(bannerOf("machineOffline") as HTMLElement).getByTestId(
      "status-banner-last-seen",
    );
    expect(time.textContent).toContain(formatRelativeTime(lastSeen, "en", NOW));
    expect(time.getAttribute("title")).toBe(
      new Date(lastSeen).toLocaleString(),
    );
    vi.useRealTimers();
  });

  it("取不到最后在线时整段不摆,不显示一个 1970 年", () => {
    renderStatus("machineOffline", { machineName: "mac-mini" });
    expect(
      within(bannerOf("machineOffline") as HTMLElement).queryByTestId(
        "status-banner-last-seen",
      ),
    ).toBeNull();
  });

  /**
   * A 档搬去了详情头部（决策 2）。横幅不渲染它之后，这个指示器就是它唯一的落点：
   * 少了它，「正在连接」这件事在屏幕上一个记号都没有。
   */
  describe("A 档:详情头部的连接指示", () => {
    const renderIndicator = (status: SessionViewStatus) =>
      render(
        <ThemeProvider>
          <SessionConnectionIndicator status={status} />
        </ThemeProvider>,
      );

    it("只认瞬态那两个:正常态与 B / C 档都不渲染(它们是横幅的事)", () => {
      for (const status of ALL_STATUSES.filter(
        (s) => tierOf(s) !== "transient",
      )) {
        const { container } = renderIndicator(status);
        expect(container.firstChild, `${status} 不该渲染指示器`).toBeNull();
      }
    });

    it("两个瞬态都有可见文字 + 会动的进度条,进度条对读屏隐藏", () => {
      for (const status of ["connecting", "reconnecting"] as const) {
        renderIndicator(status);
        const root = document.querySelector(
          `[data-session-status="${status}"]`,
        ) as HTMLElement;
        expect(root, `${status} 应有根`).not.toBeNull();
        expect((root.textContent ?? "").trim().length).toBeGreaterThan(0);
        // 进度条是芯片的**兄弟**：它要横跨整条头部底边，塞进芯片里就只有一枚
        // 小胶囊那么宽。
        const bar = screen.getByTestId("connection-progress");
        expect(bar.getAttribute("aria-hidden")).toBe("true");
        document.body.innerHTML = "";
      }
    });

    it("瞬态走 role=status + polite:它会自愈,不该抢读屏的话头", () => {
      for (const status of ["connecting", "reconnecting"] as const) {
        renderIndicator(status);
        const root = document.querySelector(
          `[data-session-status="${status}"]`,
        ) as HTMLElement;
        expect(root.getAttribute("role"), status).toBe("status");
        expect(root.getAttribute("aria-live"), status).toBe("polite");
      }
    });

    /**
     * 这一条是本轮的由头：`connecting` 与 `reconnecting` 此前走的是横幅的
     * destructive —— 每打开一条对话都要经过、几百毫秒后自己就好的状态被画成故障。
     */
    it("过程态不得用错误色:首连走 primary,重连走 status-waiting", () => {
      const cls = (status: SessionViewStatus) => {
        renderIndicator(status);
        return (
          document.querySelector(
            `[data-session-status="${status}"]`,
          ) as HTMLElement
        ).className;
      };
      const connecting = cls("connecting");
      const reconnecting = cls("reconnecting");
      expect(connecting).toContain("primary");
      expect(connecting).not.toContain("destructive");
      expect(reconnecting).toContain("status-waiting");
      expect(reconnecting).not.toContain("destructive");
      // 两者本身也要分得开：一个是「还没连上」，一个是「连上过又断了」。
      expect(connecting).not.toBe(reconnecting);
    });
  });

  it("deriveSessionViewStatus 把七类失败信号各自映射到不同状态", () => {
    const base: {
      relayState: RelayState;
      meValid: boolean;
      machineOnline: boolean | null;
      targetKind: "agentred" | "desktop";
      pinnedAgentredUnavailable: boolean;
      deviceRevoked?: boolean;
    } = {
      relayState: "disconnected",
      meValid: true,
      machineOnline: true,
      targetKind: "agentred",
      pinnedAgentredUnavailable: false,
    };
    expect(deriveSessionViewStatus({ ...base, meValid: false })).toBe(
      "loggedOut",
    );
    expect(deriveSessionViewStatus({ ...base, deviceRevoked: true })).toBe(
      "deviceRevoked",
    );
    expect(deriveSessionViewStatus({ ...base, machineOnline: false })).toBe(
      "machineOffline",
    );
    expect(
      deriveSessionViewStatus({
        ...base,
        targetKind: "desktop",
        machineOnline: false,
      }),
    ).toBe("desktopAppNotRunning");
    expect(
      deriveSessionViewStatus({
        ...base,
        relayState: "connected",
        pinnedAgentredUnavailable: true,
      }),
    ).toBe("pinnedAgentredUnavailable");
    expect(deriveSessionViewStatus({ ...base, relayState: "connected" })).toBe(
      "connected",
    );
    expect(
      deriveSessionViewStatus({ ...base, relayState: "reconnecting" }),
    ).toBe("reconnecting");
    expect(deriveSessionViewStatus(base)).toBe("lost");
  });

  /**
   * 页面刚挂载那一段：`relayState` 的初值是 "disconnected"（`use-relay.ts`），
   * 而 `/v1/devices` 还没回来，所以 `machineOnline` 还是 null。此前这两件事凑在
   * 一起会走进 switch 的 default 判成 "lost" —— 于是**每一次打开任何一条对话**，
   * 都先闪一条红色的「连接断了，已经不再自动重试」，横跨取设备 + 取中继票两个
   * 往返。最刺眼的那一档警报变成了必经画面，红色因此贬值。
   *
   * "lost" 的含义是「连过又放弃了」，那要求先知道机器是在线的。机器在不在线都
   * 还没问出来时，正确的说法是「还在连」。
   */
  it("刚挂载:机器在不在线还没问出来时是「连接中」,不是「连接已断」", () => {
    const booting: Parameters<typeof deriveSessionViewStatus>[0] = {
      relayState: "disconnected",
      meValid: true,
      machineOnline: null,
      targetKind: "agentred",
      pinnedAgentredUnavailable: false,
    };
    expect(deriveSessionViewStatus(booting)).toBe("connecting");
    // 问出来是在线、通道却是断的 —— 这才是真的「连过又放弃了」。
    expect(deriveSessionViewStatus({ ...booting, machineOnline: true })).toBe(
      "lost",
    );
  });

  /**
   * 切对话那一瞬：`machineOnline` 属于**设备**轴，切同一台机器上的另一条对话时它
   * 一直是 true，所以上面那条「还没问出来」的判据接不住这一段 —— 而这一段里
   * `relayTarget` 确实还没定下来（认领要重来一遍），`relayState` 因此停在没有目标
   * 时的初值 "disconnected"。两件事凑起来又被读成「连过又放弃了」。
   *
   * 「连过」要求先有过一条通道。目标都还没定下来时一条都还没开。
   */
  it("换对话:目标还没定下来时是「连接中」,哪怕机器已知在线", () => {
    const switching: Parameters<typeof deriveSessionViewStatus>[0] = {
      relayState: "disconnected",
      meValid: true,
      machineOnline: true,
      targetKind: "agentred",
      pinnedAgentredUnavailable: false,
      relayTargetResolved: false,
    };
    expect(deriveSessionViewStatus(switching)).toBe("connecting");
    // 目标定下来了、通道仍是断的 —— 这才是「连过又放弃了」。
    expect(
      deriveSessionViewStatus({ ...switching, relayTargetResolved: true }),
    ).toBe("lost");
    // 不传等于「有目标」：其余调用方与既有断言的含义一个字都不变。
    expect(
      deriveSessionViewStatus({
        ...switching,
        relayTargetResolved: undefined,
      }),
    ).toBe("lost");
  });
});

/**
 * 写入失败的三类诊断（缺口二的纯函数接缝）。
 *
 * 「会话正忙」在协议上没有专属错误码 —— chat_svc 的 ChatSendInFlight 经
 * internal/daemon/rpc/conn.go:173 落成 -32603 + **本地化** message。所以这里
 * 不去猜它，只把「对端明说执行目标不可用」「对端拒绝了」「请求没走到对端」
 * 三者分开；正忙由 SessionDetailView 的选路 + 一次回落收敛。
 */
describe("写入失败分类:三类互不相同", () => {
  it("Given -32015 When 分类 Then executionUnavailable(唯一可确定的「agentred 不可用」)", () => {
    expect(
      classifySendFailure(new RelayError(-32015, "execution unavailable")).kind,
    ).toBe("executionUnavailable");
  });

  it("Given 对端拒绝(任意远端 RPC 码) When 分类 Then rejected 且原样带出对端说明", () => {
    expect(
      classifySendFailure(
        new RelayError(-32603, "当前会话已有进行中的对话，请稍后再试"),
      ),
    ).toEqual({
      kind: "rejected",
      detail: "当前会话已有进行中的对话，请稍后再试",
    });
    expect(
      classifySendFailure(new RelayError(-32002, "session not found")),
    ).toEqual({ kind: "rejected", detail: "session not found" });
  });

  it("Given 请求没走到对端 When 分类 Then transport(不可回落重试)", () => {
    // RelayClient 自造的失败一律 -1（连接未就绪 / 已断开 / 已关闭）。
    expect(
      classifySendFailure(new RelayError(-1, "relay: 连接已断开")).kind,
    ).toBe("transport");
    // 抛出的压根不是 RelayError：同样不能当成「对端拒绝了」。
    expect(classifySendFailure(new Error("boom")).kind).toBe("transport");
    expect(classifySendFailure(undefined).kind).toBe("transport");
  });

  it("Given 对端拒绝但没给说明 When 分类 Then 不编造 detail", () => {
    expect(classifySendFailure(new RelayError(-32603, "   "))).toEqual({
      kind: "rejected",
    });
  });
});

/**
 * 会话索引的纯函数：筛选 chips、搜索、行标题、状态点。它们决定索引里「看得见
 * 哪些行、行上写什么」，因此和上面的视图状态同属 sessionView 这一个接缝。
 */
describe("sessionView 纯函数(筛选 / 搜索 / 标题 / 状态点)", () => {
  it("matchesSessionFilter:unread=账号里有、且最后活动晚于我最后一次读它", () => {
    // 与桌面端 attention-store 的 lastMessageAt > lastReadAt 同一条判据。
    const unread = { lifecycleState: "idle", updatedAt: 200, lastReadAt: 100 };
    const read = { lifecycleState: "idle", updatedAt: 100, lastReadAt: 200 };
    const neverOpened = { lifecycleState: "idle", updatedAt: 200 };
    // 还没保存进账号的那些不算未读：它们压根不在你的账号里，「读没读过」无从谈起。
    const unsaved = {
      lifecycleState: "idle",
      updatedAt: 200,
      lastReadAt: 0,
      saved: false,
    };

    expect(matchesSessionFilter(unread, "unread")).toBe(true);
    expect(matchesSessionFilter(read, "unread")).toBe(false);
    expect(matchesSessionFilter(neverOpened, "unread")).toBe(true);
    expect(matchesSessionFilter(unsaved, "unread")).toBe(false);
    // 「等你处理」是另一件事，不受已读状态影响：看过了但还停在那儿等输入的仍然是。
    expect(
      matchesSessionFilter(
        {
          lifecycleState: "running",
          waitingForInput: true,
          updatedAt: 1,
          lastReadAt: 9,
        },
        "unread",
      ),
    ).toBe(false);
  });

  it("matchesSessionFilter:all 不过滤,running=运行中且不等待,waiting=等你处理", () => {
    const running = { lifecycleState: "running", waitingForInput: false };
    const waiting = { lifecycleState: "running", waitingForInput: true };
    const idle = { lifecycleState: "idle", waitingForInput: false };
    expect(matchesSessionFilter(running, "all")).toBe(true);
    expect(matchesSessionFilter(waiting, "all")).toBe(true);
    expect(matchesSessionFilter(idle, "all")).toBe(true);
    // 正在等输入的不算「运行中」(等你处理优先)。
    expect(matchesSessionFilter(running, "running")).toBe(true);
    expect(matchesSessionFilter(waiting, "running")).toBe(false);
    expect(matchesSessionFilter(idle, "running")).toBe(false);
    // 决策 3:「等你处理」判的仍是 waitingForInput,不是已读状态。
    expect(matchesSessionFilter(running, "waiting")).toBe(false);
    expect(matchesSessionFilter(waiting, "waiting")).toBe(true);
    expect(matchesSessionFilter(idle, "waiting")).toBe(false);
  });

  it("matchesRowSearch:空查询恒真;命中任一字段(标题/设备/后端/Agent),大小写不敏感", () => {
    const fields = ["重构登录页", "书房小主机", "claudecode", "后端 Agent"];
    expect(matchesRowSearch(fields, "")).toBe(true);
    expect(matchesRowSearch(fields, "   ")).toBe(true);
    expect(matchesRowSearch(fields, "登录")).toBe(true);
    expect(matchesRowSearch(fields, "claude")).toBe(true);
    expect(matchesRowSearch(fields, "后端")).toBe(true);
    expect(matchesRowSearch(fields, "不存在")).toBe(false);
    expect(matchesRowSearch(fields, "CLAUDE")).toBe(true);
  });

  it("sessionTitle:有标题就用标题;还没有标题的会话退化为「工作目录 · 后端 · 状态」", () => {
    const t = i18n.t.bind(i18n);
    expect(
      sessionTitle(
        {
          title: "重构登录页",
          cwd: "/var/proj",
          backendType: "codex",
          lifecycleState: "idle",
        },
        t,
      ),
    ).toBe("重构登录页");
    expect(
      sessionTitle(
        {
          title: "",
          cwd: "/var/proj",
          backendType: "codex",
          lifecycleState: "idle",
        },
        t,
      ),
    ).toBe("/var/proj · codex · Idle");
    // 连工作目录 / 后端都没有时不编造，用破折号占位；不认识的旧状态如实照抄。
    expect(
      sessionTitle(
        { title: "", cwd: "", backendType: "", lifecycleState: "weird" },
        t,
      ),
    ).toBe("— · — · weird");
  });

  /**
   * 点的类名取自包的 `statusConfig`，本站不留第二份映射。
   *
   * 此前 `statusDotClass` 与 `toAgentStatus` 是同一套判定的两个投影，靠「并排
   * 放着，改一处时另一处就在眼前」维持一致 —— 这不是机械保证，是纪律。现在
   * 判定只剩 `toAgentStatus` 一处，类名由包给。断言读包的值而不是写字面量：
   * 包改一次色，本站跟着走，这条不用动。
   */
  it("statusDotClass:等待/运行/中断/其余，类名都来自包的 statusConfig", () => {
    const dot = (status: AgentStatus) => statusConfig[status].dotClassName;

    expect(
      statusDotClass({ lifecycleState: "running", waitingForInput: true }),
    ).toBe(dot("waiting"));
    expect(statusDotClass({ lifecycleState: "running" })).toBe(dot("running"));
    expect(statusDotClass({ lifecycleState: "interrupted" })).toBe(
      dot("error"),
    );
    expect(statusDotClass({ lifecycleState: "idle" })).toBe(dot("idle"));
    // 不认识的旧状态如实归灰,不猜。
    expect(statusDotClass({ lifecycleState: "weird" })).toBe(dot("idle"));
  });
});

/**
 * token 数字的格式与桌面端 `chat.tsx` 的 `formatTokens` 逐档一致：同一个量在两端
 * 读出来必须是同一串字符（此前本站用 `Intl.NumberFormat` 显示 41,200，桌面端显示
 * 41.2k）。
 */
describe("formatTokens", () => {
  it("千位以下原样，不强行加单位", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("十万以下带一位小数，十万起进整数——位数不随数值跳来跳去", () => {
    expect(formatTokens(41_200)).toBe("41.2k");
    expect(formatTokens(206_000)).toBe("206k");
  });

  it("百万档收进 M，整数不留 .0 的尾巴", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(12_400_000)).toBe("12M");
  });
});

/**
 * 上下文用量（2026-08-20 对话页 UI/UX 改版）。与桌面端
 * `chat-panel-context-usage.ts` 同一条判据：窗口 <=0 整块不显示，用量取最后一条
 * 报得出 totalInputTokens 的助手消息。
 */
describe("computeContextUsage", () => {
  const msg = (totalInputTokens?: number) =>
    ({ role: "assistant", totalInputTokens }) as never;

  it("窗口还没探到（0）时整块不显示——不拿一个编出来的分母画进度条", () => {
    expect(computeContextUsage([msg(1000)], 0)).toBeUndefined();
  });

  it("用量取**最后一条**报得出 totalInputTokens 的助手消息（前面的是这一轮之前的快照）", () => {
    expect(
      computeContextUsage([msg(1000), msg(4200), msg(undefined)], 200000),
    ).toEqual({ used: 4200, max: 200000 });
  });

  it("一条都没报过用量时是 0/窗口，不是不显示：窗口本身已经是真的了", () => {
    expect(computeContextUsage([msg(undefined)], 200000)).toEqual({
      used: 0,
      max: 200000,
    });
  });

  it("用户消息不参与：token 计数是助手那一侧报的", () => {
    expect(
      computeContextUsage(
        [{ role: "user", totalInputTokens: 999 } as never, msg(50)],
        1000,
      ),
    ).toEqual({ used: 50, max: 1000 });
  });
});

describe("formatRelativeTime 的格式化器复用", () => {
  // Intl.*Format 的**构造**是 Intl API 里最贵的一步,远贵于 .format()。会话索引
  // 每一行都调一次这个函数,而索引会因为搜索框每敲一个字符、每 30 秒的兜底轮询、
  // 每条 mirror_changed 信号而整体重渲染——200 行就是每次重渲染 200 次构造。
  //
  // 这条断言只能从「构造了几次」上下手:返回值在复用前后完全一样,看不出区别。
  it("同一 locale 反复调用只构造一次格式化器", () => {
    const Original = Intl.RelativeTimeFormat;
    let constructions = 0;
    // 计数的同时必须透传到原构造函数:格式化器还要真的能 format,否则测的是替身
    // 而不是这段逻辑。
    const spy = vi
      .spyOn(Intl, "RelativeTimeFormat")
      .mockImplementation(function (
        ...args: ConstructorParameters<typeof Intl.RelativeTimeFormat>
      ) {
        constructions += 1;
        return new Original(...args);
      } as never);
    try {
      const now = 1_700_000_000_000;
      // 用一个本文件别处没出现过的 locale:缓存按 locale 分,拿 "en" 会被更早的
      // 用例预热掉,一次构造也记不到。
      for (let i = 0; i < 50; i++) {
        formatRelativeTime(now - (i + 1) * 60_000, "fr-CA", now);
      }
      expect(constructions).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("不同 locale 各有各的格式化器,不会串味", () => {
    const now = 1_700_000_000_000;
    const ms = now - 5 * 60_000;
    expect(formatRelativeTime(ms, "en", now)).not.toBe(
      formatRelativeTime(ms, "zh-CN", now),
    );
  });
});
