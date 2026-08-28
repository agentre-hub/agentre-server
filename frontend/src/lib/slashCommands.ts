/**
 * 这一端摆得出的 `/` 命令。
 *
 * 契约（`SlashCommand` / `SlashExec`）在共享包里，**清单归宿主** —— 包内
 * `chat-input/slash/types.ts` 点名了这一条：文案要读宿主的 i18next 实例，
 * 能不能执行要看宿主接了什么。
 *
 * 与桌面端 `slash-commands/registry.ts` 逐条对照，只留这一端真的做得到的：
 *
 *   /compact  留。claudecode 的 CLI 自己认 `/compact`，走 literal_text；
 *             codex / piagent 的 CLI 不认，桌面端是在 chat-panel 的 onSubmit 里
 *             拦下这段文本转成压缩 RPC —— 本站的对应物是 `runtime.run` 的
 *             `compact` 参数（见 SessionComposer 的提交拦截），因此三个后端都成立。
 *   /goal     留。codex 专有，CLI 自己认，literal_text 原样送过去。
 *   /new      **不留**。它是桌面端「开一个新标签页」的纯前端动作，浏览器这一端
 *             没有标签页这回事，摆上去会是一颗按下去什么也不发生的命令。
 *
 * skill 命令（`$` / `/skill:name`）同样不留：要先「列出这个 agent 的 skill 目录」，
 * 那是桌面端的 Wails 绑定，wire 上没有对应方法。
 */
import type { SlashCommand } from "@agentre-hub/agentre-ui";

/** 压缩上下文这条命令的名字。提交时按它拦截（见 SessionComposer）。 */
export const SLASH_COMPACT = "compact";

/** CLI 自己认 `/compact` 的后端。其余后端由 runtime.run 的 compact 参数承担。 */
const COMPACT_NATIVE_BACKENDS = new Set(["claudecode"]);
const COMPACT_BACKENDS = new Set(["claudecode", "codex", "piagent"]);

export function isNativeCompactBackend(backend: string | undefined): boolean {
  return !!backend && COMPACT_NATIVE_BACKENDS.has(backend);
}

export function buildSlashCommands(t: (key: string) => string): SlashCommand[] {
  return [
    {
      name: SLASH_COMPACT,
      label: "/compact",
      trigger: "/",
      description: t("slashCommands.compact.description"),
      resolve: (backend) =>
        COMPACT_BACKENDS.has(backend)
          ? { kind: "literal_text", text: "/compact" }
          : null,
    },
    {
      name: "goal",
      label: "/goal",
      trigger: "/",
      description: t("slashCommands.goal.description"),
      resolve: (backend) =>
        backend === "codex" ? { kind: "literal_text", text: "/goal " } : null,
    },
  ];
}
