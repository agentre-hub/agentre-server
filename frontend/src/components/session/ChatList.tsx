import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bookmark } from "lucide-react";

import {
  sessionTitle,
  statusGroupKey,
  STATUS_GROUP_ORDER,
  type StatusGroupKey,
} from "@/components/session/SessionList";
import { useIsMobile } from "@/components/use-is-mobile";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/sessionView";
import { cn } from "@/lib/utils";
import type { SessionSummary } from "@/lib/wire";

/**
 * 「对话」页的列表（R13，mockup 帧 49 / 49b）：骨架是账号下的 Agent 列表，因此
 * 任何时候都有内容。
 *
 * 桌面按 Agent 分组；机器落在每一条会话行的第二行小字（「机器 · 时间」），不作
 * 分组维度。关注开关在行尾（R12 的桌面入口）。
 *
 * 移动按状态分组（决策 12，屏 20）：等你处理置顶 → 运行中 → 已中断 → 其余；
 * 关注入口不在列表行、移到详情页顶栏（决策 16），因此移动行不渲染关注开关；
 * 行第二行仍是「机器 · 时间」。空态由页面在屏 32 形态呈现，本组件不重复。
 *
 * 失效（目标设备被撤销 / 目标会话在机器上已不存在）的条目单列一节，可一键移除。
 * 机器离线时该条仍在名单里并标明离线（R13），不消失。
 */
export interface ChatSessionRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceId: number;
  deviceName: string;
  followedAt: number;
  summary: SessionSummary;
  /** 移动形态下钉在行上的 Agent 名称与头像色（R13，见 regroupByStatus）。 */
  agentName?: string;
  agentColor?: string;
}

export interface ChatGroup {
  key: string;
  label: string;
  avatarColor?: string;
  sessions: ChatSessionRow[];
}

export interface ChatOfflineRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceId: number;
  deviceName: string;
  lastSeenAt: number;
}

export interface ChatPendingRow {
  key: string;
  deviceName: string;
}

export interface ChatInvalidRow {
  key: string;
  fingerprint: string;
  sessionId: number;
  deviceName: string | null;
  /** device = 目标设备被撤销 / 不存在；session = 机器上已没有这条会话。 */
  reason: "device" | "session";
}

interface ChatListProps {
  groups: ChatGroup[];
  /** 在线但还没解析出来（连接中）的会话所在机器。 */
  pending: ChatPendingRow[];
  offline: ChatOfflineRow[];
  invalid: ChatInvalidRow[];
  onUnfollow: (fingerprint: string, sessionId: number) => void;
  onRemoveInvalid: (fingerprint: string, sessionId: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

/**
 * 把（桌面的）Agent 分组拍平后按状态重组（决策 12 的移动形态）。
 *
 * R13：「移动的列表行本身就以 Agent 命名」——分组标题这时是状态，Agent 的名称与
 * 头像因此要跟着行走（屏 20 的 ChatItem 第一行就是 Agent 名）。拍平时把它所属分组
 * 的名称与头像色钉在行上，行渲染时直接用。
 */
function regroupByStatus(
  groups: ChatGroup[],
  t: (k: string, opts?: Record<string, unknown>) => string,
): ChatGroup[] {
  const byKey = new Map<StatusGroupKey, ChatGroup>();
  for (const g of groups) {
    for (const row of g.sessions) {
      const key = statusGroupKey(row.summary);
      const group = byKey.get(key) ?? {
        key,
        label: t(`session.list.group.${key}`),
        sessions: [],
      };
      group.sessions.push(
        // 「未命名」分组（R7 未到达的老会话）不冒充 Agent 名：不猜、不填占位名。
        g.key === "__unnamed__"
          ? row
          : { ...row, agentName: g.label, agentColor: g.avatarColor },
      );
      byKey.set(key, group);
    }
  }
  return STATUS_GROUP_ORDER.filter((k) => byKey.has(k)).map((k) =>
    byKey.get(k)!,
  );
}

function lifecycleLabel(state: string, t: (k: string) => string): string {
  switch (state) {
    case "running":
      return t("session.list.running");
    case "idle":
      return t("session.list.idle");
    case "interrupted":
      return t("session.list.interrupted");
    default:
      // 不认识的旧状态如实显示原文，不猜。
      return state;
  }
}

function SessionRow({
  row,
  onUnfollow,
  sessionPath,
  t,
  locale,
  isMobile,
}: {
  row: ChatSessionRow;
  onUnfollow: (fp: string, sid: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
  locale: string;
  isMobile: boolean;
}) {
  const waiting = !!row.summary.waitingForInput;
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
        // 触控目标：移动行高不小于 44px。
        isMobile && "min-h-11 py-3",
      )}
    >
      <Link
        to={sessionPath(row.deviceId, row.sessionId)}
        className="flex min-w-0 flex-1 items-center gap-3"
      >
        <div className="min-w-0 flex-1">
          {/* R13：移动的列表行本身就以 Agent 命名（屏 20）；桌面的分组维度已经是
              Agent，行上不再重复。 */}
          {isMobile && row.agentName && (
            <p className="flex items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
              {row.agentColor && (
                <span
                  data-testid={`chat-row-avatar-${row.sessionId}`}
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: row.agentColor }}
                />
              )}
              {row.agentName}
            </p>
          )}
          <p className="truncate text-sm font-medium text-foreground">
            {sessionTitle(row.summary, t)}
          </p>
          {/* 机器 · 时间：机器落在行上，不作分组维度（决策 16）。时间与 R5 是同
              一套信息——**最后活动时间**，不是关注时间（关注时间说不出这条对话
              什么时候动过，web 自己发起的那条更会永远停在创建那一刻）。 */}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("chat.followedOn", {
              machine: row.deviceName,
              time: row.summary.updatedAt
                ? formatRelativeTime(row.summary.updatedAt, locale)
                : "—",
            })}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-xs font-medium",
            waiting
              ? "bg-status-waiting-bg text-status-waiting"
              : "bg-muted text-muted-foreground",
          )}
        >
          {waiting
            ? t("session.list.waiting")
            : lifecycleLabel(row.summary.lifecycleState, t)}
        </span>
      </Link>
      {/* 决策 16：关注入口桌面在列表行、移动在详情页顶栏——移动不渲染行内开关。 */}
      {!isMobile && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat.unfollow")}
          title={t("chat.unfollow")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnfollow(row.fingerprint, row.sessionId);
          }}
        >
          <Bookmark
            className="size-3.5"
            fill="currentColor"
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
}

function OfflineRow({
  row,
  onUnfollow,
  sessionPath,
  t,
  isMobile,
}: {
  row: ChatOfflineRow;
  onUnfollow: (fp: string, sid: number) => void;
  sessionPath: (deviceId: number, sessionId: number) => string;
  t: (k: string, opts?: Record<string, unknown>) => string;
  isMobile: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-accent",
        isMobile && "min-h-11 py-3",
      )}
    >
      <Link
        to={sessionPath(row.deviceId, row.sessionId)}
        className="min-w-0 flex-1"
      >
        <p className="truncate text-sm font-medium text-foreground">
          {t("chat.offlineMachineWithTime", {
            machine: row.deviceName,
            time: formatTime(row.lastSeenAt),
          })}
        </p>
      </Link>
      {/* 决策 16：移动的关注入口在详情页顶栏，不在列表行。 */}
      {!isMobile && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("chat.unfollow")}
          title={t("chat.unfollow")}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onUnfollow(row.fingerprint, row.sessionId);
          }}
        >
          <Bookmark
            className="size-3.5"
            fill="currentColor"
            aria-hidden="true"
          />
        </Button>
      )}
    </div>
  );
}

function InvalidRow({
  row,
  onRemove,
  t,
}: {
  row: ChatInvalidRow;
  onRemove: (fp: string, sid: number) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-muted-foreground">
          {row.deviceName ?? t("chat.noMachine")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("chat.invalidBody")}
        </p>
      </div>
      <Button
        variant="outline"
        size="xs"
        onClick={() => onRemove(row.fingerprint, row.sessionId)}
      >
        {t("chat.remove")}
      </Button>
    </div>
  );
}

export default function ChatList({
  groups,
  pending,
  offline,
  invalid,
  onUnfollow,
  onRemoveInvalid,
  sessionPath,
}: ChatListProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const isMobile = useIsMobile();
  // 决策 12：桌面按 Agent 分组、移动按状态分组。
  const rendered = isMobile ? regroupByStatus(groups, t) : groups;

  return (
    <div className="space-y-6">
      {rendered.map((group) => (
        <section key={group.key} aria-label={group.label}>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
            {group.avatarColor && (
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: group.avatarColor }}
              />
            )}
            {group.label}
            {group.sessions.length > 0 && (
              <span className="text-xs font-normal text-subtle-foreground">
                {group.sessions.length}
              </span>
            )}
          </h2>
          {group.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("chat.noSessions")}
            </p>
          ) : (
            <Card className="py-1">
              <CardContent className="p-1">
                {group.sessions.map((s) => (
                  <SessionRow
                    key={s.key}
                    row={s}
                    onUnfollow={onUnfollow}
                    sessionPath={sessionPath}
                    t={t}
                    locale={locale}
                    isMobile={isMobile}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </section>
      ))}

      {pending.length > 0 && (
        <div className="space-y-1">
          {pending.map((p) => (
            <p key={p.key} className="text-sm text-muted-foreground">
              {t("chat.pendingFrom", { machine: p.deviceName })}
            </p>
          ))}
        </div>
      )}

      {offline.length > 0 && (
        <section aria-label={t("chat.offlineTitle")}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {t("chat.offlineTitle")}
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {offline.map((o) => (
                <OfflineRow
                  key={o.key}
                  row={o}
                  onUnfollow={onUnfollow}
                  sessionPath={sessionPath}
                  t={t}
                  isMobile={isMobile}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}

      {invalid.length > 0 && (
        <section aria-label={t("chat.invalidTitle")}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">
            {t("chat.invalidTitle")}
          </h2>
          <Card className="py-1">
            <CardContent className="p-1">
              {invalid.map((inv) => (
                <InvalidRow
                  key={inv.key}
                  row={inv}
                  onRemove={onRemoveInvalid}
                  t={t}
                />
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
