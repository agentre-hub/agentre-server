import { useState } from "react";

import type { SkillCommandSource } from "@agentre-hub/agentre-ui";

import { useAliveEffect } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import {
  fetchSkillCommands,
  parseSkillAuthorizations,
  type SkillAuthorization,
} from "@/lib/skillCatalog";

/**
 * 输入框里那份 Skill 补全:问**这条会话跑的那台机器**「你此刻叫得动哪些 skill」。
 *
 * 它要拼齐三样来路不同的事实,这正是它存在的理由 —— 三样都不在同一个地方:
 *
 *   · **问哪台机器**:会话的目标设备指纹(中继按 `machine:<fp>` 寻址)。
 *   · **带哪份授权**:R15e「一档一块」的授权存在**组织架构库**里,那台机器上没有
 *     那个库。谁掌握谁报进去 —— 这是 `skills.commands` 协议注释点名的一条。
 *   · **在哪个目录**:项目级 skill(`<cwd>/.claude/skills`)只在这一轮的 cwd 下
 *     才解析得出来,机器不该去猜。
 *
 * 拼不齐(没指纹 / 还不知道 backend)就一次都不问:发一次注定答错的调用,代价是
 * 菜单里出现一批叫不动的名字。
 *
 * **任何一步失败都软降级成空清单**:输入框照常能用,只是没有补全。这与
 * `fetchSkillCommands` 自己「拨不通就抛」不矛盾 —— 那一层保真,这一层是界面策略,
 * 而在输入框这个位置,「没有补全」比「整块报错挡住用户正在打的那句话」正确。
 *
 * 交出的是**目录**而不是命令:前缀、去重、按 backend 解析归共享包
 * (`useSlashCommands`),两端同一份实现。
 */
export interface SessionSkillCommandsInput {
  /** 这条会话的 Agent 同步标识。空 = 认不出是哪个 Agent,按空授权问。 */
  agentSyncId?: string;
  /** 这条会话的后端类型。空 = 还不知道,不问。 */
  backendType?: string;
  /** 目标机器的 agentred 指纹。空 = 没有可拨的对象,不问。 */
  fingerprint?: string;
  /** 这一轮的工作目录。 */
  cwd?: string;
}

/** 组织读端点里这一档的那几格 —— 只声明本 hook 真的要读的字段。 */
interface OrgExecTarget {
  backend_type?: string;
  device_fingerprint?: string;
  skills_json?: string;
}
interface OrgAgent {
  sync_id: string;
  exec_targets?: OrgExecTarget[];
}

/**
 * 认出「这条会话落在的那一档」:同一个 Agent 名下可以有好几档,分布在不同机器上。
 *
 * 判据是**机器 + 后端类型**,不是 `current` 那一格:会话钉住的是它起轮时那一档,
 * 而 `current` 是此刻界面上选中的那一档,两者可以不是同一个。拿 `current` 去认,
 * 就会把别的机器上那一档的授权报到这台机器上来。
 *
 * 对不上时回空授权而不是回落到第一档:回落会把用户在别处授权、甚至显式关掉的包,
 * 注入到一个从没授权过它们的档上(与桌面端 `authorizedSkillsForTarget` 同一口径)。
 */
export function findTargetAuthorizations(
  agents: OrgAgent[],
  agentSyncId: string,
  backendType: string,
  fingerprint: string,
): SkillAuthorization[] {
  const agent = agents.find((a) => a.sync_id === agentSyncId);
  const target = agent?.exec_targets?.find(
    (t) =>
      t.device_fingerprint === fingerprint && t.backend_type === backendType,
  );
  return parseSkillAuthorizations(target?.skills_json);
}

export function useSessionSkillCommands({
  agentSyncId,
  backendType,
  fingerprint,
  cwd,
}: SessionSkillCommandsInput): SkillCommandSource[] {
  const [commands, setCommands] = useState<SkillCommandSource[]>([]);

  useAliveEffect(
    (alive) => {
      if (!fingerprint || !backendType) {
        setCommands([]);
        return;
      }

      // 授权拿不到不是不问的理由:那台机器仍答得出它自己解析的那一半 skill,
      // 而那一半恰恰是日常打得最多的。空授权只是让插件那一半退回「继承全局」。
      const authorizations = agentSyncId
        ? api<{ agents?: OrgAgent[] }>("/v1/workspace/org")
            .then((res) =>
              findTargetAuthorizations(
                res.agents ?? [],
                agentSyncId,
                backendType,
                fingerprint,
              ),
            )
            .catch((): SkillAuthorization[] => [])
        : Promise.resolve<SkillAuthorization[]>([]);

      void authorizations
        .then((authorized) =>
          fetchSkillCommands({
            fingerprint,
            backendType,
            cwd: cwd ?? "",
            authorized,
          }),
        )
        .then((result) => {
          if (alive()) setCommands(result.commands);
        })
        .catch(() => {
          if (alive()) setCommands([]);
        });
    },
    [agentSyncId, backendType, fingerprint, cwd],
  );

  return commands;
}
