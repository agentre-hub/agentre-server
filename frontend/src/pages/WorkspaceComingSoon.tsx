import { useTranslation } from "react-i18next";

import AppShell from "@/components/AppShell";

/**
 * /chat 与 /audit 共用的占位页：SideNav 的四项都要能点得进去（决策 13），
 * 但对话中继（块 2）与审计（块 6）本轮都不是目标，这里只留一句说明，
 * 不假装有内容。
 */
export default function WorkspaceComingSoon({
  bodyKey,
}: {
  bodyKey: "workspaceComingSoon.chatBody" | "workspaceComingSoon.auditBody";
}) {
  const { t } = useTranslation();
  return (
    <AppShell>
      <p className="text-sm text-muted-foreground">{t(bodyKey)}</p>
    </AppShell>
  );
}
