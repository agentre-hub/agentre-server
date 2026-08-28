import { statusConfig, type AgentStatus, cn } from "@agentre-hub/agentre-ui";

/**
 * 状态标记（Pencil 正式组件 zF5jv StatusPill）。
 *
 * 形状：圆角胶囊 = 装饰点 + 文案。文案永远是可见文本节点——颜色不是状态的
 * 唯一表达。
 *
 * 类名**取自共享包的 `statusConfig`**，本站不再留一份映射。此前这里手抄了
 * 一份，四档全部与包不一致，而且错在同一处：把点的颜色当文字颜色用了。
 * 浅色下 running 是 #10b981 压 #ecfdf5（2.41:1）、waiting 是 #f59e0b 压
 * #fffbeb（2.07:1），都低于 WCAG AA 正文的 4.5:1；`--status-*-text` 这一档
 * token 存在的全部理由就是「在 `-bg` 上当文字用」（包里是 5.21 / 4.84）。
 * 深色下 `-text` 与基色同值，所以这个缺陷只在浅色里显形——它就是这么躺住的。
 *
 * 点与文字**刻意不同色**：点用 `dotClassName`（亮色信号），文字用
 * `pillClassName` 里的深色。此前点是 `bg-current`，跟着文字一起错。
 */
export type StatusTone = AgentStatus;

export function StatusMark({
  tone,
  label,
  testId,
}: {
  tone: StatusTone;
  /** 状态文案（页面经 t() 传入，组件不持有任何产品文案）。 */
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[5px]",
        statusConfig[tone].pillClassName,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 rounded-full", statusConfig[tone].dotClassName)}
      />
      <span className="text-xs font-semibold">{label}</span>
    </span>
  );
}
