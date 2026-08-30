import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 设计 token 契约守卫。
 *
 * 和 eslint-guardrails.test.ts 分工：那条测「不许写字面色值」，
 * 这条测「token 从哪来、齐不齐、用法有没有越出声明」。
 * 两者都不测「颜色好不好看」——那是设计稿的事。
 *
 * **这条守卫在 2026-08-19 换过判据，值得说明为什么。**
 *
 * 此前它把三十多个色值**逐字节钉在本仓的 globals.css 里**，注释写着「值取自
 * agentre 桌面端，两端同源」。但那个「同源」只存在于注释和这张手工维护的表里：
 * 本站先 import 共享包的 tokens.css，再用自己的 :root/.dark 把同名 token 全部
 * 覆盖一遍。于是桌面端改了流不过来，而本仓的守卫**照样全绿**——它守的是
 * 「本站声明齐不齐」，不是「两端一不一致」。漂移就是这么发生的。
 *
 * 现在判据反过来：**共享包是唯一真源，本站不许重复声明包里已有的色值 token**。
 * 真要分叉就在 DIVERGENCES 里显式登记（目前是空的）。这样桌面端一改、bump SHA
 * 就自动流过来，谁手滑把值复制回来会被这里拦住。
 *
 * 为什么读文件而不是 import CSS：
 * vitest.config.ts 没开 `css: true`，CSS import 在测试里是被 stub 掉的，
 * 拿不到内容。而且就算开了，jsdom 也不跑 Tailwind 的编译，
 * `@theme` 块不会变成任何可查询的东西。直接读源文件才测得到真实声明。
 */

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const GLOBALS_CSS = path.join(FRONTEND_ROOT, "src/styles/globals.css");
const PACKAGE_TOKENS_CSS = path.join(
  FRONTEND_ROOT,
  "node_modules/@agentre-hub/agentre-ui/styles/tokens.css",
);
const SRC_DIR = path.join(FRONTEND_ROOT, "src");

/**
 * 先剥注释再解析。globals.css 的注释里会引用选择器名（例如解释
 * `.dark { ... }` 靠 @custom-variant 生效），裸 indexOf 会撞上注释里那一处，
 * 于是解析到的「.dark 块」其实是 :root——断言全红但根因看不出来。
 */
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const css = strip(fs.readFileSync(GLOBALS_CSS, "utf8"));
const packageCss = strip(fs.readFileSync(PACKAGE_TOKENS_CSS, "utf8"));

/**
 * 取出一个 CSS 块的内容。
 *
 * 选择器按行首锚定：`@custom-variant dark (&:is(.dark *));` 这一行里也有
 * `.dark`，不锚定就会匹配到它。
 *
 * 块尾用花括号计数而不是非贪婪正则——`@theme` 里将来可能出现嵌套块，
 * 正则会在第一个 `}` 就截断，于是后半段声明凭空消失、测试却是绿的。
 */
function blockIn(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^${escaped}[^{]*\\{`, "m").exec(source);
  if (!head) return "";
  const open = head.index + head[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(open + 1, i);
  }
  return "";
}

const block = (selector: string) => blockIn(css, selector);

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

const packageRoot = decls(blockIn(packageCss, ":root"));
const packageDark = decls(blockIn(packageCss, ".dark"));
const packageTheme = decls(blockIn(packageCss, "@theme"));

/**
 * 本站有意与共享包分叉的 token：`[token 名, 为什么]`。
 *
 * **空的是正确状态。** 往里加一条之前先问：这真的是本站独有的需求，还是包里
 * 那个值本来就该改？后者就去桌面端改包，别在这里分叉——那正是上一轮埋雷的方式。
 *
 * 历史记录：曾经有三条暗色分叉（--destructive-foreground #1a0b0c、
 * --destructive-soft #2a1315、--code-surface #111316），2026-08-19 全部撤销。
 * 其中 --destructive-foreground 那条是有害的：本站按钮 dark:bg-destructive/60
 * 实际混出 #a05153，压 #1a0b0c 深字只有 3.46，而包里的 #fafafa 是 5.53。
 */
const DIVERGENCES: Array<[string, string]> = [];

const isColor = (v: string | undefined): boolean =>
  typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v);

describe("共享包是色值的唯一真源", () => {
  it("包的 tokens.css 能被读到（读不到的话下面所有断言都会假绿）", () => {
    expect(Object.keys(packageRoot).length).toBeGreaterThan(30);
    expect(packageRoot["--background"]).toBe("#fafafa");
  });

  it.each([
    [":root", () => root, () => packageRoot] as const,
    [".dark", () => dark, () => packageDark] as const,
  ])("本站 %s 不重复声明包里已有的色值 token", (_scope, own, pkg) => {
    const declared = pkg();
    const duplicated = Object.entries(own())
      .filter(([name, value]) => isColor(value) && name in declared)
      .map(([name]) => name)
      .filter((name) => !DIVERGENCES.some(([tok]) => tok === name));

    expect(
      duplicated,
      "这些 token 包里已经有了。复制一份的后果不是报错，是桌面端改了流不过来，" +
        "而本仓的守卫照样全绿。要么删掉，要么在 DIVERGENCES 里登记理由。",
    ).toEqual([]);
  });

  it("本站 @theme 不重复包里已有的 --color-* 映射", () => {
    const duplicated = Object.keys(theme).filter(
      (alias) => alias.startsWith("--color-") && alias in packageTheme,
    );

    expect(duplicated, "这些别名包的 @theme inline 里已经有了").toEqual([]);
  });

  it.each(DIVERGENCES)("分叉 %s 确实与包里的值不同（%s）", (name) => {
    const own = root[name] ?? dark[name];
    const pkg = packageRoot[name] ?? packageDark[name];
    // 登记了却和包同值 = 一条过期的分叉，删掉即可。留着会让下一个人以为它有意义。
    expect(own, `${name} 登记为分叉，但和包里的值一样`).not.toBe(pkg);
  });
});

/**
 * 包 package.json 里 `./*.css` 那几条导出。
 *
 * 上面那组断言守的是「色值别复制」，这一条守的是**另一种失败**：包发布了一份
 * 样式表，本站压根没 import。漏掉不会报错、构建也是绿的 —— 组件照常渲染 DOM，
 * 只是那批类名一条规则都没有。code-highlight.css 就是这么漏的：包的 markdown
 * 渲染走 rehype-highlight 产出 hljs-* 类，桌面端 globals.css 第 4 行 import 了
 * 它，本站没有，于是转录里所有代码块都是纯单色，而没有任何东西会变红。
 *
 * 判据取自包自己的 exports 而不是手抄清单：包哪天再发第三份样式表，这里立刻红。
 */
const PACKAGE_JSON = path.join(
  FRONTEND_ROOT,
  "node_modules/@agentre-hub/agentre-ui/package.json",
);

describe("共享包发布的样式表一份都不能漏", () => {
  const exported: string[] = Object.keys(
    (
      JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as {
        exports: Record<string, unknown>;
      }
    ).exports,
  ).filter((key) => key.endsWith(".css"));

  it("包确实发布了样式表（读不到的话下面那条是假绿）", () => {
    expect(exported.length).toBeGreaterThan(0);
  });

  it.each(exported)("globals.css import 了 %s", (subpath) => {
    const specifier = `@agentre-hub/agentre-ui/${subpath.replace(/^\.\//, "")}`;
    expect(
      css,
      `包发布了 ${specifier} 但本站没 import。` +
        `漏掉是静默的：DOM 照常渲染，只是那批类名一条规则都没有。`,
    ).toContain(`@import "${specifier}"`);
  });
});

describe("Tailwind 能扫描共享包的组件类名", () => {
  const sourceRoots = [...css.matchAll(/@source\s+"([^"]+)";/g)]
    .map(([, source]) => source)
    .filter((source) => source.includes("@agentre-hub/agentre-ui"))
    .map((source) => source.slice(0, source.search(/[*!{]/)))
    .map((source) =>
      path.resolve(path.dirname(GLOBALS_CSS), source.replace(/\/$/, "")),
    );

  it("共享包的 @source 扫描根真实存在", () => {
    expect(
      sourceRoots.length,
      "globals.css 没有声明共享包的 @source",
    ).toBeGreaterThan(0);
    expect(
      sourceRoots.filter((sourceRoot) => !fs.existsSync(sourceRoot)),
      "@source 指向不存在的目录时 Tailwind 不会报错，只会漏掉共享组件的 utility；" +
        "Lucide 图标会因此退回默认的 24px。",
    ).toEqual([]);
  });
});

/**
 * 圆角三档的期望值，从**包的声明算出来**而不是手抄一张表。
 *
 * 本站曾经用 6/10/14（写死在自己的 `@theme inline` 里，旧 design decision 5），
 * 于是每一个共享包组件在本站都比桌面端圆约 1.7 倍 —— 最扎眼的是转录头像：
 * 包的 `MESSAGE_AVATAR_CLASS` 是 `size-7 rounded-lg`，28px 配 14px 半径恰好是正圆，
 * 桌面端那里是个 8px 的圆角方块。2026-08-19 撤销这处分叉，改为跟随包。
 *
 * 期望值算出来而不是钉死：包哪天调 `--radius`，这里跟着变，只有「本站又分叉了」
 * 或者「包把 calc 链拆了」才会红。
 */
const REM_PX = 16;

function resolveRadius(step: string): number {
  const base = packageRoot["--radius"];
  const baseMatch = /^([\d.]+)rem$/.exec(base ?? "");
  if (!baseMatch) throw new Error(`包没声明 --radius，或者不再是 rem：${base}`);
  const basePx = Number(baseMatch[1]) * REM_PX;
  const expr = packageTheme[`--radius-${step}`];
  if (expr === "var(--radius)") return basePx;
  const calc = /^calc\(var\(--radius\)\s*([+-])\s*([\d.]+)px\)$/.exec(
    expr ?? "",
  );
  if (!calc) throw new Error(`包的 --radius-${step} 不是认得出的形态：${expr}`);
  return calc[1] === "+" ? basePx + Number(calc[2]) : basePx - Number(calc[2]);
}

const RADIUS_STEPS = ["sm", "md", "lg", "xl"] as const;

describe("圆角跟随共享包，不再分叉", () => {
  it.each(RADIUS_STEPS)("本站 @theme 不声明 --radius-%s", (step) => {
    // 声明一条就是分叉一档。`@theme inline` 会把字面量**编进工具类**、不产出
    // `--radius-*` 自定义属性，所以分叉之后没法再按子树覆盖回来 —— 包组件与本站
    // 组件只能一起圆或一起不圆。真要分叉，先把理由写在 docs/design.md 的 Radius 一节。
    expect(theme[`--radius-${step}`]).toBeUndefined();
  });

  it.each([
    ["sm", 4],
    ["md", 6],
    ["lg", 8],
    ["xl", 12],
  ] as const)("rounded-%s 解析成 %ipx（与桌面端同值）", (step, px) => {
    expect(resolveRadius(step)).toBe(px);
  });
});

describe("本站独有的 @theme 声明", () => {
  it("globals.css 里有 @theme 块", () => {
    expect(block("@theme")).not.toBe("");
  });

  it("font-mono 挂了 --font-mono，且引用 JetBrains Mono", () => {
    // 本站自托管 JetBrains Mono（拉丁子集），包里那份是系统等宽栈，
    // 所以这条覆盖是有意的。
    expect(theme["--font-mono"]).toContain("JetBrains Mono");
  });
});

describe("从包里继承来的关键工具类仍然成立", () => {
  it("shadow-overlay 有对应的 --shadow-*", () => {
    // Dialog / Sheet 的投影。2026-08-19 之前这是本站独有的 token，
    // 现在在包里（桌面端 dialog.tsx 那条字面阴影和它逐字节相同）。
    expect(packageTheme["--shadow-overlay"]).toBe("var(--overlay-shadow)");
  });

  it("bg-scrim 有对应的 --color-*", () => {
    // token 名 --overlay-scrim 和工具类名 scrim 对不上，最容易在迁移时漏掉。
    expect(packageTheme["--color-scrim"]).toBe("var(--overlay-scrim)");
  });

  it("状态色的『当文字用』角色可用", () => {
    // 本站 25 处 text-status-running / text-status-waiting 靠这两个新 token 才达标。
    expect(packageRoot["--status-running-text"]).toBeTruthy();
    expect(packageRoot["--status-waiting-text"]).toBeTruthy();
  });
});

describe("自托管字体", () => {
  it("globals.css 里为 JetBrains Mono 声明了 @font-face", () => {
    // decls() 只认 `--name: value;` 形态的自定义属性，@font-face 里的
    // font-family / src 都是普通 CSS 属性，decls() 会返回空对象——
    // 这里必须直接在 block() 取到的原始块文本上断言。
    const face = block("@font-face");
    expect(face).toMatch(/font-family:\s*["']JetBrains Mono["']/);
  });
});

describe("源码只用已声明的 token", () => {
  /**
   * 语义 token 词表：出现在这些工具类后面的名字必须是声明过的 token。
   * 词表现在来自**包 + 本站**两处的并集——包是主体，本站只剩 radius / font。
   */
  const VOCAB = new Set(
    [...Object.keys(packageRoot), ...Object.keys(root)]
      .filter((n) => isColor(packageRoot[n] ?? root[n]))
      .map((n) => n.slice(2))
      .concat("scrim"),
  );

  /**
   * 语义 token 的词根：`primary-soft` 的词根是 `primary`。
   *
   * 判据是「词根是我们的语义色、但整个名字一次都没声明过」，例如 bg-secondary-soft
   * ——只有 --secondary 与 --secondary-foreground 存在，-soft 那一档从来没有过。
   * Tailwind v4 对不认识的名字不报错，只是不生成任何规则，页面上表现为「那一块
   * 没有底色」；而 DOM 里的 class 属性照样在，靠 `querySelector(".bg-x")` 写的
   * 断言因此照样是绿的。这条守卫补的就是那个缺口：token **声明**齐不齐上面已经
   * 测过，这里测的是**用法**没有越出声明。
   */
  const ROOTS = new Set([...VOCAB].map((n) => n.split("-")[0]));
  /*
    名字里允许有数字：token 家族里有两组是编号的（包的 --agent-1…16、本站的
    --heat-0…4）。此前捕获组是 `[a-z][a-z-]*`，`bg-heat-4` 只能捕到 `heat-`，
    于是**每一处编号 token 的用法都被判成越界**——这条守卫实际上把整整两组 token
    禁掉了，而它们本来就是声明过的。加上数字之后 `bg-heat-4` 对得上 VOCAB 里的
    `heat-4`，而写错的 `bg-heat-9` 仍然红。
  */
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
        new RegExp(`\\b(?:${UTILITIES})-([a-z][a-z0-9-]*)\\b`, "g"),
      )) {
        const name = m[1];
        // 只管词根落在词表里的名字；text-sm / border-2 / ring-offset-background
        // 这类 Tailwind 内建的词根不是语义色，不在管辖内。
        if (VOCAB.has(name) || !ROOTS.has(name.split("-")[0])) continue;
        missing.push(`${path.relative(FRONTEND_ROOT, file)}: ${m[0]}`);
      }
    }
    expect(missing, "用了没声明的 token 变体").toEqual([]);
  });
});
