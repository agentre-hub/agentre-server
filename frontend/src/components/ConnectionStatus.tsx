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
