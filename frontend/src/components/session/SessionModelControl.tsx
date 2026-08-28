import {
  ModelTargetPicker,
  ProviderPillResolution,
  ProviderPillTrigger,
  resolveProviderPillState,
  type ModelTarget,
  type PickerProvider,
} from "@agentre-hub/agentre-ui";
import { useTranslation } from "react-i18next";

/** 两格皆空 = 跟随 Agent 绑定。写成常量而不是就地字面量：它是一个有名字的态。 */
const FOLLOW_AGENT: ModelTarget = { providerKey: "", modelKey: "" };

/**
 * 输入框底栏那颗模型 pill。会话详情与「还没发第一句」的草稿共用同一个 ——
 * 第一句和第二句该是同一件事，这与两处共用同一个输入框是同一条理由。
 *
 * 四态的推导住在共享包（`resolveProviderPillState`）：它是 `ProviderPillTrigger`
 * 那两格的入参算法，本站与桌面端此前各算一份，已经漂成两套失效判定与两种模型脸。
 * 这里只负责把宿主手上的东西喂进去：目录来自账号侧 REST，绑定值来自 Agent 后端行。
 */
export default function SessionModelControl({
  backendType,
  catalog,
  boundProviderKey,
  boundModelKey,
  target,
  onChange,
  note,
}: {
  backendType: string;
  catalog: PickerProvider[];
  /** 空串 = 确知没绑（CLI 登录态）；undefined = 还不知道。两者不可混。 */
  boundProviderKey?: string;
  boundModelKey?: string;
  target: ModelTarget;
  onChange: (next: ModelTarget) => void;
  /** 旁边那一行如实说明（另一台没跟上 / 写失败）。 */
  note?: string | null;
}) {
  const { t } = useTranslation();
  const bound = { boundProviderKey, boundModelKey, catalog };
  const boundState = resolveProviderPillState({
    ...bound,
    target: FOLLOW_AGENT,
  });
  const pillState = resolveProviderPillState({ ...bound, target });

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ModelTargetPicker
        scenario="chat"
        backendType={backendType}
        selected={target}
        onChange={onChange}
        catalog={catalog}
        invalid={pillState.mode === "invalid"}
        specialSublabel={
          <ProviderPillResolution
            boundProviderType={boundState.providerType}
            boundProviderLabel={boundState.providerLabel}
            boundModelLabel={boundState.modelLabel}
            boundCliLogin={boundState.cliLogin}
          />
        }
        triggerLabel={<ProviderPillTrigger state={pillState} />}
        aria-label={t("session.composerControls.modelTarget")}
        data-testid="composer-model-target"
        className="h-[26px] w-auto cursor-pointer gap-1.5 rounded-md border-border bg-card px-2.5 text-2xs font-medium text-foreground hover:bg-accent"
      />
      {note ? (
        <span
          role="status"
          data-testid="composer-model-note"
          className="min-w-0 truncate text-2xs text-muted-foreground"
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
