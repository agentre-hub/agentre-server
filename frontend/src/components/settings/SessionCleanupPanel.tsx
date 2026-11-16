import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  SessionCleanupSection,
  type CleanupExecuteView,
  type CleanupOption,
  type SessionCleanupPorts,
} from "@agentre-hub/agentre-ui";

import { useAliveEffect } from "@/hooks/use-alive-effect";
import { fetchAgents } from "@/lib/agents";
import { fetchProjects } from "@/lib/projects";
import { executeCleanup, previewCleanup } from "@/lib/sessionCleanup";

/**
 * 设置 → 隐私 → 清理对话历史（控制台）。
 *
 * 界面与确认流程在共享包；这里只接浏览器那一半：筛选项用控制台已经在取的 Agent /
 * 项目名单（取不到就只剩「全部」），完成后 toast 报删了多少、哪些机器离线待办。
 */
export function SessionCleanupPanel({
  fullWidthAction = false,
  onCleaned,
}: {
  fullWidthAction?: boolean;
  /** 一次清理完成后通知宿主（同页的「已保存的对话」数要重读）。 */
  onCleaned?: () => void;
}) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<CleanupOption[]>([]);
  const [projects, setProjects] = useState<CleanupOption[]>([]);

  useAliveEffect((alive) => {
    fetchAgents()
      .then((list) => {
        if (alive())
          setAgents(list.map((a) => ({ id: a.sync_id, label: a.name })));
      })
      .catch(() => {});
    fetchProjects()
      .then((list) => {
        if (alive())
          setProjects(list.map((p) => ({ id: p.syncId, label: p.name })));
      })
      .catch(() => {});
  }, []);

  const ports = useMemo<SessionCleanupPorts>(
    () => ({
      preview: previewCleanup,
      execute: executeCleanup,
      agents,
      projects,
      onDone: (result: CleanupExecuteView) => {
        const lines = [
          t("settings.privacy.cleanup.deleted", { count: result.deleted }),
          ...result.pending.map((p) =>
            t("settings.privacy.cleanup.pending", {
              name: p.label,
              count: p.count,
            }),
          ),
        ];
        toast.success(lines.join("\n"));
        onCleaned?.();
      },
    }),
    [agents, projects, t, onCleaned],
  );

  return (
    <SessionCleanupSection
      ports={ports}
      variant="console"
      fullWidthAction={fullWidthAction}
    />
  );
}
