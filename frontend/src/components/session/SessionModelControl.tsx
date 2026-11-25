import {
  AgentBackendLogo,
  LlmModelLogo,
  ModelTargetPicker,
  ProviderPillResolution,
  ProviderPillTrigger,
  resolveProviderPillState,
  type CliModelPickerState,
  type ModelTarget,
  type PickerProvider,
  type ProviderPillState,
} from "@agentre-hub/agentre-ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";

import { useIsMobile } from "@/components/use-is-mobile";
import { useBackDismiss } from "@/hooks/use-back-dismiss";

/** 两格皆空 = 跟随 Agent 绑定。写成常量而不是就地字面量：它是一个有名字的态。 */
const FOLLOW_AGENT: ModelTarget = { providerKey: "", modelKey: "" };

const TRIGGER_TESTID = "composer-model-target";

/**
 * 模型短名（「Sonnet」）：触屏工具条上代替人形图标，一眼认出是哪个模型。
 * 模型 ID 形如 `claude-sonnet-4-6` / `gpt-5` / `deepseek-chat`：去掉厂商路径前缀与
 * 打头的 `claude-`，取第一段；第一段是短缩写（≤4 字母）且后面跟着版本号时把版本号接上
 * （`gpt-5` → `GPT-5`），免得只剩一个认不出版本的 `GPT`。解析不出模型时不给，脸不变。
 */
function modelShortName(modelId: string): string | undefined {
  const parts = modelId
    .split("/")
    .pop()!
    .split(/[-_:\s]+/)
    .filter(Boolean);
  if (parts[0]?.toLowerCase() === "claude") parts.shift();
  const head = parts[0];
  if (!head) return undefined;
  if (head.length <= 4 && /^\d/.test(parts[1] ?? "")) {
    return `${head.toUpperCase()}-${parts[1]}`;
  }
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * 这颗选择器的弹层此刻开着没有。共享包的选择器把开关收在自己里面、不对外报，
 * 而系统返回要关它得先知道它开着：触发器的 aria-expanded 就是它对外的事实，
 * 订阅它（MutationObserver）比往包里加一个只为本站用的受控入参便宜。
 */
function useTriggerExpanded(root: HTMLElement | null): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!root) return () => {};
      const observer = new MutationObserver(onChange);
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["aria-expanded"],
        subtree: true,
      });
      return () => observer.disconnect();
    },
    [root],
  );
  return useSyncExternalStore(
    subscribe,
    () =>
      root
        ?.querySelector(`[data-testid="${TRIGGER_TESTID}"]`)
        ?.getAttribute("aria-expanded") === "true",
    () => false,
  );
}

/**
 * 系统返回关 sheet：点一下触发器（Radix 对话框的触发器就是开关），走选择器自己的
 * 关闭路径。不用合成 Esc——选择器在搜索框有字时把 Esc 当「先清空」吃掉，sheet 不关，
 * 而历史上那一条记号已经退掉了，下一次返回就会直接离开页面。
 */
function closeSheetViaTrigger(root: HTMLElement | null) {
  root
    ?.querySelector<HTMLElement>(`[data-testid="${TRIGGER_TESTID}"]`)
    ?.click();
}

/**
 * 输入框底栏那颗模型 pill。会话详情与「还没发第一句」的草稿共用同一个 ——
 * 第一句和第二句该是同一件事，这与两处共用同一个输入框是同一条理由。
 *
 * 四态的推导住在共享包（`resolveProviderPillState`）：它是 `ProviderPillTrigger`
 * 那两格的入参算法，本站与桌面端此前各算一份，已经漂成两套失效判定与两种模型脸。
 * 这里只负责把宿主手上的东西喂进去：目录来自账号侧 REST，绑定值来自 Agent 后端行。
 *
 * CLI 自带模型段（规格 2026-10-26）由 `useSessionCLIModel` 算好递进来：段本身、
 * 段出现时 pill 的脸、「跟随 Agent 绑定」那一项的解析。接法与桌面端
 * `provider-pill.tsx` 逐项相同——那一项的首图标是解析模型的品牌标识，解析不出时
 * 退到后端标识。
 */
export default function SessionModelControl({
  backendType,
  catalog,
  boundProviderKey,
  boundModelKey,
  target,
  onChange,
  note,
  cliModels,
  cliPillState,
  cliBound,
  deviceLabel,
  openOnMount,
  onSheetClosed,
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
  /** CLI 自带模型段；不出现（后端绑了供应商 / 不是 CLI 类型）时不传。 */
  cliModels?: CliModelPickerState;
  /** CLI 段出现且会话没钉供应商目标时 pill 的脸；不传就按供应商目标推导。 */
  cliPillState?: ProviderPillState;
  /** 「跟随 Agent 绑定」那一项的 CLI 解析：`<CLI 名> · <模型>` 与模型 ID。 */
  cliBound?: { resolutionLabel: string; modelId: string };
  /** 承载机的人读名：CLI 段的列表来自那台机器，弹层顶部说明在哪执行。 */
  deviceLabel?: string;
  /** 挂上就开着选择器（手机草稿页「模型」那一行在输入框还是胶囊时没有 pill 可点）。 */
  openOnMount?: boolean;
  /** 选择器从开到关时回调（宿主据此收掉那只只为开它而挂的实例）。 */
  onSheetClosed?: () => void;
}) {
  const { t } = useTranslation();
  // 手机：底部 sheet，打开不聚焦搜索框（键盘不自动弹起）；系统返回先关它。
  const isMobile = useIsMobile();
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const expanded = useTriggerExpanded(root);
  useBackDismiss(isMobile && expanded, () => closeSheetViaTrigger(root));
  const wasExpandedRef = useRef(false);
  useEffect(() => {
    if (wasExpandedRef.current && !expanded) onSheetClosed?.();
    wasExpandedRef.current = expanded;
  }, [expanded, onSheetClosed]);
  const bound = { boundProviderKey, boundModelKey, catalog };
  const boundState = resolveProviderPillState({
    ...bound,
    target: FOLLOW_AGENT,
  });
  const pillState =
    cliPillState ?? resolveProviderPillState({ ...bound, target });

  return (
    <div ref={setRoot} className="flex min-w-0 items-center gap-1">
      <ModelTargetPicker
        presentation={isMobile ? "sheet" : undefined}
        openOnMount={openOnMount}
        scenario="chat"
        backendType={backendType}
        cliModels={cliModels}
        deviceLabel={cliModels ? deviceLabel : undefined}
        specialIcon={
          cliModels ? (
            cliBound?.modelId ? (
              <LlmModelLogo
                providerType=""
                model={cliBound.modelId}
                className="size-3.5"
              />
            ) : (
              <AgentBackendLogo
                backendType={backendType}
                className="size-3.5"
              />
            )
          ) : undefined
        }
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
            fallbackLabel={cliModels ? cliBound?.resolutionLabel : undefined}
          />
        }
        triggerLabel={
          <ProviderPillTrigger
            state={pillState}
            shortName={
              isMobile ? modelShortName(pillState.modelId ?? "") : undefined
            }
          />
        }
        aria-label={t("session.composerControls.modelTarget")}
        data-testid={TRIGGER_TESTID}
        // `w-auto` 已经在，但触发器与它的内层节点一样没给自己 `min-w-0` ——
        // 里面的 `truncate`（provider-pill-trigger.tsx）虽然写好了，可 flex item
        // 默认的 `min-width:auto` 顶住不让它比整段文案更窄，省略号从没生效过。
        // 窄屏（如「跟随 Agent 绑定 · CLI 自身登录态」）就是靠这一格才收得下去。
        className="h-[26px] w-auto min-w-0 cursor-pointer gap-1.5 rounded-md bg-field-fill px-2.5 text-2xs font-medium text-foreground hover:bg-field-fill-hover"
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
