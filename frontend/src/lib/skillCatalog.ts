import { rpcMethods } from "@agentre-hub/agentre-wire";
/**
 * 技能目录：经中继问**一档执行目标所在的那台机器**「你上面装了哪些技能包」。
 *
 * 这一块替掉的是「手打 skill id」——浏览器此前没有任何办法知道那台机器上到底装了
 * 什么，只能让用户凭记忆敲一串 id 进去。桌面端一直是从本机实际装了什么里挑的
 * （`agentre` 的 `use-skill-catalog.ts` + `capability-picker.tsx`），这一侧走的是
 * 同一条判据，只是取数从 Wails 换成中继。
 *
 * 两处协议上的刻意设计（`MethodSkillsCatalog` 的注释是单一事实源）：
 *
 *   · **授权集由调用方报进去**（`SkillCatalogParams.authorized`）。执行目标与它的
 *     技能授权（R15e「一档一块」）存在组织架构库里，agentred 上没有那个库——让它
 *     自己猜等于让它拿别的档、或者干脆拿空授权来答。谁掌握那一档的授权谁就说出来。
 *
 *   · **`discovery` 三态必须分别表达**。`unavailable`（这台机器此刻答不出：CLI 找
 *     不到、枚举失败）与 `unsupported`（这种 backend 没有发现器，是稳定答案）都会
 *     带回空 `packs`；把空目录读成「这台机器没有技能」是协议注释点名不许的一步，
 *     因此认不出的取值一律降级成 `unavailable` 而不是 `ok`。
 *
 * 目标是**逐通道**声明的（决策 10）：技能目录是机器作用域的操作，所以它开的通道
 * 声明 `machine:<fingerprint>`（见 `relayTarget.ts`；URL 上已经没有
 * `daemon_fingerprint` 了）。那个指纹随组织读端点的每一档下行
 * （`OrgExecTargetItem.device_fingerprint`）。
 */
import type { SkillCommandSource } from "@agentre-hub/agentre-ui";
import {
  SkillDiscoveryOK,
  SkillDiscoveryUnavailable,
  SkillDiscoveryUnsupported,
  decodeSkillCatalogResult,
  decodeSkillCommandsResult,
  type SkillAuthorization,
  type SkillCatalogParams,
  type SkillCommandsParams,
  type SkillPackSummary,
} from "@agentre-hub/agentre-wire";

import { withRelayClient } from "@/lib/relayClientPool";
import { machineTarget } from "@/lib/relayTarget";

/** 目录问出来了没有。取值与 wire 的三个常量逐字相同。 */
export type SkillDiscovery = "ok" | "unavailable" | "unsupported";

/**
 * 授权集与目录行**直接用 wire 生成的类型**，不在这一侧照抄一份同名结构：
 * 它们是协议的一部分（`SkillAuthorization` 的字段名与桌面端 `skills_json` 里的
 * 一项逐字相同，`SkillPackSummary` 恰好是画一行要读的那几格），照抄出来的第二份
 * 只会变成两份要同步的真相。字段含义见包里那两个类型自己的注释。
 */
export type {
  SkillAuthorization,
  SkillPackSummary as SkillPack,
} from "@agentre-hub/agentre-wire";

export interface SkillCatalog {
  packs: SkillPackSummary[];
  discovery: SkillDiscovery;
}

/** 三态：继承全局 / 强制开 / 强制关（与桌面端 `TriState` 同形）。 */
export type SkillTriState = "inherit" | "on" | "off";

/**
 * 认不出的取值降级成「答不出」。
 *
 * 方向是有讲究的：往 `unavailable` 偏，界面说「这台机器此刻列不出来」，用户去查
 * 那台机器；往 `ok` 偏，界面会拿一份空目录说「这台机器上一个包都没装」——那是一句
 * 假话，而且用户没有任何办法发现它是假的。
 */
function normalizeDiscovery(raw: string): SkillDiscovery {
  switch (raw) {
    case SkillDiscoveryOK:
      return "ok";
    case SkillDiscoveryUnsupported:
      return "unsupported";
    case SkillDiscoveryUnavailable:
    default:
      return "unavailable";
  }
}

export interface SkillCatalogInput {
  /** 这一档所在机器的 agentred 指纹（`OrgExecTargetItem.device_fingerprint`）。 */
  fingerprint: string;
  backendType: string;
  /** 这一档已经授权的包，用来给目录的每一行盖上 `enabled`。 */
  authorized: SkillAuthorization[];
}

/**
 * 问一次目录。拨不通、握手失败、对面报错都**抛**——调用方据此降级成「列不出可
 * 添加的包，已授权的仍可移除」，而不是拿一份空目录冒充答案。
 */
export async function fetchSkillCatalog(
  input: SkillCatalogInput,
): Promise<SkillCatalog> {
  if (!input.fingerprint) {
    // 本机相对引用（浏览器语境下没有指代对象）与「后端已不在」的档都没有指纹：
    // 没有可拨的对象，就不该发出一次注定失败的连接。
    throw new Error("skill catalog: 这一档没有可拨的机器");
  }
  return withRelayClient(machineTarget(input.fingerprint), async (client) => {
    const params: SkillCatalogParams = {
      backendType: input.backendType,
      authorized: input.authorized,
    };
    const decoded = decodeSkillCatalogResult(
      await client.request(rpcMethods.skillCatalog, params),
    );
    return {
      packs: decoded.packs,
      discovery: normalizeDiscovery(decoded.discovery),
    };
  });
}

/** `skills_json` → 授权集。解不动、不是数组都当空授权，不炸掉整个详情。 */
export function parseSkillAuthorizations(
  json: string | undefined,
): SkillAuthorization[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is { id: string; enabled?: unknown } =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as { id?: unknown }).id === "string",
      )
      .map((s) => ({ id: s.id, enabled: s.enabled !== false }));
  } catch {
    return [];
  }
}

export function serializeSkillAuthorizations(
  authorized: SkillAuthorization[],
): string {
  return JSON.stringify(authorized);
}

/** 这一档对某个包是什么态度：授权集里没有它 = 继承全局。 */
export function skillTriState(
  authorized: SkillAuthorization[],
  id: string,
): SkillTriState {
  const hit = authorized.find((s) => s.id === id);
  if (!hit) return "inherit";
  return hit.enabled ? "on" : "off";
}

/**
 * 改一个包的态度。切回「继承」是把这一项**从授权集里拿掉**——写一条
 * `enabled:false` 是「强制关」，两者在全局启用态变了之后会分道扬镳。
 */
export function setSkillTriState(
  authorized: SkillAuthorization[],
  id: string,
  next: SkillTriState,
): SkillAuthorization[] {
  const rest = authorized.filter((s) => s.id !== id);
  return next === "inherit" ? rest : [...rest, { id, enabled: next === "on" }];
}

/**
 * 命令清单：问同一台机器「这一档此刻**叫得动**哪些 skill」。
 *
 * 它与 `fetchSkillCatalog` 是同一条中继上的两件事,不是同一件事的两种粒度:
 *
 *   · 目录答的是**可配置的 plugin 包** —— 组织架构页拿它画那张授权表。
 *   · 命令答的是**输入框里打得出来的名字** —— 除了包里的 skill,还含 CLI 自己解析
 *     的 user / project / system skill(`~/.claude/skills`、`<cwd>/.claude/skills`)。
 *     那一半不是包、配不了、也不该出现在授权表里,却恰恰是日常打得最多的那一半。
 *
 * 因此它多带一个 `cwd`:项目级 skill 只在那个目录下才解析得出来,而「这一轮在哪跑」
 * 是会话的事实,那台机器不该去猜。授权集仍由调用方报进去(理由同目录)。
 */
export interface SkillCommandsInput {
  /** 这一档所在机器的 agentred 指纹。 */
  fingerprint: string;
  backendType: string;
  /** 这一轮的工作目录。留空 = 只解析 user / system 两档作用域。 */
  cwd?: string;
  /** 这一档已经授权的包。用来算生效集,也原样交给 CLI 决定挂哪些 plugin。 */
  authorized: SkillAuthorization[];
}

export interface SkillCommands {
  commands: SkillCommandSource[];
  discovery: SkillDiscovery;
}

/**
 * 问一次命令清单。拨不通、握手失败、对面报错都**抛** —— 调用方据此让输入框照常
 * 可用、只是没有补全,而不是拿一份空清单冒充「这台机器上没有 skill」。
 */
export async function fetchSkillCommands(
  input: SkillCommandsInput,
): Promise<SkillCommands> {
  if (!input.fingerprint) {
    // 与目录同一条:没有可拨的对象,就不该发出一次注定失败的连接。
    throw new Error("skill commands: 这一档没有可拨的机器");
  }
  return withRelayClient(machineTarget(input.fingerprint), async (client) => {
    const params: SkillCommandsParams = {
      backendType: input.backendType,
      cwd: input.cwd ?? "",
      authorized: input.authorized,
    };
    const decoded = decodeSkillCommandsResult(
      await client.request(rpcMethods.skillCommands, params),
    );
    return {
      commands: decoded.commands.map((command) => ({
        name: command.name,
        description: command.description,
      })),
      discovery: normalizeDiscovery(decoded.discovery),
    };
  });
}
