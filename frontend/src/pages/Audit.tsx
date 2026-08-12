import { useTranslation } from "react-i18next";
import { AlertTriangle, KeyRound, ScrollText } from "lucide-react";

import AppShell from "@/components/AppShell";
import { EmptyState, FilterChip } from "@/components/console";
import { cn } from "@/lib/utils";

/**
 * 审计页（Pencil 正式画板 bKvB4 的信息层级：标题 → 告警区 → 筛选行 → 事件表卡 → 右列凭证卡）。
 *
 * 审计后端本轮不存在（范围外），页面只呈现正式层级 + 诚实空态，不伪造：
 *   - 告警区、事件表、凭证区都用共享 EmptyState 表示「暂无数据」——不显示示例事件/IP/令牌/时间；
 *   - 筛选 chips 用共享 FilterChip 的 disabled 形态（无真实筛选能力 → aria-disabled、
 *     不进焦点序、点不动），不冒充可用筛选，也不渲染 CSV 导出；
 *   - 不渲染撤销单个凭证、忽略告警等无后端假动作；
 *   - 不渲染画板里的「这里记什么」旁白卡及其范围解释。
 * 桌面双栏（左事件区 / 右 320px 凭证卡），移动单列堆叠（flex-col → lg:flex-row），
 * 无横向溢出；颜色全部走语义 token（bg-card/border-border/…），浅色深色一致。
 */
export default function Audit() {
  const { t } = useTranslation();

  // bKvB4 筛选行的四个分类；无数据源 → 全部 disabled，诚实表达「当前无筛选能力」。
  const filters = [
    { key: "audit.filters.all", testId: "audit-filter-all" },
    { key: "audit.filters.deviceAuth", testId: "audit-filter-device-auth" },
    { key: "audit.filters.token", testId: "audit-filter-token" },
    { key: "audit.filters.revoke", testId: "audit-filter-revoke" },
  ];

  // bKvB4 事件表列头（时间/事件/对象/来源/结果）；行数据无后端 → 表下只放诚实空态。
  const columns = [
    { key: "audit.table.time", className: "w-[108px]" },
    { key: "audit.table.event", className: "w-[92px]" },
    { key: "audit.table.object", className: "w-[196px]" },
    { key: "audit.table.source", className: "min-w-0 flex-1" },
    { key: "audit.table.result", className: "w-[104px]" },
  ];

  return (
    <AppShell title={t("nav.audit")}>
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
        {/* 告警区（bKvB4 的 AlertStrip 位置）：无审计后端 → 共享诚实空态，不编虚构告警。 */}
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <EmptyState
            testId="audit-alerts-empty"
            icon={AlertTriangle}
            title={t("audit.alerts.emptyTitle")}
            body={t("audit.alerts.emptyBody")}
          />
        </div>

        <div
          data-testid="audit-body"
          className="flex flex-col gap-4 lg:flex-row"
        >
          {/* 左：事件表区 */}
          <section className="flex min-w-0 flex-1 flex-col gap-3">
            {/* 筛选行：全部 disabled（共享 FilterChip 的诚实形态，非按钮、aria-disabled）。 */}
            <div className="flex flex-wrap items-center gap-2">
              {filters.map((f) => (
                <FilterChip
                  key={f.key}
                  disabled
                  label={t(f.key)}
                  testId={f.testId}
                />
              ))}
            </div>

            {/* 事件表卡：列头 + 诚实空态。移动端隐藏列头，避免横向溢出。 */}
            <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
              <div className="hidden items-center gap-3 border-b border-border px-4 py-2.5 md:flex">
                {columns.map((c) => (
                  <span
                    key={c.key}
                    className={cn(
                      "truncate font-mono text-[10px] font-bold tracking-[0.4px] text-subtle-foreground",
                      c.className,
                    )}
                  >
                    {t(c.key)}
                  </span>
                ))}
              </div>
              <EmptyState
                testId="audit-events-empty"
                icon={ScrollText}
                title={t("audit.events.emptyTitle")}
                body={t("audit.events.emptyBody")}
              />
            </div>
          </section>

          {/* 右：活跃凭证卡（无数据源 → 诚实空态，无撤销假动作）。 */}
          <aside
            data-testid="audit-credentials"
            className="flex w-full shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card lg:w-[320px]"
          >
            <h2 className="border-b border-border px-4 py-3 text-[13px] font-bold text-foreground">
              {t("audit.credentials.title")}
            </h2>
            <EmptyState
              testId="audit-credentials-empty"
              icon={KeyRound}
              title={t("audit.credentials.emptyTitle")}
              body={t("audit.credentials.emptyBody")}
            />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
