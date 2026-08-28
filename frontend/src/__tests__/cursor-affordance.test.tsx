/**
 * 手型光标守卫：**可点的东西必须看起来可点**。
 *
 * 为什么需要这条守卫——Tailwind v4 把 preflight 里那条
 * `button, [role="button"] { cursor: pointer }` 删了（v3 有），改成跟浏览器
 * UA 默认一致的 `cursor: default`。升级过来之后，本站自己写的每一个 `<button>`
 * 都静默退回箭头光标：DOM 没变、样式没报错、测试全绿，只有鼠标划过去的人知道。
 * 「挑一个 Agent 直接开聊」那张卡就是这么变成一块不像能点的板子的。
 *
 * 修法只有一种是对的：**在 base 层补一条全局规则**，而不是给每个组件挂
 * `cursor-pointer`。后者是共享包 `@agentre-hub/agentre-ui` 的做法（它的每个
 * 按钮类名里都带一份），但那意味着「可点」这条语义要靠每个作者记得抄一遍，
 * 漏一个就是一处静默回归——正是本仓 AGENTS.md 那条「一个概念一处实现」。
 *
 * 于是这里测两层：
 *   1. globals.css 的 base 层确实有那条 `cursor: pointer` 规则；
 *   2. 把它的选择器列表**拿出来真的去 match 各种形状**——光断言字符串包含
 *      `button` 说明不了 `:not(:disabled)` 写对没有，也说明不了搜索框那种
 *      `<label><input type=search></label>` 有没有被误伤成手型。
 * 最后再拿真实组件（AgentPickList，就是报障那处）跑一遍闭环。
 *
 * 读文件而不是 import CSS 的理由同 design-token-contract.test.ts：
 * vitest 没开 `css: true`，而且 jsdom 也不跑 Tailwind 的编译。
 */
import { render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AgentPickList } from "@/components/session/newconv/AgentPickList";
import type { NewConvAgent } from "@/components/session/newconv/types";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GLOBALS_CSS = path.join(FRONTEND_ROOT, "src/styles/globals.css");
/**
 * 规则本身已经搬进共享包（spec 2026-08-21-cross-host-ui-alignment）：两端都要
 * 「可点的东西看起来可点」，它就不该在两个宿主各写一份。本站的职责因此变成
 * **import 它**，那一半由 design-token-contract.test.ts 按包的 exports 逐个点名。
 *
 * 这里把两份拼起来读，而不是改成只读包里那份：本站将来若要就地覆盖某一档，
 * 覆盖写在 globals.css 里，只读包就会漏看。判据始终是「这个宿主最终有没有这条
 * 规则」，而不是「它写在哪个文件里」。
 */
const PACKAGE_BASE_CSS = path.join(
  FRONTEND_ROOT,
  "node_modules/@agentre-hub/agentre-ui/styles/base.css",
);

const css = [PACKAGE_BASE_CSS, GLOBALS_CSS]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取全部 `@layer base { ... }` 的内容拼起来。
 *
 * 两个细节：`@layer base` 可以出现多次（拼起来的两份 CSS 里，包那份放边框色、
 * body 与这条光标规则，本站那份将来可能放覆盖），只取第一处会看漏；块尾用花括号
 * 计数而不是非贪婪正则，因为里面有嵌套的规则块，正则会在第一个 `}` 就截断。
 */
function layerBase(source: string): string {
  const out: string[] = [];
  const heads = /@layer\s+base\s*\{/g;
  for (let m = heads.exec(source); m; m = heads.exec(source)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        out.push(source.slice(open + 1, i));
        heads.lastIndex = i + 1;
        break;
      }
    }
  }
  return out.join("\n");
}

/** base 层里那条把光标设成手型的规则的选择器列表（原样，含换行）。 */
function pointerSelector(): string {
  const rule = /([^{}]+)\{[^{}]*cursor:\s*pointer\s*;[^{}]*\}/.exec(
    layerBase(css),
  );
  return rule ? rule[1].trim() : "";
}

describe("手型光标的全局规则", () => {
  it("声明在 base 层里，而不是散在各组件的类名上", () => {
    // 空串意味着 base 层根本没有这条规则——Tailwind v4 的 preflight 不会补。
    expect(pointerSelector()).not.toBe("");
  });

  /**
   * 选择器列表要真的能分辨这些形状。左边是喂进 jsdom 的 HTML（`#t` 是被测那个），
   * 右边是「鼠标划过去该不该变手型」。
   */
  const CASES: Array<[string, string, boolean]> = [
    ["按钮", `<button id="t">x</button>`, true],
    ["禁用的按钮", `<button id="t" disabled>x</button>`, false],
    [
      "role=button 的元素",
      `<span id="t" role="button" tabindex="0"></span>`,
      true,
    ],
    [
      "自称禁用的 role=button",
      `<span id="t" role="button" aria-disabled="true"></span>`,
      false,
    ],
    ["下拉选择", `<select id="t"><option>a</option></select>`, true],
    [
      "禁用的下拉选择",
      `<select id="t" disabled><option>a</option></select>`,
      false,
    ],
    ["勾选框", `<input id="t" type="checkbox" />`, true],
    ["单选框", `<input id="t" type="radio" />`, true],
    [
      "勾选框的 label",
      `<label id="t"><input type="checkbox" />a</label>`,
      true,
    ],
    // 搜索/文本框包在 label 里是本站的输入框写法（Chat 的搜索、Org 的筛选）。
    // 它可点，但光标该是 I 形不是手型——这一条就是防止规则写宽了误伤。
    [
      "文本输入的 label",
      `<label id="t"><input type="search" /></label>`,
      false,
    ],
    ["文本输入本身", `<input id="t" type="text" />`, false],
    ["普通文字", `<p id="t">x</p>`, false],
  ];

  it.each(CASES)("%s", (_name, html, expected) => {
    document.body.innerHTML = html;
    const el = document.getElementById("t")!;
    expect(el.matches(pointerSelector())).toBe(expected);
  });
});

const AGENT: NewConvAgent = {
  sync_id: "a1",
  name: "Nova",
  avatar_color: "#4f7cac",
  has_available_target: true,
  exec_targets: [
    { rank: 1, device_name: "mac", availability: "available", current: true },
  ],
};

describe("挑 Agent 的那张卡", () => {
  it("整行落在手型规则里（报障那处：选 Agent 时还是箭头）", () => {
    render(<AgentPickList agents={[AGENT]} recentIds={[]} onPick={() => {}} />);
    const row = screen.getByTestId("agent-pick-a1");
    expect(row.matches(pointerSelector())).toBe(true);
  });
});
