/**
 * 详情主区的头部（mockup `01-index-detail` / `06-detail-states` / `07-detail-department`
 * 的 `mhead`）：头像 + 名字 + 角色徽标 + 保存态 + `⋮` 溢出菜单 + 关闭。
 * Agent 详情与部门详情共用这一份——两处的头部在图上是同一个形状，各写一遍必然分叉。
 *
 * **头部那条保存态不是装饰。** 这两份表单都是 onBlur 静默提交（改完一个字段就发一个
 * 只带这一个键的 POST），既没有提交按钮，也没有任何「存进去了」的落点：用户改完一个
 * 字段，界面上什么都不变，他分辨不出「已经落库」与「点错地方压根没发出去」。失败时
 * 更要紧——原先写失败只在索引列底部冒一行小字，离被编辑的那个字段隔着大半个屏幕。
 *
 * 危险动作（删除）收进 `⋮`：与本仓设备页同一条既有做法（共享包的下拉菜单 + 确认框），
 * 可发现，但不主导版面。没有任何可做的动作时**整个菜单不画**——不画一个禁用的删除
 * 按钮去暗示「以后能删」（design.md「Never fake a backend」）。
 */
import * as React from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  Loader2,
  MoreVertical,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  cn,
  tokenToCssColor,
} from "@agentre-hub/agentre-ui";
import { formatRelativeTime } from "@/lib/sessionView";

/**
 * `⋮` 里的一项。
 *
 * 这一层数据形状留在宿主（规格 2026-08-22 E 段）：它只是「一行字 + 一个回调 +
 * 危不危险」，没有任何值得进共享包的东西；而**菜单本身**已经归包了——此前本站那份
 * 手写实现自己算坐标、自己管键盘，没有最大高度也没有碰撞翻转。
 *
 * 生产者是 `OrgAgentDetail` 与 `OrgDepartmentDetail`，它们从这里取型。
 */
export interface RowMenuItem {
  key: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

/** 刚存完到「刚刚」失效之间的这一档：低于它一律说「刚刚」。 */
const JUST_NOW_MS = 60_000;
/** 「已保存 · 2 分钟前」要自己往前走，否则停在挂载那一刻的说法上。 */
const RELATIVE_TICK_MS = 30_000;

export type OrgSaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

export interface OrgSaveController {
  state: OrgSaveState;
  /** 派发一次保存，并把结果反映到头部。失败的那一次会被记下来供重试。 */
  run: (action: () => Promise<unknown>) => void;
  retry: () => void;
}

export function useOrgSaveState(): OrgSaveController {
  const { t } = useTranslation();
  const [state, setState] = React.useState<OrgSaveState>({ kind: "idle" });
  const failedRef = React.useRef<(() => Promise<unknown>) | null>(null);
  // seq 让状态只由**最新一次派发**决定：先发出去的那次慢慢失败回来，不能把后来
  // 已经成功的那次涂回失败态（连改两个字段时这是常态，不是边角情况）。
  const seqRef = React.useRef(0);
  // 兜底文案随语言变，但 run 必须保持稳定身份（retry 存的是动作本身）：走 ref，
  // 并在 layout effect 里同步——渲染期写 ref 是 react-hooks/refs 明令禁止的。
  const fallbackRef = React.useRef("");
  React.useLayoutEffect(() => {
    fallbackRef.current = t("org.errors.generic");
  });

  const run = React.useCallback((action: () => Promise<unknown>) => {
    const seq = ++seqRef.current;
    setState({ kind: "saving" });
    void action().then(
      () => {
        if (seq !== seqRef.current) return;
        failedRef.current = null;
        setState({ kind: "saved", at: Date.now() });
      },
      (e: unknown) => {
        if (seq !== seqRef.current) return;
        failedRef.current = action;
        // 服务端给了原因就报服务端的原因（ApiError.message 即响应里的 msg）：
        // 「出错了，请重试」对一个校验失败的字段毫无帮助。
        setState({
          kind: "error",
          message:
            e instanceof Error && e.message ? e.message : fallbackRef.current,
        });
      },
    );
  }, []);

  const retry = React.useCallback(() => {
    const action = failedRef.current;
    if (action) run(action);
  }, [run]);

  return { state, run, retry };
}

function SaveStatus({
  state,
  onRetry,
}: {
  state: OrgSaveState;
  onRetry: () => void;
}) {
  const { t, i18n } = useTranslation();
  // 「刚刚 / 2 分钟前」要自己往前走，所以「现在几点」是一份 state 而不是渲染期
  // 现算的 Date.now()（后者既是不纯函数，也永远停在挂载那一刻的说法上）。
  // 初值 0 落在「刚刚」那一档，正好是刚存完的实情。
  const [now, setNow] = React.useState(0);

  // 只订阅时钟，不在 effect 体里同步 setState：`now` 落后一档正好落在「刚刚」，
  // 而那正是刚存完的实情，所以不需要立刻校准一次。
  React.useEffect(() => {
    if (state.kind !== "saved") return;
    const id = setInterval(() => setNow(Date.now()), RELATIVE_TICK_MS);
    return () => clearInterval(id);
  }, [state]);

  if (state.kind === "idle") return null;

  return (
    <span
      data-testid="org-detail-save-status"
      className="flex min-w-0 shrink items-center gap-1.5 text-2xs"
    >
      {state.kind === "saving" && (
        <>
          <Loader2
            className="size-3 shrink-0 animate-spin text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">
            {t("org.detail.header.saving")}
          </span>
        </>
      )}
      {state.kind === "saved" && (
        <>
          <Check
            className="size-3 shrink-0 text-status-running"
            aria-hidden="true"
          />
          <span className="text-muted-foreground">
            {now - state.at < JUST_NOW_MS
              ? t("org.detail.header.savedJustNow")
              : t("org.detail.header.savedAt", {
                  time: formatRelativeTime(state.at, i18n.language, now),
                })}
          </span>
        </>
      )}
      {state.kind === "error" && (
        <>
          <AlertTriangle
            className="size-3 shrink-0 text-destructive"
            aria-hidden="true"
          />
          <span className="shrink-0 font-semibold text-destructive">
            {t("org.detail.header.saveFailed")}
          </span>
          <span className="min-w-0 truncate text-destructive">
            {state.message}
          </span>
          <Button
            variant="outline"
            size="xs"
            className="shrink-0"
            onClick={onRetry}
          >
            {t("org.detail.header.retry")}
          </Button>
        </>
      )}
    </span>
  );
}

/**
 * 头像 / 组头字形：底色走 `tokenToCssColor`（token → css 变量）而不是把调色板
 * 序号拼成一个工具类名——与共享包内那枚字形同一条理由：拼出来的类名要 Tailwind
 * 扫得到才生成得出规则，扫不到就静默变成透明。token 非法或缺席时给中性面，
 * 不编一个颜色出来。
 */
export function OrgDetailGlyph({
  label,
  color,
  children,
}: {
  label: string;
  color?: string;
  children?: React.ReactNode;
}) {
  const css = tokenToCssColor(color);
  return (
    <span
      data-testid="org-detail-avatar"
      role="img"
      aria-label={label}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-agent-foreground",
        !css && "bg-secondary text-secondary-foreground",
      )}
      style={css ? { backgroundColor: css } : undefined}
    >
      {children}
    </span>
  );
}

/** 角色徽标（部门长 / 系统 Agent）：只画算得出来的那一维。 */
export function OrgDetailBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-primary-soft px-1.5 py-0.5 text-2xs font-semibold text-primary-text">
      {children}
    </span>
  );
}

/** 归属 chip（所属部门 / 上级 Agent / 成员数）。 */
export function OrgDetailChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="min-w-0 shrink truncate rounded-sm bg-secondary px-1.5 py-0.5 text-2xs text-muted-foreground">
      {children}
    </span>
  );
}

export interface OrgDetailHeaderProps {
  avatar: React.ReactNode;
  title: string;
  badges?: React.ReactNode;
  save: OrgSaveController;
  /** 空数组即整个 `⋮` 不画（系统 Agent 就是这一档：它删不得）。 */
  menuItems: RowMenuItem[];
  /** 移动端下钻回索引。桌面端不传——索引一直并排摆着，返回没有可去之处。 */
  onBack?: () => void;
  onClose: () => void;
}

export function OrgDetailHeader(props: OrgDetailHeaderProps) {
  const { t } = useTranslation();
  return (
    <header
      data-testid="org-detail-header"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-card px-5 py-3"
    >
      {/* 返回只在移动端出现（宿主给不给 onBack 决定）：桌面端索引一直在左边并排
          摆着，返回没有可去之处，画一个只会多一颗按钮。 */}
      {props.onBack && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("org.detail.actions.back")}
          onClick={props.onBack}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
      )}
      {props.avatar}
      <span className="min-w-0 max-w-[40%] truncate text-base font-semibold">
        {props.title}
      </span>
      {props.badges}
      <span className="min-w-2 flex-1" />
      <SaveStatus state={props.save.state} onRetry={props.save.retry} />
      {props.menuItems.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("org.detail.header.more")}
              data-testid="org-detail-menu-trigger"
            >
              <MoreVertical className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            {props.menuItems.map((item) => (
              <DropdownMenuItem
                key={item.key}
                variant={item.danger ? "destructive" : "default"}
                onSelect={item.onSelect}
              >
                {item.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("org.detail.actions.close")}
        onClick={props.onClose}
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
    </header>
  );
}
