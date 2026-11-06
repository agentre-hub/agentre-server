import { ChevronRight, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DialogShell,
  DialogShellBody,
  DialogShellHeader,
} from "@agentre-hub/agentre-ui";

import { AgentPickList } from "./AgentPickList";
import type { NewConvAgent } from "./types";

/**
 * 移动端「挑一个 Agent」：底部弹层（设计稿屏 23）。
 *
 * 用共享包的 DialogShell：窄屏贴底 sheet、拖动条、遮罩、焦点圈定与 Esc 都由它给，
 * 本站不再另起一套。这一层只在手机形态里挂载（Chat 按 useIsMobile 决定）。
 */
export function NewConversationSheet({
  open,
  onOpenChange,
  agents,
  recentIds,
  onPick,
  onFromProject,
  settled = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: NewConvAgent[];
  recentIds: string[];
  onPick: (agent: NewConvAgent) => void;
  onFromProject: () => void;
  /** 清单问回来了没有。没回来时清单那一格摆骨架，不说「一个都没有」。 */
  settled?: boolean;
}) {
  const { t } = useTranslation();
  // 测试锚点放在内层 flex 列上（DialogShell 自己不接 testid）：清单那一格的
  // flex-1/min-h-0 在这一列里才成立，被限高后自己滚动，不随 Agent 数量撑出屏幕。
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} size="sm">
      <div
        data-testid="new-conversation-sheet"
        className="flex min-h-0 flex-1 flex-col"
      >
        <DialogShellHeader
          title={t("chat.startNew")}
          subtitle={t("chat.pickAgentHint")}
          onClose={() => onOpenChange(false)}
        />
        <DialogShellBody className="px-4 pb-2 pt-1">
          <div aria-busy={!settled || undefined}>
            <AgentPickList
              agents={agents}
              recentIds={recentIds}
              onPick={onPick}
              columns={1}
              settled={settled}
            />
          </div>
        </DialogShellBody>
        <button
          type="button"
          data-testid="sheet-from-project"
          onClick={onFromProject}
          className="flex shrink-0 items-center gap-2.5 px-5 py-3.5 text-left"
        >
          <span className="flex size-8 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <FolderTree aria-hidden="true" className="size-4" />
          </span>
          <span className="text-sm font-medium text-foreground">
            {t("chat.fromProject")}
          </span>
          <ChevronRight
            aria-hidden="true"
            className="ml-auto size-4 text-decorative-foreground"
          />
        </button>
      </div>
    </DialogShell>
  );
}
