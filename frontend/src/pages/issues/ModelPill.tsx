/**
 * 任务表单执行段的**模型**那一颗（规格 2026-08-27「执行归属」）。
 *
 * 选择器与触发器都是共享包的（`ModelTargetPicker` + `ProviderPillTrigger`），四态的
 * 推导也是包里那一份（`resolveProviderPillState`）——本站只做宿主那一段：把账号侧的
 * 引擎目录喂进去，并说清「跟随 Agent 绑定」时实际会跑哪一档。
 *
 * 本轮**没有任何路径读这个值**（规格决策 9），任务只是把「打算怎么跑」记下来。
 */
import {
  ModelTargetPicker,
  ProviderPillTrigger,
  resolveProviderPillState,
  type ModelTarget,
  type PickerProvider,
} from "@agentre-hub/agentre-ui";
import { useTranslation } from "react-i18next";

export interface BoardModelPillProps {
  /** 共享包递过来的 pill 形状；三颗触发器摆在一排必须是同一串。 */
  className: string;
  /** 生效执行档的后端类型；兼容判据与最终能选什么全看它。 */
  backendType: string;
  /** 生效执行档自己绑的供应商 / 模型；`undefined` = 还不知道，不能当成「没绑」。 */
  boundProviderKey?: string;
  boundModelKey?: string;
  catalog: PickerProvider[];
  target: ModelTarget;
  onChange: (target: ModelTarget) => void;
  disabled?: boolean;
}

export function BoardModelPill({
  className,
  backendType,
  boundProviderKey,
  boundModelKey,
  catalog,
  target,
  onChange,
  disabled,
}: BoardModelPillProps) {
  const { t } = useTranslation();
  const pillState = resolveProviderPillState({
    boundProviderKey,
    boundModelKey,
    target,
    catalog,
  });

  return (
    <ModelTargetPicker
      scenario="chat"
      backendType={backendType}
      selected={target}
      onChange={onChange}
      catalog={catalog}
      invalid={pillState.mode === "invalid"}
      disabled={disabled}
      triggerLabel={<ProviderPillTrigger state={pillState} />}
      data-testid="board-model-pill"
      aria-label={t("issues.exec.modelAria")}
      className={className}
    />
  );
}
