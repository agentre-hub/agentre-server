import {
  DialogShell,
  DialogShellHeader,
  ScopeList,
  type ScopeListProps,
  type ScopeTab,
} from "@agentre-hub/agentre-ui";
import { useTranslation } from "react-i18next";

export interface PhoneScopeSheetProps extends Pick<
  ScopeListProps,
  "allCount" | "selected" | "projects" | "agentGroups" | "machines"
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tab: ScopeTab;
  onTabChange: (tab: ScopeTab) => void;
  /** 选中：宿主换整页范围并关掉弹层。 */
  onSelect: ScopeListProps["onSelect"];
}

/**
 * 范围弹层（规格 2026-11-05「首页」）：共享包的 `DialogShell`（640px 以下是底部
 * sheet）里放共享包的 `ScopeList`。清单与计数由宿主算好带进来。
 */
export function PhoneScopeSheet({
  open,
  onOpenChange,
  tab,
  onTabChange,
  onSelect,
  ...list
}: PhoneScopeSheetProps) {
  const { t } = useTranslation();
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} className="h-[80dvh]">
      <DialogShellHeader
        title={t("chat.phone.scopeSheetTitle")}
        onClose={() => onOpenChange(false)}
      />
      <ScopeList
        {...list}
        tab={tab}
        onTabChange={onTabChange}
        onSelect={onSelect}
        className="flex-1 px-4 pb-[max(1rem,env(safe-area-inset-bottom,0px))]"
      />
    </DialogShell>
  );
}
