import {
  CanonicalToolRouter,
  ThinkingBlock,
  TranscriptPortsProvider,
  TranscriptUIStateProvider,
  type TranscriptBlock,
  type TranscriptPorts,
  cn,
} from "@agentre-hub/agentre-ui";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/**
 * 共享包 `@agentre-hub/agentre-ui` 在**浏览器端**的接入证明。
 *
 * 这份用例存在的理由：包是从 Wails 桌面端抽出来的，桌面端跑得通**证明不了**
 * 它在这边跑得通 —— 桌面端有 vite 别名、有 wailsjs 生成物、有 zustand store，
 * 而这里一样都没有。真正的验收只有一条：在 server 前端里 import 它、渲染它、
 * 拿到人话文案而不是原始 key。
 */

describe("shared UI package integration", () => {
  it("Given the server i18n instance, When a package component renders, Then it resolves copy from the package namespace", () => {
    render(
      <TranscriptUIStateProvider>
        <ThinkingBlock text="reasoning about the task" streaming={false} />
      </TranscriptUIStateProvider>,
    );

    // 取到的必须是人话。没把包的 bundle 并进 server 的 i18n 实例时，
    // 这里会是 "thinking.done" 这类原始 key —— 那正是要拦的失败。
    expect(screen.getByText("Thought complete")).toBeTruthy();
    expect(screen.queryByText(/^thinking\./)).toBeNull();
  });

  it("Given a browser-side ports implementation, When a canonical tool card renders, Then it drives the host through the port instead of Wails", async () => {
    // 这条是抽包的**全部前提**：卡片对宿主的依赖只剩 TranscriptPorts。
    // 桌面端喂 Wails 绑定，这里喂一个纯函数实现 —— 同一套卡片两端都能用。
    const answerToolPermission = vi.fn().mockResolvedValue(undefined);
    const ports: TranscriptPorts = {
      answerToolPermission,
      answerUserQuestion: vi.fn().mockResolvedValue(undefined),
      answerToolApproval: vi.fn().mockResolvedValue(undefined),
      resolveExecApproval: vi.fn().mockResolvedValue({ ok: true }),
      resolvePlanAction: vi.fn().mockResolvedValue({ ok: true }),
    };

    const toolBlock: TranscriptBlock = {
      type: "tool_permission_request",
      toolUseId: "tu-1",
      canonical: {
        kind: "tool.permission",
        toolPermission: {
          requestId: "req-1",
          toolName: "Bash",
          toolInput: { command: "ls -la" },
        },
      },
    };

    render(
      <TranscriptPortsProvider ports={ports}>
        <TranscriptUIStateProvider>
          <CanonicalToolRouter toolBlock={toolBlock} sessionId={7} />
        </TranscriptUIStateProvider>
      </TranscriptPortsProvider>,
    );

    // 卡片认出了 canonical kind 并渲染了工具授权形态（而不是回落 RawToolCard）。
    expect(screen.getByText("Bash")).toBeTruthy();
  });
});

/**
 * 本站不得留着共享包已经发布的那些组件的**副本**。
 *
 * 这条守的失败很安静：副本与包里那份此刻逐字节相同（`ui/button.tsx`、
 * `ui/input.tsx` 曾经就是，除 import 路径外一字不差），所以什么都不会红；
 * 等包那边改了一处 —— 加一档 size、换一个 focus ring、改一个语义 token ——
 * 桌面端跟着走，本站还留在原地，而两边的 `git log` 各看各的，没人会发现。
 *
 * `components/console/StatusMark.tsx` 已经这么漂过一次，四档状态色全部走偏，
 * 浅色下对比度掉到 2.07:1。那次是手抄一份映射，这次是手抄整个组件，同一类。
 *
 * 判据两条：
 *   1. 包已发布的名字，本站 `src/components/ui/` 下**根本不该有同名文件**。
 *      转发层曾经是有意保留的过渡物（`@/components/ui/*` 是本仓的 shadcn 约定），
 *      过渡结束后它只剩两种可能：要么是副本，要么是一层什么都不做的间接 ——
 *      而它的存在会让本仓同时有两种 import 写法，下一个人不知道该学哪种。
 *   2. 万一还是留了一份（KEEP_LOCAL 登记过的除外），它必须是从包 re-export。
 *
 * 第 2 条单独存在时是**会空过的**：文件删掉之后 `it.each` 一个用例都不生成，
 * 于是「全绿」既可能是「都转发了」也可能是「都不见了」。第 1 条把这个洞堵上。
 */
describe("共享包已发布的组件，本站不留副本", () => {
  const UI_DIR = path.join(FRONTEND_ROOT, "src/components/ui");
  const PACKAGE_UI_DIR = path.join(
    FRONTEND_ROOT,
    "node_modules/@agentre-hub/agentre-ui/src/ui",
  );

  /**
   * 登记「本站刻意保留自己那份」的理由。空着就是没有分叉 ——
   * 往里加一条要写清楚包里那份为什么不够用。
   */
  const KEEP_LOCAL: Array<[string, string]> = [];

  const packaged = new Set(
    fs
      .readdirSync(PACKAGE_UI_DIR)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => f.replace(/\.tsx?$/, "")),
  );

  it("包确实发布了 ui 组件（读不到的话下面那条是假绿）", () => {
    expect(packaged.size).toBeGreaterThan(0);
  });

  it("包已发布的名字，本站不再有同名文件", () => {
    const shadowed = fs
      .readdirSync(UI_DIR)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => f.replace(/\.tsx$/, ""))
      .filter((name) => packaged.has(name))
      .filter((name) => !KEEP_LOCAL.some(([kept]) => kept === name))
      .sort();

    expect(
      shadowed,
      `这些名字包里已经有了，本站不该再有一份：${shadowed.join(", ")}。` +
        `哪怕内容只是一行转发，也会让本仓同时存在两种 import 写法。` +
        `真要保留自己那份，去 KEEP_LOCAL 里登记理由。`,
    ).toEqual([]);
  });
});

/**
 * `cn` 也必须是包里那一份。
 *
 * 包的 `cn` 不是裸 `twMerge`：它用 `extendTailwindMerge` 把三个自定义字号
 * token（`text-prose` / `text-aux` / `text-meta`）注册成独立的 font-size 组。
 * 不注册的话 tailwind-merge 的启发式会把它们误判进 **text-color** 冲突组，
 * 于是「字号 + 文字颜色」写在一起时，字号被静默丢掉 —— 不报错，不警告，
 * 只是字变大了一号。
 *
 * 本站此前是裸 twMerge。当时还咬不到（本站源码一个 text-aux 都没用），
 * 但包里那句注释点名说了「不要在单个组件文件里再建局部 cn()」，本站整份就是
 * 那个局部 cn；转录接上包的排版之后它就会开始咬。
 */
describe("cn 走包里那一份", () => {
  it.each([
    ["text-meta", "text-muted-foreground"],
    ["text-aux", "text-status-error"],
    ["text-prose", "text-foreground"],
  ])("cn(%s, %s) 两个类都留下（字号不被当成文字颜色丢掉）", (size, color) => {
    const merged = cn(size, color);

    expect(merged, `${size} 被当成 text-color 丢掉了`).toContain(size);
    expect(merged).toContain(color);
  });
});

/**
 * 会话索引的**呈现件**也得用包里那一份。
 *
 * 上面那条 `components/ui` 的守卫只盖 shadcn 原语（`dist/ui`），射程止步于此 ——
 * 而漂得最久的恰恰是它够不着的地方：包 `60e7d4d4`「收下会话索引的契约、轴投影与
 * 六个呈现件」发布之后，`dist/session-index` 里的六件本站一件没接，索引照旧自己画
 * 行首字形、第二行、轴选择器。谁都没红，因为副本本来就跑得通 —— 直到包那边改了
 * 一处（轴选择器长出图标、第二行补上「随手对话」那一维），两端才开始各长各的。
 *
 * 判据：包在 `dist/session-index` 里发布的每一件，`SessionIndex.tsx` 要么用它，
 * 要么在 `KEEP_LOCAL` 里写下不用的理由。理由要说的是「包里那份为什么不够用」，
 * 不是「本站还没来得及接」。
 */
describe("会话索引的呈现件用包里那一份", () => {
  const SOURCE = fs.readFileSync(
    path.join(FRONTEND_ROOT, "src/components/session/SessionIndex.tsx"),
    "utf8",
  );

  /** 包在 `dist/session-index` 里对外发布的呈现件。 */
  const PRESENTATIONAL = [
    "SessionRow",
    "SessionGroup",
    "AxisPicker",
    "ProjectGlyph",
    "RowLeadingSlot",
    "RowSecondaryLine",
    "ProjectGroupHeader",
    "AgentGroupHeader",
    "MachineGroupHeader",
    "FreeGroupHeader",
    "OwnSessionsHeader",
  ] as const;

  /**
   * 本站暂时用不上的那几件，连同理由。
   *
   * 这一件卡在**组怎么分**上，不是「长什么样」：共享投影 `buildAxisGroups` 不切
   * 「父项目自己的会话」这个子分组，本站的项目轴因此没有它的挂点。要用它得先动
   * 投影，而投影是两端共用的，属于跨仓改动。
   *
   * `FreeGroupHeader` 曾经也在这份名单里，理由是「共享投影只在有 orphan 行时才摆
   * 这一组，桌面端那个是常驻组头」——那说的是**组什么时候存在**，不是**组头长什么
   * 样**。组存在的那些时候，画它的就该是同一件（2026-08-22「组头归一」）。
   */
  const KEEP_LOCAL: Array<[(typeof PRESENTATIONAL)[number], string]> = [
    [
      "ProjectGlyph",
      "已经由包里的 ProjectGroupHeader 与 RowLeadingSlot 在内部用掉了（组头与行是" +
        "同一枚字形，只是尺寸档不同）；本站再直接引一次就是第二个调用点。",
    ],
    [
      "OwnSessionsHeader",
      "共享投影不切「父项目自己的会话」这个子分组，本站的项目轴因此没有它的挂点；" +
        "要接它得先动投影，那是两端共用的改动。",
    ],
  ];

  it("包确实发布了这些呈现件（读不到的话下面那条是假绿）", () => {
    const dir = path.join(
      FRONTEND_ROOT,
      "node_modules/@agentre-hub/agentre-ui/src/session-index",
    );
    const published = new Set(
      fs
        .readdirSync(dir)
        .filter((f) => /\.tsx?$/.test(f))
        .map((f) => f.replace(/\.tsx?$/, "")),
    );
    for (const file of [
      "session-row",
      "session-group",
      "axis-picker",
      "project-glyph",
      "row-leading-slot",
      "row-secondary-line",
      "group-header",
      "project-group-header",
      "agent-group-header",
      "machine-group-header",
      "free-group-header",
      "own-sessions-header",
    ]) {
      expect(published.has(file), `包里没有 ${file}`).toBe(true);
    }
  });

  it.each(
    PRESENTATIONAL.filter(
      (name) => !KEEP_LOCAL.some(([kept]) => kept === name),
    ),
  )("SessionIndex 用的是包里的 %s", (name) => {
    expect(
      new RegExp(`^\\s{2}${name},$`, "m").test(SOURCE),
      `${name} 没有出现在 SessionIndex 从 @agentre-hub/agentre-ui 的导入里。` +
        `包已经发布了它，本站再画一份不会报错，只会静默分叉。`,
    ).toBe(true);
  });

  it("本站不再自己声明这几件的同名实现（同名副本比不接更难发现）", () => {
    for (const name of ["Glyph", "ProjectGlyph", "AxisPicker"]) {
      expect(
        new RegExp(`function ${name}\\b`).test(SOURCE),
        `SessionIndex 里又出现了本地的 function ${name}`,
      ).toBe(false);
    }
  });
});

/**
 * 身份方块（规格 ../agentre/docs/specs/2026-08-21-index-glyph-and-machine-axis.md）。
 *
 * 这一枚记号此前有三份实现：桌面端的 AgentAvatar、包内私有的 Glyph、本站的
 * AgentGlyph —— 三份的兜底规则各不相同，同一个 Agent 在三处长成三个样子。
 * 现在只剩包里那一份，本站连一个同名副本都不该再有。
 */
/** src 下的全部 ts/tsx，用来做「仓内再无某个名字」这类文本扫描。 */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("身份字形只剩包里那一枚", () => {
  it("包确实发布了 AgentAvatar（读不到的话下面那条是假绿）", () => {
    const dir = path.join(
      FRONTEND_ROOT,
      "node_modules/@agentre-hub/agentre-ui/src/ui",
    );
    expect(fs.existsSync(path.join(dir, "agent-avatar.tsx"))).toBe(true);
  });

  it("本站再没有 AgentGlyph —— 文件与引用都不在了", () => {
    expect(
      fs.existsSync(
        path.join(
          FRONTEND_ROOT,
          "src/components/session/newconv/AgentGlyph.tsx",
        ),
      ),
      "AgentGlyph.tsx 还在：它是重复实现，不是宿主适配",
    ).toBe(false);

    const offenders = sourceFiles(path.join(FRONTEND_ROOT, "src"))
      // 排除这条守卫自己：它的文案里就写着那个名字，不排掉就永远自证有罪。
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => /\bAgentGlyph\b/.test(fs.readFileSync(file, "utf8")));
    expect(
      offenders,
      `这些文件还在引用 AgentGlyph：${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

/**
 * 滚动条那一对：CSS 与 hook 必须都接上。
 *
 * `base.css` 把滑块颜色绑到 `--sb-thumb` 并默认设成 transparent，
 * `useAutoHideScrollbars()` 在滚动时改这个变量的值。**只接一半不会报错**：
 * 只 import CSS 不调 hook，滚动条恒为透明（滚动仍然可用，只是看不见滑块）；
 * 只调 hook 不 import CSS，改的那个变量没人消费。
 *
 * import 那一半由 design-token-contract.test.ts 按包的 exports 逐个点名，
 * 这里补上 hook 那一半。
 */
describe("滚动条的两半都接上了", () => {
  it("App.tsx 调用了包里的 useAutoHideScrollbars", () => {
    const app = fs.readFileSync(
      path.join(FRONTEND_ROOT, "src/App.tsx"),
      "utf8",
    );

    expect(app).toContain("useAutoHideScrollbars()");
    expect(app).toContain("@agentre-hub/agentre-ui");
  });
});

/**
 * 加载骨架只有一份。
 *
 * 它原本是这一端的私有件（`components/session/TranscriptSkeleton.tsx`），桌面端
 * 另有一份四条静止灰块的手搓版。2026-08-23 那一轮以**这一份**为准收进共享包，
 * 两端此后共用；这里守的是本地那份没有偷偷长回来。
 */
describe("转录骨架只剩共享包那一份", () => {
  it("本地副本已删除，转录体从包里取", () => {
    expect(
      fs.existsSync(
        path.join(
          FRONTEND_ROOT,
          "src/components/session/TranscriptSkeleton.tsx",
        ),
      ),
    ).toBe(false);

    // 骨架随转录体一起从 SessionDetailView 搬进了 SessionScrollBody，守的是
    // 「本地那份没长回来」，跟着渲染它的那个组件走。
    const body = fs.readFileSync(
      path.join(FRONTEND_ROOT, "src/components/session/SessionScrollBody.tsx"),
      "utf8",
    );
    expect(body).toMatch(
      /import\s*\{[^}]*\bTranscriptSkeleton\b[^}]*\}\s*from\s*"@agentre-hub\/agentre-ui"/s,
    );
  });
});

/**
 * 2026-08-26 那一轮收进包的四件：wire 事件归约、主题、图标词表、上下文用量。
 *
 * 这四件此前本站各有一份完整实现，而包里那份是**同一份代码**（归约器是从本站反向
 * 搬进包的，逐字节相同）。副本删掉之后什么都不会红 —— 它本来就跑得通 —— 所以这里
 * 守的是它没有偷偷长回来：文件不在了，且宿主是从包里取的。
 *
 * 图标词表那一条尤其不是「样式一致」的问题：`key` 是持久化的 `avatar_icon` 列值，
 * 两端存的是同一行数据，各留一张清单的后果是一边认得、另一边渲染成空头像。
 */
describe("2026-08-26 收进共享包的四件，本站不留副本", () => {
  const read = (rel: string) =>
    fs.readFileSync(path.join(FRONTEND_ROOT, rel), "utf8");
  const exists = (rel: string) => fs.existsSync(path.join(FRONTEND_ROOT, rel));

  it.each([
    ["src/lib/transcriptFrames.ts", "wire 事件归约"],
    ["src/lib/theme.tsx", "主题"],
  ])("%s 已删除（%s 在包里）", (rel) => {
    expect(exists(rel), `${rel} 又回来了：它是重复实现，不是宿主适配`).toBe(
      false,
    );
  });

  it("包确实发布了这四件（读不到的话下面几条是假绿）", async () => {
    const ui = await import("@agentre-hub/agentre-ui");

    expect(typeof ui.reduceFrames).toBe("function");
    expect(typeof ui.createTranscriptProjector).toBe("function");
    expect(typeof ui.reduceSessionState).toBe("function");
    expect(typeof ui.ThemeProvider).toBe("function");
    expect(typeof ui.useTheme).toBe("function");
    expect(typeof ui.ThemeToggle).toBe("function");
    expect(typeof ui.iconList).toBe("function");
    expect(typeof ui.computeContextUsage).toBe("function");
    expect(ui.ICON_VOCABULARY.length).toBeGreaterThan(0);
  });

  it("归约器由会话详情与导入端口从包里取", () => {
    for (const rel of [
      "src/components/session/SessionDetailView.tsx",
      "src/lib/importPorts.ts",
    ]) {
      expect(
        /from\s+"@agentre-hub\/agentre-ui"/.test(read(rel)),
        `${rel} 没从包里取归约器`,
      ).toBe(true);
    }
    expect(read("src/lib/importPorts.ts")).toMatch(/\breduceFrames\b/);
  });

  it("主题由 main/App/AppControls 从包里取，本站不再自己排三态与图标", () => {
    expect(read("src/main.tsx")).toMatch(
      /import\s*\{[^}]*\bThemeProvider\b[^}]*\}\s*from\s*"@agentre-hub\/agentre-ui"/s,
    );
    expect(read("src/App.tsx")).toMatch(
      /import\s*\{[^}]*\buseTheme\b[^}]*\}\s*from\s*"@agentre-hub\/agentre-ui"/s,
    );

    const controls = read("src/components/AppControls.tsx");
    expect(controls).toMatch(
      /import\s*\{[^}]*\bThemeToggle\b[^}]*\}\s*from\s*"@agentre-hub\/agentre-ui"/s,
    );
    // 三态顺序与图标表是包的事；本站再排一份就会与桌面端各走各的。
    expect(controls).not.toContain("THEME_CYCLE");
    expect(controls).not.toContain("THEME_ICON");
  });

  it("图标词表由选择器从包里取，本站不再自建清单与文案", () => {
    const pickers = read("src/pages/org/orgPickers.tsx");

    expect(pickers).toMatch(
      /import\s*\{[^}]*\biconList\b[^}]*\}\s*from\s*"@agentre-hub\/agentre-ui"/s,
    );
    expect(pickers).not.toContain("ORG_ICONS");
    expect(pickers).not.toContain("ORG_ICON_BY_KEY");

    // 文案跟着清单走：留一棵 org.detail.icons 子树在这边，就又是两份会漂的表。
    for (const lang of ["en", "zh-CN"]) {
      const org = JSON.parse(read(`src/i18n/locales/${lang}/org.json`)) as {
        detail: Record<string, unknown>;
      };
      expect(
        org.detail.icons,
        `${lang} 还留着 org.detail.icons`,
      ).toBeUndefined();
    }
  });

  it("上下文用量由 sessionView 转出包里那一份", () => {
    expect(read("src/lib/sessionView.ts")).toMatch(
      /export\s*\{\s*computeContextUsage\s*\}\s*from\s*"@agentre-hub\/agentre-ui"/,
    );
  });
});
