import { useTranslation } from "react-i18next";

import { Alert } from "@/components/ui/alert";
import type { SessionViewStatus } from "@/lib/sessionView";

/**
 * R11 状态横幅：六类失败与失效各有独立文案，不折叠成同一个错误。
 * 可访问性：状态不只靠颜色 —— 每种状态都有可见文字；实时通知类（connecting /
 * reconnecting）走 role="status"，失败类（lost / machineOffline /
 * loggedOut）走 role="alert"。connected 是正常态，不渲染横幅。
 */
export default function SessionStatusBanner({
  status,
  machineLastSeenMs,
}: {
  status: SessionViewStatus;
  machineLastSeenMs?: number;
}) {
  const { t } = useTranslation();
  if (status === "connected") return null;

  const role =
    status === "connecting" || status === "reconnecting" ? "status" : "alert";

  let copy: string;
  switch (status) {
    case "connecting":
      copy = t("session.status.connecting");
      break;
    case "reconnecting":
      copy = t("session.status.reconnecting");
      break;
    case "lost":
      copy = t("session.status.lost");
      break;
    case "machineOffline":
      copy =
        machineLastSeenMs && machineLastSeenMs > 0
          ? t("session.status.machineOfflineWithTime", {
              time: new Date(machineLastSeenMs).toLocaleString(),
            })
          : t("session.status.machineOffline");
      break;
    case "desktopAppNotRunning":
      copy =
        machineLastSeenMs && machineLastSeenMs > 0
          ? t("session.status.desktopAppNotRunningWithTime", {
              time: new Date(machineLastSeenMs).toLocaleString(),
            })
          : t("session.status.desktopAppNotRunning");
      break;
    case "pinnedAgentredUnavailable":
      copy = t("session.status.pinnedAgentredUnavailable");
      break;
    case "loggedOut":
      copy = t("session.status.loggedOut");
      break;
    default:
      return null;
  }

  return (
    <Alert
      variant="destructive"
      role={role}
      data-session-status={status}
      aria-live={role === "status" ? "polite" : "assertive"}
    >
      {copy}
    </Alert>
  );
}
