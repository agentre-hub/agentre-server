import {
  ErrCodeNoActiveTurn,
  rpcMethods,
  type AnyRpcMethod,
} from "@agentre-hub/agentre-wire";
import {
  AGENTRE_UI_NAMESPACE,
  cliModelResolution,
  resolveCLIPillState,
  supportsCLIModel,
  useCLIModels,
  type BackendType,
  type CliModelChoice,
  type CliModelPickerState,
  type ProviderPillState,
} from "@agentre-hub/agentre-ui";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import type { SessionCarrier } from "@/components/session/useSteerAutoContinue";
import { cliOverlayPath, listCLIModelsOn } from "@/lib/cliModels";
import type { EngineBackend } from "@/lib/engineCatalog";
import { RelayError, type RelayClient } from "@/lib/relayClient";

/**
 * 会话的 CLI 自带模型选择，与 wire 上 `cli_model_mode` / `cli_model` 两列逐字同义：
 * mode 空 = 跟随 Agent 绑定、`cli-default` = 不下发、`fixed` = 下发 value。
 */
export interface SessionCLIModelValue {
  mode: string;
  value: string;
}

const FOLLOW_AGENT: SessionCLIModelValue = { mode: "", value: "" };

/** 共享 Picker 认的那一形；跟随 Agent 绑定在它那里是 undefined。 */
function toPickerChoice(v: SessionCLIModelValue): CliModelChoice | undefined {
  if (v.mode === "fixed") return { mode: "fixed", value: v.value };
  if (v.mode === "cli-default") return { mode: "cli-default" };
  return undefined;
}

function fromPickerChoice(choice?: CliModelChoice): SessionCLIModelValue {
  if (choice?.mode === "fixed") return { mode: "fixed", value: choice.value };
  if (choice?.mode === "cli-default") return { mode: "cli-default", value: "" };
  return FOLLOW_AGENT;
}

/**
 * 交给正在跑的 CLI 的那个值（桌面端 agentruntime.CLIModelChoiceValue 同一条）：
 * 固定 = 原样、跟随 CLI 默认 = 空（CLI 回到它自己的默认）、跟随 Agent = 后端绑定值。
 */
function hotSwitchValue(v: SessionCLIModelValue, backendDefault: string) {
  if (v.mode === "fixed") return v.value.trim();
  if (v.mode === "cli-default") return "";
  return backendDefault.trim();
}

/** 这个选择让 CLI 实际以什么启动：跟随 Agent 绑定落到后端绑定值（没绑 = CLI 默认）。 */
function launchChoice(
  v: SessionCLIModelValue,
  backendDefault: string,
): CliModelChoice {
  if (v.mode === "fixed") return { mode: "fixed", value: v.value };
  if (v.mode === "" && backendDefault)
    return { mode: "fixed", value: backendDefault };
  return { mode: "cli-default" };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 只在承载机是 **agentred** 时才交出这条连接，否则交出 null。
 *
 * 判据写成一句 `kind === "agentred"`：`desktop-answered-methods` 那道守卫按它核实
 * 「热切这条路真的限死在 agentred 上」（AGENTRED_ONLY_CALLERS 的 `via`）。
 */
function agentredHotSwitchTarget(
  carrier: SessionCarrier,
  client: RelayClient | null,
): RelayClient | null {
  const hostedByAgentred = !!carrier && carrier.kind === "agentred";
  if (!hostedByAgentred) return null;
  return client;
}

/**
 * 让 agentred 上在跑的 CLI 立即换模型。交回「真的发出去并被接受了」。
 *
 * **只对 agentred**：它的 setSessionCLIModel 只落库，热切要另走这一条；桌面端承载时
 * 它自己的 setSessionCLIModel 就会在空闲时热切，而且桌面端不注册 runtimeSetCLIModel。
 */
async function hotSwitchOnAgentred(
  method: AnyRpcMethod,
  carrier: SessionCarrier,
  client: RelayClient | null,
  params: object,
): Promise<boolean> {
  const target = agentredHotSwitchTarget(carrier, client);
  if (!target) return false;
  await target.request(method, params as never);
  return true;
}

export interface UseSessionCLIModelOptions {
  /** 这条会话所属 Agent 的后端行（`/v1/engine/backends`）；还不知道时 undefined。 */
  backend: EngineBackend | undefined;
  /** 会话的后端类型（执行端报的）。 */
  backendType: string;
  /** 承载这条会话的机器：列表与生效模型都问它。 */
  carrierFp?: string;
  /** 那台机器在不在线；离线时目录显示错误态（仍可手输）。 */
  carrierOnline?: boolean;
  /** 会话行上落库的选择（实况摘要优先、否则镜像）。 */
  persisted: { mode?: string; value?: string };
  /**
   * 本地状态的归属键。已有会话就是 `conversation_id`；换会话时本地那几格跟着重来。
   * 草稿不传。
   */
  conversationId?: string;
  /** 会话此刻钉着 Agentre 供应商目标：CLI 段的选择在 Picker 上不画成选中。 */
  providerPinned?: boolean;
  /**
   * 这条会话上一轮真的跑过的模型 ID（终态帧报的）。这是历史、不是 CLI 此刻的模型：
   * 只在两种跟随态下当显示值用，固定模型的脸写所选那一个。
   */
  actualModelId?: string;
  /** 这一屏认的「此刻在跑一轮」。在跑时的选择挂起到下一轮。 */
  turnActive?: boolean;
  /**
   * 已有会话：把选择写下去（承载机 + 发起端两处写）。抛出 = 全失败、不改选择；
   * 草稿不传，选择只存本地。
   */
  persist?: (next: SessionCLIModelValue) => Promise<void>;
  /** 承载机那一行（只读 kind）与这条会话的连接 / 发起端，热切用。 */
  carrier?: SessionCarrier;
  clientRef?: RefObject<RelayClient | null>;
  originRef?: RefObject<string | undefined>;
  /** 选择成功落下之后：宿主清掉供应商目标（两套选择互斥）。 */
  onChosen?: () => void;
}

export interface UseSessionCLIModelReturn {
  /** CLI 段出不出现：后端是 CLI 类型且确知没绑 Agentre 供应商。 */
  enabled: boolean;
  /** 会话当前的选择（本地改过的优先，否则落库那一份）。runtime.run 带它过线。 */
  choice: SessionCLIModelValue;
  /** 交给共享 Picker 的 CLI 段；不出现时 undefined。 */
  cliModels?: CliModelPickerState;
  /** CLI 段出现时 pill 的脸（三态、挂起、↻）；不出现时 undefined。 */
  pillState?: ProviderPillState;
  /** 「跟随 Agent 绑定」那一项的解析副行（`<CLI 名> · <模型>`）。 */
  boundResolutionLabel: string;
  /** 后端绑定值解析出的模型 ID（那一项的品牌标识用）。 */
  boundModelId: string;
  /** 选一项（undefined = 回到跟随 Agent 绑定）。交回是否生效。 */
  choose: (choice?: CliModelChoice) => Promise<boolean>;
  /** 供应商目标写成功之后清掉本地的 CLI 选择（不发请求：承载机那边已经清了）。 */
  clear: () => void;
}

interface LocalState {
  key: string;
  /** null = 没在本页改过，按落库那一份。 */
  choice: SessionCLIModelValue | null;
  /** 一轮进行中选的：这一轮仍用旧模型，下一轮开始才换上。 */
  pending: boolean;
  /**
   * 挂起时正在跑（或刚跑完）的那一轮用的选择：本轮第一次挂起之前生效的那一个。
   * 挂起脸的「当前」那一半写它，不写更早一轮报的模型。
   */
  runningChoice: SessionCLIModelValue | null;
  /**
   * 选择已经换了而上一轮报的模型还是旧的：此时拿它当「实际模型」会把旧模型写回脸上。
   * 等换上新选择的那一轮收场（终态帧带来新的实际模型）才重新认它。
   */
  hideActual: boolean;
  switchError: string | null;
}

function freshState(key: string): LocalState {
  return {
    key,
    choice: null,
    pending: false,
    runningChoice: null,
    hideActual: false,
    switchError: null,
  };
}

/**
 * 会话（与草稿）模型 pill 的 CLI 自带模型段。桌面端 `useChatCLIModel` +
 * `useProviderPill` 里 CLI 那一半的 web 宿主版：推导与呈现全在共享包
 * （`useCLIModels` / `resolveCLIPillState` / `cliModelResolution`），这里只接
 * 宿主的事——向承载机查目录、两处写、agentred 热切、挂起态。
 */
export function useSessionCLIModel({
  backend,
  backendType,
  carrierFp = "",
  carrierOnline = true,
  persisted,
  conversationId = "",
  providerPinned = false,
  actualModelId = "",
  turnActive = false,
  persist,
  carrier,
  clientRef,
  originRef,
  onChosen,
}: UseSessionCLIModelOptions): UseSessionCLIModelReturn {
  const { t } = useTranslation();
  const key = conversationId;
  const enabled =
    supportsCLIModel(backendType as BackendType) &&
    !!backend &&
    backend.provider_key === "" &&
    carrierFp !== "";
  const backendDefault = backend?.config?.defaultModel ?? "";

  const listCLIModels = useCallback(
    async ({ refresh }: { refresh: boolean }) => {
      if (!backend) return { models: [] };
      if (!carrierOnline)
        throw new Error(t("session.composerControls.cliModelsCarrierOffline"));
      // 可执行文件路径是 per-device 覆盖：取承载机那一份（没配 = 空，按 PATH 找）。
      const cliPath = await cliOverlayPath(carrierFp, backend.sync_id);
      return listCLIModelsOn(
        carrierFp,
        {
          sync_id: backend.sync_id,
          type: backend.type ?? backendType,
          env_json: backend.env_json ?? "",
          reasoning_effort: backend.reasoning_effort ?? "",
          config: backend.config ?? null,
          provider_key: backend.provider_key,
          model_key: backend.model_key,
        },
        { refresh },
        cliPath,
      );
    },
    [backend, backendType, carrierFp, carrierOnline, t],
  );
  // 共享 hook 认的是数字后端 id；本站按 sync_id 寻址，换后端时 listCLIModels 换引用
  // 就会重取，这里只需要一个非零的占位。
  const directory = useCLIModels({
    backendId: enabled ? 1 : undefined,
    enabled,
    listCLIModels,
  });

  const [stored, setLocal] = useState<LocalState>(() => freshState(key));
  const local = stored.key === key ? stored : freshState(key);

  /*
    挂起与「实际模型暂不作数」都跟着轮次边界走（渲染期调整，不在 effect 里 setState）：
      - 一轮开始：挂起的那次选择从这一轮起生效 → 不再挂起，但上一轮报的模型还不是它；
      - 一轮收场：终态帧带来了新的实际模型 → 重新认它。
  */
  const [seenTurn, setSeenTurn] = useState({ key, turnActive });
  if (seenTurn.key !== key || seenTurn.turnActive !== turnActive) {
    setSeenTurn({ key, turnActive });
    if (seenTurn.key === key && stored.key === key) {
      if (turnActive && stored.pending)
        setLocal({ ...stored, pending: false, hideActual: true });
      else if (!turnActive && stored.hideActual && !stored.pending)
        setLocal({ ...stored, hideActual: false });
    }
  }

  const persistedChoice: SessionCLIModelValue = {
    mode: persisted.mode ?? "",
    value: persisted.mode === "fixed" ? (persisted.value ?? "") : "",
  };
  const choice = local.choice ?? persistedChoice;

  // 连续几次选择只认最后一次：先发的晚回来不得盖住后发的。换了会话也算作废——
  // 上一条那次写入的结果不该落到这一条的本地状态上。
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
  }, [key]);
  const choose = useCallback(
    async (picked?: CliModelChoice): Promise<boolean> => {
      const next = fromPickerChoice(picked);
      if (
        !providerPinned &&
        next.mode === choice.mode &&
        next.value === choice.value
      )
        return true;
      const current = ++generation.current;
      const settle = (patch: Partial<LocalState>) =>
        setLocal((prev) => ({
          ...(prev.key === key ? prev : freshState(key)),
          ...patch,
        }));
      settle({ switchError: null });

      if (!persist) {
        settle({ choice: next });
        onChosen?.();
        return true;
      }

      const client = clientRef?.current ?? null;
      const peer = originRef?.current;
      const idle = !turnActive;
      let hotApplied = false;
      // 从供应商目标切回 CLI 要走下一轮的启动边界，不在旧进程上换模型（与桌面端同一条）。
      if (idle && !providerPinned) {
        try {
          hotApplied = await hotSwitchOnAgentred(
            rpcMethods.runtimeSetCLIModel,
            carrier,
            client,
            {
              conversationId: key,
              ...(peer ? { peerFingerprint: peer } : {}),
              value: hotSwitchValue(next, backendDefault),
            },
          );
        } catch (err) {
          // -32010 = 那台机器上这条会话没有附着的 CLI：只落库，下次启动按它来。
          const noCLI =
            err instanceof RelayError && err.code === ErrCodeNoActiveTurn;
          if (!noCLI) {
            if (current === generation.current)
              settle({ switchError: errorMessage(err) });
            return false;
          }
        }
      }

      try {
        await persist(next);
      } catch (err) {
        // 两处都没写成：选择不变。已经热切过的那一次要换回去，否则 CLI 在跑的
        // 与会话记着的是两个模型。尽力而为——换不回去也只能如实报这一次失败。
        if (hotApplied)
          void hotSwitchOnAgentred(
            rpcMethods.runtimeSetCLIModel,
            carrier,
            client,
            {
              conversationId: key,
              ...(peer ? { peerFingerprint: peer } : {}),
              value: hotSwitchValue(choice, backendDefault),
            },
          ).catch(() => {});
        if (current === generation.current)
          settle({ switchError: errorMessage(err) });
        return false;
      }
      if (current !== generation.current) return false;
      setLocal((prev) => {
        const base = prev.key === key ? prev : freshState(key);
        return {
          ...base,
          choice: next,
          pending: turnActive,
          // 同一轮里连选几次：在跑的那一轮还是第一次挂起之前那个选择。那一轮跑的是
          // 供应商目标时它不在 CLI 目录里，记 null、当前那一半照旧认上一轮报的。
          runningChoice: !turnActive
            ? null
            : base.pending
              ? base.runningChoice
              : providerPinned
                ? null
                : choice,
          hideActual: !turnActive,
        };
      });
      onChosen?.();
      return true;
    },
    [
      key,
      choice,
      providerPinned,
      persist,
      clientRef,
      originRef,
      turnActive,
      carrier,
      backendDefault,
      onChosen,
    ],
  );

  const clear = useCallback(() => {
    generation.current++;
    setLocal({ ...freshState(key), choice: FOLLOW_AGENT });
  }, [key]);

  const pickerChoice = providerPinned ? undefined : toPickerChoice(choice);
  const boundChoice = launchChoice(FOLLOW_AGENT, backendDefault);
  const bound = cliModelResolution(directory.catalog, boundChoice);
  const cliName = t(`agentBackends.backendType.${backendType}.shortLabel`, {
    ns: AGENTRE_UI_NAMESPACE,
  });

  if (!enabled)
    return {
      enabled,
      choice,
      boundResolutionLabel: "",
      boundModelId: "",
      choose,
      clear,
    };

  /*
    共享 resolveCLIPillState 把交进去的「实际模型」排在选择前面；web 没有桌面端那份
    逐会话的 CLI 实况，所以这里只交「这一轮实际会跑的那个」：
      - 挂起：正在跑的那一轮用的选择解析出来的模型；
      - 固定模型：不交，脸写所选那一个（上一轮报的是历史，刷新之后也不得顶掉它）；
      - 两种跟随态：上一轮终态帧报的（换了选择、新一轮还没收场时不作数），否则跟随
        CLI 默认时 CLI 生效配置里的那个——规格写明这一态的显示值就是它。
  */
  const runningModelId = !local.pending
    ? ""
    : local.runningChoice
      ? cliModelResolution(
          directory.catalog,
          launchChoice(local.runningChoice, backendDefault),
        ).modelId
      : actualModelId;
  const reported =
    local.hideActual || choice.mode === "fixed" ? "" : actualModelId;
  const followsCLIDefault =
    choice.mode === "cli-default" || (choice.mode === "" && !backendDefault);
  const cliDefaultModel =
    followsCLIDefault && !providerPinned
      ? (directory.catalog.effectiveModelId ?? "")
      : "";
  const pillState = resolveCLIPillState({
    catalog: directory.catalog,
    choice: pickerChoice,
    backendType,
    boundValue: backendDefault,
    actualModelId: local.pending ? runningModelId : reported || cliDefaultModel,
    pending: local.pending,
    loading: directory.loading,
  });
  const cliModels: CliModelPickerState = {
    ...directory.catalog,
    loading: directory.loading,
    choice: pickerChoice,
    switchError: local.switchError ?? undefined,
    onChange: choose,
    onRefresh: directory.refresh,
    ...(pillState.pending
      ? {
          pending: {
            currentModelId: runningModelId,
            currentLabel: pillState.modelLabel,
            nextLabel: pillState.pending.label,
            nextMode: pillState.pending.mode,
          },
        }
      : {}),
  };
  return {
    enabled,
    choice,
    cliModels,
    pillState,
    boundResolutionLabel: `${cliName}${bound.label ? ` · ${bound.label}` : ""}`,
    boundModelId: bound.modelId,
    choose,
    clear,
  };
}
