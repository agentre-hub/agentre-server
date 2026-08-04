import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 设计 token 契约守卫。
 *
 * 和 eslint-guardrails.test.ts 分工：那条测「不许写字面色值」，
 * 这条测「token 本身声明齐不齐、Tailwind 认不认」。
 * 两者都不测「颜色好不好看」——那是设计稿的事。
 *
 * 为什么读文件而不是 import globals.css：
 * vitest.config.ts 没开 `css: true`，CSS import 在测试里是被 stub 掉的，
 * 拿不到内容。而且就算开了，jsdom 也不跑 Tailwind 的编译，
 * `@theme` 块不会变成任何可查询的东西。直接读源文件才测得到真实声明。
 */

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GLOBALS_CSS = path.join(FRONTEND_ROOT, "src/styles/globals.css");
const SRC_DIR = path.join(FRONTEND_ROOT, "src");

/**
 * 先剥注释再解析。globals.css 的注释里会引用选择器名（例如解释
 * `.dark { ... }` 靠 @custom-variant 生效），裸 indexOf 会撞上注释里那一处，
 * 于是解析到的「.dark 块」其实是 :root——断言全红但根因看不出来。
 */
const css = fs
  .readFileSync(GLOBALS_CSS, "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 取出一个 CSS 块的内容。
 *
 * 选择器按行首锚定：`@custom-variant dark (&:is(.dark *));` 这一行里也有
 * `.dark`，不锚定就会匹配到它。
 *
 * 块尾用花括号计数而不是非贪婪正则——`@theme` 里将来可能出现嵌套块，
 * 正则会在第一个 `}` 就截断，于是后半段声明凭空消失、测试却是绿的。
 */
function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^${escaped}[^{]*\\{`, "m").exec(css);
  if (!head) return "";
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

/** 把块里的 `--name: value;` 解析成 map，值里的换行和连续空格压平。 */
function decls(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return out;
}

const root = decls(block(":root"));
const dark = decls(block(".dark"));
const theme = decls(block("@theme"));

/**
 * 语义 token 的权威清单：[token 名, 浅色值, 深色值]。
 *
 * 深色值为 null = 该 token 不随主题变化，只在 :root 声明一次。
 *
 * 值取自 agentre 桌面端 frontend/src/styles/globals.css，命名也一并沿用，
 * 目的是两端同源：出问题改一次两边都受益。改这张表之前先去看桌面端，
 * 不要在这里单方面发明新值。
 */
const COLOR_TOKENS: Array<[string, string, string | null]> = [
  ["--background", "#f8fafc", "#141a23"],
  ["--foreground", "#0f172a", "#e6edf3"],
  ["--card", "#ffffff", "#1d2533"],
  ["--card-foreground", "#0f172a", "#e6edf3"],
  ["--popover", "#ffffff", "#2a3344"],
  ["--popover-foreground", "#0f172a", "#e6edf3"],
  ["--primary", "#0891b2", "#22d3ee"],
  ["--primary-foreground", "#ffffff", "#04141a"],
  ["--ring", "#0891b2", "#22d3ee"],
  ["--secondary", "#f1f5f9", "#2a3344"],
  ["--secondary-foreground", "#0f172a", "#c9d1d9"],
  ["--muted", "#f1f5f9", "#1d2533"],
  ["--muted-foreground", "#64748b", "#8b949e"],
  ["--accent", "#f1f5f9", "#3a4660"],
  ["--accent-foreground", "#0f172a", "#e6edf3"],
  ["--border", "#e2e8f0", "#2c3548"],
  ["--input", "#e2e8f0", "#2c3548"],
  ["--destructive", "#dc2626", "#f87171"],
  ["--destructive-foreground", "#ffffff", "#fafafa"],
];

/**
 * 非颜色 token：只钉存在，值的形态各异（长度、阴影、rgba）不适合逐字比。
 *
 * 根 token 叫 --overlay-shadow 而不是 --shadow-overlay：v4 的阴影命名空间就是
 * --shadow-*，同名会让 @theme 的映射自指。工具类名仍然是 shadow-overlay，
 * 由下面「@theme 映射」那组守着。
 */
const OTHER_TOKENS = ["--radius", "--overlay-shadow", "--overlay-scrim"];

/**
 * Tailwind 工具类命名空间 → token 前缀。
 * v4 靠 `@theme` 里的 `--color-* / --radius-* / --shadow-*` 生成工具类；
 * 少一条映射，对应的 `bg-xxx` 就不生成任何规则——页面上表现为「那块没颜色」，
 * 而不是报错。所以这条映射必须被测到。
 */
const NAMESPACE = {
  color: "--color-",
  radius: "--radius-",
  shadow: "--shadow-",
};

describe("token 声明", () => {
  it.each(COLOR_TOKENS)("%s 在 :root 里是 %s", (name, light) => {
    expect(root[name]).toBe(light);
  });

  it.each(COLOR_TOKENS.filter(([, , d]) => d !== null))(
    "%s 在 .dark 里被覆写",
    (name, _light, darkValue) => {
      expect(dark[name]).toBe(darkValue);
    },
  );

  it.each(OTHER_TOKENS)("%s 有声明", (name) => {
    expect(root[name]).toBeTruthy();
  });
});

describe("@theme 映射", () => {
  it("globals.css 里有 @theme 块", () => {
    // v3 的 tailwind.config.ts 被 v4 的 @theme 取代。没有这个块，
    // 下面每一条 --color-* 断言都会失败，但失败信息看不出根因，所以先钉住整体。
    expect(block("@theme")).not.toBe("");
  });

  it.each(COLOR_TOKENS)("%s 有 --color-* 别名", (name) => {
    const alias = NAMESPACE.color + name.slice(2);
    expect(theme[alias], `${alias} 缺失 → bg-/text- 工具类不会生成`).toBe(
      `var(${name})`,
    );
  });

  it.each(["sm", "md", "lg"])("rounded-%s 有对应的 --radius-* ", (step) => {
    expect(theme[NAMESPACE.radius + step]).toBeTruthy();
  });

  it("shadow-overlay 有对应的 --shadow-*", () => {
    expect(theme[NAMESPACE.shadow + "overlay"]).toBeTruthy();
  });

  it("bg-scrim 有对应的 --color-*", () => {
    // scrim 是 server 独有的（桌面端没有 Dialog 遮罩这层），
    // token 名 --overlay-scrim 和工具类名 scrim 对不上，最容易在迁移时漏掉。
    expect(theme["--color-scrim"]).toBe("var(--overlay-scrim)");
  });
});

describe("源码只用已声明的 token", () => {
  /** 语义 token 词表：出现在这些工具类后面的名字必须是声明过的 token。 */
  const VOCAB = new Set(
    [...COLOR_TOKENS.map(([n]) => n.slice(2)), "scrim"].flatMap((n) => [n]),
  );
  const UTILITIES =
    "bg|text|border|ring|fill|stroke|outline|divide|placeholder";

  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory())
        return e.name === "__tests__" ? [] : sourceFiles(full);
      return /\.tsx?$/.test(e.name) ? [full] : [];
    });
  }

  it("每个用到的语义色工具类都有 token 兜底", () => {
    const missing: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(
        new RegExp(`\\b(?:${UTILITIES})-([a-z][a-z-]*)\\b`, "g"),
      )) {
        const name = m[1];
        // 只管词表里的语义名；text-sm / border-2 这类 Tailwind 内建不在管辖内。
        const base = name.replace(/-foreground$/, "");
        if (!VOCAB.has(name) && VOCAB.has(base)) {
          missing.push(`${path.relative(FRONTEND_ROOT, file)}: ${m[0]}`);
        }
      }
    }
    expect(missing, "用了没声明的 token 变体").toEqual([]);
  });
});
