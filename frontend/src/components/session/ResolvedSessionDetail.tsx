import { Alert, AlertDescription, Button } from "@agentre-hub/agentre-ui";
import { MessageCircleOff, RotateCw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import AppShell from "@/components/AppShell";
import { EmptyState } from "@/components/console";
import SessionDetailView, {
  type SessionDetailViewProps,
} from "@/components/session/SessionDetailView";
import {
  readMirrorRow,
  type MirrorSessionItem,
} from "@/components/session/sessionMirror";
import { useAliveEffect } from "@/hooks/use-alive-effect";
import { fetchDevices } from "@/lib/devices";
import { isConversationId } from "@/lib/sessionAddress";

/** 宿主手里已经有的那一份：左栏点开一行时，机器与账号那一行都现成。 */
export interface SessionDetailSeed {
  deviceId: number;
  peerFingerprint?: string;
  row?: MirrorSessionItem;
}

export interface ResolvedSessionDetailProps extends Omit<
  SessionDetailViewProps,
  "deviceId" | "conversationId" | "peerFingerprint" | "initialRow"
> {
  conversationId: string;
  /** 地址上的 `?device=`：只有账号里还没有这条会话时才用得上。 */
  deviceParam: number | null;
  seed?: SessionDetailSeed;
}

type Resolution =
  | { kind: "pending" }
  | { kind: "found"; deviceId: number; row?: MirrorSessionItem }
  | { kind: "notFound" }
  | { kind: "error" };

/**
 * 按地址打开一条会话：先认出它在哪台机器上，再交给 SessionDetailView
 * （规格 2026-09-17-chat-session-url「Resolving the target machine」）。
 *
 * 顺序是**承载者优先**：账号镜像那一行记着这条对话此刻在哪台机器上，`?device=` 只是
 * 未保存会话的兜底——反过来的话，保存之后又换了承载机器的对话会连到旧机器上。
 *
 * 读不到（端点失败）与没有这一行是两件事：前者给重试，绝不说成「找不到」，也不在
 * 失败时拿 `?device=` 顶上去猜。
 */
export default function ResolvedSessionDetail({
  conversationId,
  deviceParam,
  seed,
  ...detailProps
}: ResolvedSessionDetailProps) {
  const { t } = useTranslation();
  const valid = isConversationId(conversationId);
  const [resolution, setResolution] = useState<Resolution>({
    kind: "pending",
  });
  // 重试就是把同一趟再走一遍：计数进依赖，effect 重跑。
  const [attempt, setAttempt] = useState(0);
  // 换一条会话（或重试）时回到 pending：不清的话，上一条的结论会在新目标的往返期间
  // 顶着。只换 `?device=` 不算——保存之后地址原地去掉它，已经开着的详情不该为此
  // 卸掉重认一遍；重认在后台照走，结论一样就原地不动。
  const [lastTarget, setLastTarget] = useState({ conversationId, attempt });
  if (
    lastTarget.conversationId !== conversationId ||
    lastTarget.attempt !== attempt
  ) {
    setLastTarget({ conversationId, attempt });
    setResolution({ kind: "pending" });
  }

  const needsLookup = valid && seed === undefined;

  useAliveEffect(
    (alive) => {
      if (!needsLookup) return;
      void (async () => {
        try {
          const [row, devices] = await Promise.all([
            readMirrorRow(conversationId),
            fetchDevices(),
          ]);
          if (!alive()) return;
          const device = row
            ? devices.find((d) => d.fingerprint === row.device_fingerprint)
            : devices.find((d) => d.id === deviceParam);
          setResolution(
            device
              ? { kind: "found", deviceId: device.id, row }
              : { kind: "notFound" },
          );
        } catch {
          if (alive()) setResolution({ kind: "error" });
        }
      })();
    },
    [needsLookup, conversationId, deviceParam, attempt],
  );

  const wrap = (node: ReactNode) =>
    detailProps.form === "embedded" ? node : <AppShell>{node}</AppShell>;

  // 种子是宿主手里真实的一行，先于形状校验：会话号的形状只对「从地址来的」起作用。
  if (seed) {
    return (
      <SessionDetailView
        {...detailProps}
        deviceId={seed.deviceId}
        conversationId={conversationId}
        peerFingerprint={seed.peerFingerprint ?? seed.row?.peer_fingerprint}
        initialRow={seed.row}
      />
    );
  }

  if (!valid || resolution.kind === "notFound") {
    return wrap(
      <div className="flex flex-1 items-center justify-center p-4">
        <EmptyState
          icon={MessageCircleOff}
          tone="warn"
          title={t("session.address.notFound.title")}
          body={t("session.address.notFound.body")}
          testId="session-not-found"
        />
      </div>,
    );
  }

  if (resolution.kind === "error") {
    return wrap(
      <div className="p-4" data-testid="session-resolve-error">
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1">
              {t("session.address.loadError")}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RotateCw aria-hidden="true" className="size-3.5" />
              {t("common.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      </div>,
    );
  }

  if (resolution.kind === "pending") {
    // 右栏这一格还不知道是哪台机器：留空而不摆骨架，往返通常只有一次 HTTP。
    return wrap(<div aria-busy="true" className="min-h-0 flex-1" />);
  }

  return (
    <SessionDetailView
      {...detailProps}
      deviceId={resolution.deviceId}
      conversationId={conversationId}
      peerFingerprint={resolution.row?.peer_fingerprint}
      initialRow={resolution.row}
    />
  );
}
