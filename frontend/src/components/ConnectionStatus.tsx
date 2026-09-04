import { RefreshCw, Unplug } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  retryAccountChannel,
  useAccountChannelState,
} from "@/hooks/use-account-channel";
import type { AccountChannelState } from "@/lib/accountChannel";
import { cn, statusConfig, type AgentStatus } from "@agentre-hub/agentre-ui";

/**
 * 「这一屏看到的东西是不是实时的」在界面上的全部呈现件。
 *
 * 报的是**账号级那条中继连接**（一个标签页一条，见 `@/lib/relayClientPool`）此刻的
 * 状态。它挂在账号块上而不是自成一行（规格「控制台呈现」V2）：账号块在收起 56px
 * 与移动 TopBar 里都还在，所以那颗痣白拿了两个形态，而稳态下侧栏一行都不多占。
 *
 * 三态的**色与调**在这里定一次，两处画法（触发器上那一行、菜单里那一段）都读它。
 * 类名取自共享包的 `statusConfig`，本站不留第二份映射（与 StatusMark 同一条理由：
 * 手抄那份四档全错，而且错在同一处——把点的颜色当文字颜色用了）。
 */
export const connectionCopy: Record<
  AccountChannelState,
  { tone: AgentStatus; labelKey: string; hintKey: string }
> = {
  connected: {
    tone: "running",
    labelKey: "appShell.connection.connected",
    hintKey: "appShell.connection.connectedHint",
  },
  connecting: {
    tone: "waiting",
    labelKey: "appShell.connection.connecting",
    hintKey: "appShell.connection.connectingHint",
  },
  // 中性灰而不是错误红：数据仍然是对的，只是慢到 30 秒。真正需要用户动手的那一下
  // 由菜单里那一项承担，不由颜色承担——拿错误色说一件不是错误的事，真出事时就没
  // 人再当回事了。
  disconnected: {
    tone: "idle",
    labelKey: "appShell.connection.disconnected",
    hintKey: "appShell.connection.pollingHint",
  },
};

/**
 * 头像右下角那颗痣。
 *
 * 对读屏隐藏：一个念得到却点不着的彩色圆点比没有更糟，状态由账号块里那条
 * sr-only 播报说（见 UserMenu）。
 *
 * `surface` 是它所在的那个面，决定白环的颜色。少了这一环，8px 的痣贴在头像边上会
 * 糊成一团；环色取错则更糟——它会变成一颗与设计无关的黑点。侧栏是 `bg-sidebar`，
 * 移动 TopBar 是 `bg-card`，两者在浅色下不同值（#f4f4f5 / #ffffff）。
 */
export function ConnectionPip({
  state,
  surface,
}: {
  state: AccountChannelState;
  surface: "sidebar" | "card";
}) {
  return (
    <span
      data-testid="connection-pip"
      data-connection-state={state}
      aria-hidden="true"
      className={cn(
        "absolute -right-px -bottom-px size-2 rounded-full ring-2",
        surface === "card" ? "ring-card" : "ring-sidebar",
        statusConfig[connectionCopy[state].tone].dotClassName,
        // 「在动」用脉冲表达，降级形态是一个静止的点：记号还在，动效没了。
        state === "connecting" && "animate-pulse motion-reduce:animate-none",
      )}
    />
  );
}

/**
 * 断线时的出路：说得出后果，**一下点到重连**。
 *
 * 「未连接」此前只有两个说法：账号块第二行顶掉邮箱的一行灰字（不可点，点下去只是
 * 把菜单打开），和账号菜单第三段里的「重新连接」（要先知道那个菜单里有这么一项）。
 * 收起成 56px 之后更彻底：只剩一颗灰痣，与正常态几乎没有分别。
 *
 * 只画不会自愈的那一态。`connecting` 正在退避重拨，按一下只会打断它自己的节奏
 * （见 relayConnection 的 handleClose）；`connected` 没有可修的东西。
 *
 * 底色用琥珀而不是那颗痣的中性灰：痣答的是「这一屏有多新」，一件不是错误的事；
 * 这一块答的是「有件事等你按一下」，与「等你处理」的角标同一族。红仍然留给真的
 * 出错——见 statusConfig 的 error。
 */
export function ConnectionEscape({ variant }: { variant: "bar" | "icon" }) {
  const { t } = useTranslation();
  const state = useAccountChannelState();
  if (state !== "disconnected") return null;

  const degraded = t("appShell.connection.degraded", {
    status: t(connectionCopy.disconnected.labelKey),
  });
  const retry = t("appShell.connection.retry");

  if (variant === "icon") {
    // 56px 图标栏与移动 TopBar：排不下那句话，名字里说全。
    return (
      <button
        type="button"
        data-testid="connection-escape"
        aria-label={`${degraded} · ${retry}`}
        title={`${degraded} · ${retry}`}
        onClick={retryAccountChannel}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center self-center rounded-md",
          "bg-status-waiting-bg text-status-waiting-text",
          "hover:brightness-95 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
        )}
      >
        <Unplug className="size-4" aria-hidden="true" />
      </button>
    );
  }

  /*
    展开态：整条都可点。可访问名由内容给出，不另设 aria-label——那会把「有多旧」
    这句话从读屏用户的名字里抹掉。

    状态与动作分两行，不并排：224px 减去两层内边距只剩 ~170px，英文那句
    「Not connected · every 30s」与「Reconnect」并排时前者会被截成
    「Not connected ·…」——被截掉的正好是「有多旧」这个唯一有信息量的部分。
  */
  return (
    <button
      type="button"
      data-testid="connection-escape"
      onClick={retryAccountChannel}
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
        "bg-status-waiting-bg text-status-waiting-text",
        "hover:brightness-95 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <Unplug className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-3xs leading-tight">
          {degraded}
        </span>
      </span>
      <span className="flex w-full items-center gap-1.5">
        <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-3xs font-semibold">
          {retry}
        </span>
      </span>
    </button>
  );
}
