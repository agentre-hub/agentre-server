import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  DialogShell,
  DialogShellBody,
  DialogShellFooter,
  DialogShellHeader,
  DialogShellSubmit,
} from "@agentre-hub/agentre-ui";

/**
 * 组织面的删除确认（部门 / Agent 共用）。
 *
 * 两处此前各写一份，除了标题的文案键之外逐字相同——一份改了另一份不会跟着改，
 * 而这是个破坏性动作的确认框。
 *
 * 形态走 DialogShell 的 danger（规范 6）：头部一道 danger 分隔线 + destructive
 * 主按钮，后果写在正文。原先是往标题里塞一个 AlertTriangle 图标，那是把「形态」
 * 写成了一段文案。
 */
export default function OrgDeleteConfirm({
  open,
  onOpenChange,
  titleKey,
  name,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题的 i18n 键：部门与 Agent 各有各的说法，其余完全一致。 */
  titleKey: string;
  name: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DialogShell open={open} onOpenChange={onOpenChange} size="sm" danger>
      <DialogShellHeader
        title={t(titleKey, { name })}
        danger
        onClose={() => onOpenChange(false)}
      />
      <DialogShellBody>
        <p className="text-aux leading-relaxed text-muted-foreground">
          {t("org.detail.delete.description")}
        </p>
      </DialogShellBody>
      <DialogShellFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("org.detail.delete.cancel")}
        </Button>
        <DialogShellSubmit
          variant="destructive"
          size="sm"
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          {t("org.detail.delete.confirm")}
        </DialogShellSubmit>
      </DialogShellFooter>
    </DialogShell>
  );
}
