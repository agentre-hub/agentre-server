import { ChevronRight, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogTitle } from "@agentre-hub/agentre-ui";

import { AgentPickList } from "./AgentPickList";
import type { NewConvAgent } from "./types";

/**
 * 移动端「挑一个 Agent」：底部弹层（设计稿屏 23）。
 *
 * 窄屏上没有「右栏」可用，而这件事又不值得占满一整屏——底部升起一层、下面
 * 的会话列表还看得见，是这一步该有的分量。选中之后才整屏进那条 draft 对话。
 *
 * 复用站内的 Dialog 原语，只把定位从「居中」改成「贴底」：它已经带了 overlay、
 * 焦点圈定与 Esc 关闭，另起一套等于把这些再实现一遍。
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
  // 刻意不走 DialogShell：它的 sheet 形态只在窄屏成立（`sm:` 断点之上变回浮卡），
  // 而这一层在任何宽度下都是贴底 sheet——「从底部升起挑一个 Agent」是它的形态本身，
  // 不是窄屏的适配。换过去会把宽屏上的它变成一个居中浮卡。
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-conversation-sheet"
        className="bottom-0 left-0 top-auto max-h-[82dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-2xl"
      >
        {/* 抓手：贴底的层要有一个「可以往下拖」的暗示，即便这一版还不支持拖。 */}
        <div aria-hidden="true" className="flex justify-center pb-1 pt-2">
          <span className="h-1 w-9 rounded-full bg-accent" />
        </div>
        <div className="flex flex-col gap-1 px-5 pb-3 pt-1">
          <DialogTitle className="text-prose">{t("chat.startNew")}</DialogTitle>
          <p className="text-[12.5px] leading-[1.5] text-muted-foreground">
            {t("chat.pickAgentHint")}
          </p>
        </div>
        <div
          aria-busy={!settled || undefined}
          className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
        >
          <AgentPickList
            agents={agents}
            recentIds={recentIds}
            onPick={onPick}
            columns={1}
            settled={settled}
          />
        </div>
        <button
          type="button"
          data-testid="sheet-from-project"
          onClick={onFromProject}
          className="flex shrink-0 items-center gap-2.5 border-t border-border px-5 py-3.5 text-left"
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
      </DialogContent>
    </Dialog>
  );
}
