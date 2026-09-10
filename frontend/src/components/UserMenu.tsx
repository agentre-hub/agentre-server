import {
  ChevronsUpDown,
  LogOut,
  RefreshCw,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
  statusConfig,
} from "@agentre-hub/agentre-ui";
import { ConnectionPip, connectionCopy } from "@/components/ConnectionStatus";
import {
  retryAccountChannel,
  useAccountChannelState,
} from "@/hooks/use-account-channel";
import type { Me } from "@/hooks/use-me";
import { api } from "@/lib/api";

/**
 * 账号块 = 下拉菜单触发器（规格「用户菜单与 /account」菜单段）：桌面侧栏左下
 * 与移动端 TopBar 共用同一个组件，只是 compact 形态收起名字/邮箱副行。
 *
 * 菜单包含账号信息（显示名 + 邮箱，只读，不可聚焦）、「账号与安全」
 * （去 /account）、「设置」（去 /settings）与「登出」（真调用 POST /v1/auth/logout，
 * 无论成败都落地登录页——会话多半已经失效，留在原地才是假象）。
 *
 * 账号块同时是**那条账号级中继连接**的状态出口（规格「控制台呈现」V2）：头像右下角
 * 一颗痣，菜单里一段「状态 + 后果」，不会自愈的那一态另给一项「重新连接」。挂在这里
 * 而不是自成一行，是因为账号块在收起 56px 与移动 TopBar 里都还在——那两个形态因此
 * 白拿，而稳态下侧栏一行都不多占。
 *
 * 只有 `disconnected` 才动第二行（邮箱让位）。`connecting` 每次进页面都要经过，
 * 几百毫秒后自己就好了，为它顶掉邮箱等于每次加载都闪一下（与详情页那枚芯片同一条
 * 判断，见 SessionConnectionIndicator 的 A 档）；那一态只改痣的颜色。
 *
 * 调用方负责「账号数据取不到就不渲染」：本组件要求 me 非空，不在内部伪造
 * 头像或名字。**连接状态因此也跟着一起没有**——/v1/auth/me 都取不到的时候，这块屏
 * 已经不是「数据新不新」的问题了。
 */
export function UserMenu({
  me,
  compact = false,
}: {
  me: Me;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const connection = useAccountChannelState();
  const copy = connectionCopy[connection];
  const connectionLabel = t(copy.labelKey);
  const connectionTone = statusConfig[copy.tone];

  const handleLogout = () => {
    // 无论端点调用成败都落地登录页：会话大概率已经失效，留在受保护页面上
    // 假装还登录着才是真正的假象。catch 吞掉失败，避免留下未处理的 rejection。
    void api("/v1/auth/logout", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        window.location.assign("/login");
      });
  };

  const avatar = (
    <div className="relative shrink-0">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-text">
        {me.display_name.charAt(0)}
      </div>
      <ConnectionPip
        state={connection}
        surface={compact ? "card" : "sidebar"}
      />
    </div>
  );

  return (
    <>
      {/* 痣是装饰，状态由这里播报：`connecting` 那一态触发器上一个字都不变，
          而读屏用户同样有权知道自己看的是不是实时的。放在触发器**外面**——
          里面的话它会掺进那颗按钮的名字里。 */}
      <span role="status" className="sr-only">
        {connectionLabel}
      </span>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          aria-label={t("appShell.userMenu.trigger")}
          className={cn(
            "flex cursor-pointer items-center gap-2 rounded-md outline-none",
            "focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "hover:bg-accent data-[state=open]:bg-accent",
            compact ? "px-1 py-1" : "h-[42px] w-full px-1.5",
          )}
        >
          {avatar}
          {compact ? (
            // 紧凑形态延续原移动 TopBar 账号块的做法（AppShell.tsx 原 mobileAccount）：
            // 名字随 DOM 一起渲染，只在 ≥sm 断点显示——390 宽的手机上只剩头像，
            // 与 mockups/shots/mobile-menu.png 一致。
            <span className="hidden max-w-[96px] truncate text-xs font-semibold text-foreground sm:inline">
              {me.display_name}
            </span>
          ) : (
            <>
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-xs font-semibold text-foreground">
                  {me.display_name}
                </div>
                {/* 三态都是邮箱。这一行曾经在断线时让位给状态，因为那时「未连接」
                    在侧栏上没有别的地方可说；现在它自己占一块（AppShell 的
                    ConnectionEscape），账号身份就不必再跟它抢这一行。 */}
                <div className="truncate text-3xs text-muted-foreground">
                  {me.email}
                </div>
              </div>
              <ChevronsUpDown
                className="size-3.5 shrink-0 text-decorative-foreground"
                aria-hidden="true"
              />
            </>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          side={compact ? "bottom" : "top"}
          align={compact ? "end" : "start"}
        >
          {/* 账号信息是只读的一段，不是菜单项：不可聚焦、不可点。 */}
          <DropdownMenuLabel>
            <div className="truncate text-xs font-semibold text-foreground">
              {me.display_name}
            </div>
            <div className="truncate text-2xs text-muted-foreground">
              {me.email}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* 连接状态也是只读的一段，不是菜单项（与上面的账号信息同一条理由）。
            这里说全：状态 + 那一句后果。触发器上只放得下前者。 */}
          <div className="px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  connectionTone.dotClassName,
                )}
              />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-2xs",
                  connectionTone.textClassName,
                )}
              >
                {connectionLabel}
              </span>
            </div>
            <p className="pt-1 text-3xs leading-snug text-muted-foreground">
              {t(copy.hintKey)}
            </p>
          </div>
          {/* 出路只给不会自愈的那一态。`connecting` 正在退避重拨，按一下只会打断
            它自己的节奏（见 relayConnection 的 handleClose）。 */}
          {connection === "disconnected" && (
            <DropdownMenuItem onSelect={retryAccountChannel}>
              <RefreshCw
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {t("appShell.connection.retry")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/account">
              <ShieldCheck
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {t("appShell.userMenu.account")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings">
              <SettingsIcon
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {t("appShell.userMenu.settings")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleLogout}>
            <LogOut
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            {t("appShell.userMenu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
