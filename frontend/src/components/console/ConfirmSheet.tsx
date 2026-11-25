/**
 * 确认用的底部 sheet（规格 2026-11-25 F 段，对比稿 a7 B）：标题 + 一句后果 + 44px 满宽
 * 堆叠按钮，按钮从上到下就是 `actions` 的顺序。手机上它是浮层，系统返回先关它（D1），
 * 关法与点遮罩、Esc 一致——都是「取消」（`onCancel`），不是确认。
 *
 * 只管形状与返回；放弃 / 继续 / 删除这些语义由调用方的 `actions` 给。
 */
import {
  DialogShell,
  DialogShellHeader,
  Button,
} from "@agentre-hub/agentre-ui";

import { useBackDismiss } from "@/hooks/use-back-dismiss";

export interface ConfirmSheetAction {
  label: string;
  onSelect: () => void;
  /** 默认 `default`（主按钮）；危险动作用 `destructive`，次要的用 `secondary`。 */
  variant?: "default" | "destructive" | "secondary";
  testId?: string;
  /** 动作在路上时置灰（防连点）；失败后放开即可再按。 */
  disabled?: boolean;
}

export function ConfirmSheet({
  open,
  title,
  description,
  error,
  actions,
  onCancel,
}: {
  open: boolean;
  title: string;
  description?: string;
  /** 上一次动作失败的原因：就地一行，按钮不挪位。 */
  error?: string | null;
  actions: readonly ConfirmSheetAction[];
  /** 系统返回 / 点遮罩 / Esc：等于没做决定，留在原处。 */
  onCancel: () => void;
}) {
  useBackDismiss(open, onCancel);
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => (next ? undefined : onCancel())}
      size="sm"
    >
      <div data-testid="confirm-sheet" className="flex flex-col">
        <DialogShellHeader title={title} subtitle={description} />
        {error ? (
          <p
            role="alert"
            className="px-5 pb-1 text-aux leading-relaxed text-destructive-text"
          >
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 px-5 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom,0px))]">
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              data-testid={action.testId}
              variant={action.variant ?? "default"}
              className="h-11 w-full"
              disabled={action.disabled}
              onClick={action.onSelect}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
    </DialogShell>
  );
}
