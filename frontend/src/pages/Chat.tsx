import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import AppShell from "@/components/AppShell";
import ChatList, {
  type ChatGroup,
  type ChatInvalidRow,
  type ChatOfflineRow,
  type ChatPendingRow,
  type ChatSessionRow,
} from "@/components/session/ChatList";
import NewConversationDialog from "@/components/session/NewConversationDialog";
import { useRelayMachine } from "@/hooks/use-relay";
import { api, ApiError } from "@/lib/api";
import { decodeSessionListResult, type SessionSummary } from "@/lib/wire";

/**
 * 「对话」页（R13，mockup 帧 49 / 49b）：这一端的对话 = 自己发起的（R15，task 8
 * 落地）+ 关注来的（R12 / R14）。两个来源不作区分、不分节、不加徽标。
 *
 * 骨架是账号下的 Agent 列表（块 1 已同步到 server 的 /v1/workspace/agents），
 * 因此这一页任何时候都有内容、不存在整页空白：桌面按 Agent 分组，机器落在每条
 * 会话行的第二行小字上，不作分组维度。
 *
 * 关注名单（/v1/follows）只含「指向」（设备指纹 + 会话标识 + 关注时间），不含
 * 标题 / 消息 / 转录。要显示与 R5 同一套信息（标题 / 状态 / 等待输入），本页对
 * 每个在线的目标机器挂一个 FollowedMachineResolver：连上中继后 session.list，
 * 把关注到的会话解析出来。机器离线时该条仍在名单里并标明离线（R13）；目标已
 * 不存在（设备被撤销 / 机器上已没有这条会话）时标失效、可一键移除。
 */
interface FollowItem {
  device_fingerprint: string;
  session_id: string;
  followed_at: number;
  invalid: boolean;
}

interface DeviceItem {
  id: number;
  name: string;
  kind: string;
  fingerprint: string;
  last_seen_at: number;
  status: number;
  online: boolean;
}

interface SessionAgent {
  sync_id: string;
  name: string;
  avatar_color?: string;
}

function loadErrorText(e: unknown, t: (k: string) => string): string {
  return e instanceof ApiError ? e.message : t("device.manage.loadError");
}

/**
 * 一台在线目标机器的会话解析器：用 useRelayMachine 连到那台 agentred，连上后
 * session.list，把属于本页关注集合的会话解析出来回传。每台在线机器一个实例。
 */
function FollowedMachineResolver({
  fingerprint,
  ids,
  onResolved,
  onState,
}: {
  fingerprint: string;
  ids: string[];
  onResolved: (fp: string, sessions: SessionSummary[]) => void;
  onState: (
    fp: string,
    state: "connecting" | "connected" | "unreachable",
  ) => void;
}) {
  const { client, relayState } = useRelayMachine(fingerprint);
  const firedRef = useRef<string | null>(null);

  useEffect(() => {
    const state =
      relayState === "connected"
        ? "connected"
        : relayState === "reconnecting"
          ? "unreachable"
          : "connecting";
    onState(fingerprint, state);
  }, [relayState, fingerprint, onState]);

  useEffect(() => {
    if (relayState !== "connected" || !client) return;
    // 一次连接解析一次；重连后（relayState 变了）再解析一次。
    if (firedRef.current === relayState) return;
    firedRef.current = relayState;
    const wanted = new Set(ids);
    client
      .request("runtime.session.list")
      .then((raw) => {
        const res = decodeSessionListResult(raw);
        const matched = res.sessions.filter((s) =>
          wanted.has(String(s.sessionId)),
        );
        onResolved(fingerprint, matched);
      })
      .catch(() => onState(fingerprint, "unreachable"));
  }, [relayState, client, ids, fingerprint, onResolved, onState]);

  return null;
}

export default function Chat() {
  const { t } = useTranslation();
  const nav = useNavigate();

  const [follows, setFollows] = useState<FollowItem[]>([]);
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [agents, setAgents] = useState<SessionAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [resolved, setResolved] = useState<Record<string, SessionSummary[]>>(
    {},
  );
  const [machineState, setMachineState] = useState<
    Record<string, "connecting" | "connected" | "unreachable">
  >({});
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ items: FollowItem[] }>("/v1/follows"),
      api<{ devices: DeviceItem[] }>("/v1/devices"),
      api<{ agents: SessionAgent[] }>("/v1/workspace/agents"),
    ])
      .then(([f, d, a]) => {
        if (!alive) return;
        setFollows(f.items);
        setDevices(d.devices);
        setAgents(a.agents);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e);
      });
    return () => {
      alive = false;
    };
  }, []);

  const devicesByFp = useMemo(
    () => new Map(devices.map((d) => [d.fingerprint, d])),
    [devices],
  );

  const onResolved = useCallback((fp: string, sessions: SessionSummary[]) => {
    setResolved((prev) => ({ ...prev, [fp]: sessions }));
  }, []);

  const onState = useCallback(
    (fp: string, state: "connecting" | "connected" | "unreachable") => {
      setMachineState((prev) => {
        if (prev[fp] === state) return prev;
        return { ...prev, [fp]: state };
      });
    },
    [],
  );

  // 取消关注 / 移除失效条目共用同一条路：调 unfollow 端点，成功后从本地名单去掉。
  const unfollow = useCallback(async (fp: string, sessionId: number) => {
    try {
      await api("/v1/follows/unfollow", {
        method: "POST",
        body: JSON.stringify({
          device_fingerprint: fp,
          session_id: String(sessionId),
        }),
      });
      setFollows((prev) =>
        prev.filter(
          (f) =>
            !(
              f.device_fingerprint === fp && f.session_id === String(sessionId)
            ),
        ),
      );
    } catch {
      // 失败时保持原样（仍是已关注），用户可重试；不假装成功。
    }
  }, []);

  const view = useMemo(() => {
    const groupsByKey = new Map<string, ChatGroup>();
    // 骨架：账号下的 Agent 全部列出（任何时候都有内容）。
    for (const a of agents) {
      groupsByKey.set(a.sync_id, {
        key: a.sync_id,
        label: a.name,
        avatarColor: a.avatar_color,
        sessions: [],
      });
    }
    const unnamed: ChatGroup = {
      key: "__unnamed__",
      label: t("session.list.unnamedGroup"),
      sessions: [],
    };
    const pending: ChatPendingRow[] = [];
    const offline: ChatOfflineRow[] = [];
    const invalid: ChatInvalidRow[] = [];

    for (const f of follows) {
      const key = `${f.device_fingerprint}:${f.session_id}`;
      const device = devicesByFp.get(f.device_fingerprint);
      if (f.invalid || !device) {
        invalid.push({
          key,
          fingerprint: f.device_fingerprint,
          sessionId: Number(f.session_id),
          deviceName: device?.name ?? null,
          reason: "device",
        });
        continue;
      }
      if (
        !device.online ||
        machineState[f.device_fingerprint] === "unreachable"
      ) {
        offline.push({
          key,
          fingerprint: f.device_fingerprint,
          sessionId: Number(f.session_id),
          deviceId: device.id,
          deviceName: device.name,
          lastSeenAt: device.last_seen_at,
        });
        continue;
      }
      const sessList = resolved[f.device_fingerprint] ?? [];
      const match = sessList.find((s) => String(s.sessionId) === f.session_id);
      if (!match) {
        if (machineState[f.device_fingerprint] === "connected") {
          // 已连上但机器上已没有这条会话（如 daemon 清理了记录）→ 失效可移除。
          invalid.push({
            key,
            fingerprint: f.device_fingerprint,
            sessionId: Number(f.session_id),
            deviceName: device.name,
            reason: "session",
          });
        } else {
          pending.push({ key, deviceName: device.name });
        }
        continue;
      }
      const syncId = match.agentSyncId?.trim() ?? "";
      const row: ChatSessionRow = {
        key,
        fingerprint: f.device_fingerprint,
        sessionId: match.sessionId,
        deviceId: device.id,
        deviceName: device.name,
        followedAt: f.followed_at,
        summary: match,
      };
      let group: ChatGroup | undefined;
      if (syncId) {
        group = groupsByKey.get(syncId);
        if (!group) {
          group = { key: syncId, label: syncId, sessions: [] };
          groupsByKey.set(syncId, group);
        }
      } else {
        group = unnamed;
      }
      group.sessions.push(row);
    }

    const groups = [...groupsByKey.values()];
    groups.sort((a, b) => {
      if (a.key === "__unnamed__") return 1;
      if (b.key === "__unnamed__") return -1;
      return a.label.localeCompare(b.label);
    });
    if (unnamed.sessions.length > 0) groups.push(unnamed);

    const total =
      groups.reduce((n, g) => n + g.sessions.length, 0) + offline.length;
    return { groups, pending, offline, invalid, total };
  }, [follows, devicesByFp, agents, resolved, machineState, t]);

  if (loadError) {
    return (
      <AppShell>
        <Alert variant="destructive">{loadErrorText(loadError, t)}</Alert>
      </AppShell>
    );
  }

  const empty = view.total === 0;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold text-foreground">
            {t("chat.title")}
          </h1>
          {!empty && (
            <>
              <span className="flex-1" />
              <Link
                to="/devices"
                className="text-sm font-medium text-primary hover:underline"
              >
                {t("chat.findMore")}
              </Link>
            </>
          )}
        </div>

        {!loaded ? (
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        ) : empty ? (
          <div className="rounded-lg border border-border bg-card p-6">
            {/* 空态沿用设计稿屏 32 / 帧 49b：标题「还没有对话」+ 原文正文 +
                主按钮「开始第一个对话」，文案里不出现「关注」这个机制词。 */}
            <h2 className="mb-1 text-base font-semibold text-foreground">
              {t("chat.noSessions")}
            </h2>
            <p className="mb-4 text-sm leading-[1.5] text-muted-foreground">
              {t("chat.startFirstBody")}
            </p>
            {/* R15 的主动作：打开新对话弹层（屏 23/24/25），派发成功后直接跳详情页。 */}
            <Button size="lg" onClick={() => setNewOpen(true)}>
              {t("chat.startFirst")}
            </Button>
            <div className="mt-4">
              <Link
                to="/devices"
                className="text-sm font-medium text-primary hover:underline"
              >
                {t("chat.findMore")}
              </Link>
            </div>
          </div>
        ) : null}

        {loaded && (
          <ChatList
            groups={view.groups}
            pending={view.pending}
            offline={view.offline}
            invalid={view.invalid}
            onUnfollow={unfollow}
            onRemoveInvalid={unfollow}
            sessionPath={(did, sid) => `/devices/${did}/sessions/${sid}`}
          />
        )}

        {/* R15/R16：从 web 发起新对话。派发成功后该条已进账号级关注名单，
            无需再关注；直接跳到详情页读实时流。 */}
        <NewConversationDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          onStarted={({ deviceId, sessionId }) =>
            nav(`/devices/${deviceId}/sessions/${sessionId}`)
          }
        />

        {/* 每个在线且有非失效关注的机器挂一个解析器（见文件头注释）。 */}
        {loaded &&
          [...devicesByFp.values()]
            .filter(
              (d) =>
                d.online &&
                follows.some(
                  (f) => f.device_fingerprint === d.fingerprint && !f.invalid,
                ),
            )
            .map((d) => (
              <FollowedMachineResolver
                key={d.fingerprint}
                fingerprint={d.fingerprint}
                ids={follows
                  .filter(
                    (f) => f.device_fingerprint === d.fingerprint && !f.invalid,
                  )
                  .map((f) => f.session_id)}
                onResolved={onResolved}
                onState={onState}
              />
            ))}
      </div>
    </AppShell>
  );
}
