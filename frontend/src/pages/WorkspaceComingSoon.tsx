import { useTranslation } from "react-i18next";

import AppShell from "@/components/AppShell";

/**
 * 占位页（现只用于 /audit）：SideNav 的四项都要能点得进去（决策 13），
 * 但审计（块 6）本轮不是目标，这里只留一句说明，不假装有内容。
 *
 * titleKey / bodyKey 由路由传入：TopBar title 槽显示页面标题（设计文档：
 * DeviceSessions / SessionDetail / WorkspaceComingSoon 传 title 而不传 right），
 * 正文只留一句占位说明。
 */
export default function WorkspaceComingSoon({
  titleKey,
  bodyKey,
}: {
  titleKey: string;
  bodyKey: "workspaceComingSoon.chatBody" | "workspaceComingSoon.auditBody";
}) {
  const { t } = useTranslation();
  return (
    <AppShell title={t(titleKey)}>
      <p className="text-sm text-muted-foreground">{t(bodyKey)}</p>
    </AppShell>
  );
}
