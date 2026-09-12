/**
 * 调用方这一半的宿主契约守卫：**凡是可能打到 desktop 机器的调用点，它用的方法必须
 * 在「桌面端答得出」的集合里。**
 *
 * 被调方那一半由桌面仓钉着（`internal/pkg/wireinbound` 的 `Contract()` 加两条守卫：
 * 每个宿主注册的处理器与契约表逐条对齐）。调用方这一半此前没人钉：那张表里「谁会发
 * 这个方法」「判据是 enginePorts.ts:457」全是**人手写的**，而判据指向的是本仓库。
 * 本仓新增一个调用点、或者把某处 `onlineAgentred()` 放宽成 `executionDevice()`，
 * 桌面仓不会有任何地方变红。
 *
 * 这类缺陷的形状是固定的：控制台把方法发给了桌面端机器，而桌面端根本没注册它，前端
 * `catch` 成空结果 —— 看起来和「这台机器上什么都没有」一模一样，没有任何地方会红。
 *
 * ## 判据从哪来（为什么这是机械可判的）
 *
 * 一条中继请求打到哪台机器，只由它那条**虚拟通道声明的目标**决定，而目标只有两种
 * 造法（`lib/relayTarget.ts`）：
 *
 *   - `conversationTarget(id)` —— 服务端按名单解析出承载机器，两种 kind 都可能；
 *   - `machineTarget(fp)` —— 用户点名的那一台，两种 kind 都可能。
 *
 * `EXECUTION_DEVICE_KINDS` 含 `desktop`，所以**默认每个调用点都能打到 desktop**。
 * 唯一的例外是把目标限死在 agentred 上的路径，而全仓只有一条：`enginePorts` 的
 * `relayRequest()` → `onlineAgentred()`（`kind === "agentred"` 的那个过滤）。
 *
 * 所以判法是「默认能打到 desktop，例外必须显式声明」——失败方向朝**严**：漏声明的
 * 新例外会被当成能打到 desktop，逼作者回到这张表上说清楚。
 *
 * 下面五条各守一段：
 *   1. 能打到 desktop 的方法 ⊆ desktopAnsweredMethods（正题）；
 *   2. 声明为 agentred 专属的方法 ⊆ agentredAnsweredMethods（它总得有人答）；
 *   3. 「agentred 专属」这个声明**本身**仍然成立（放宽成 executionDevice 会红）；
 *   4. 没有第三种取通道目标的路子（新增一种会红）；
 *   5. 方法名不是动态取的、`rpcMethods` 不换名导入（否则上面四条统统看不见）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// 两个数组的真身由桌面仓的 wireinbound.Contract() 生成(减掉 KnownGaps()),落在
// agentre-wire 的 host-contract.gen.ts,随本仓 package.json 的 commit 钉子进来。
// 桌面仓改了契约而这边没挪钉子时,下面「⊆」那两条会红,不会静默变绿。
import {
  agentredAnsweredMethods,
  desktopAnsweredMethods,
} from "@agentre-hub/agentre-wire";

const FRONTEND_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const SRC_ROOT = path.join(FRONTEND_ROOT, "src");

/** 共享包里那个方法表的模块说明符。换名导入会让下面的扫描全部失明。 */
const WIRE_PACKAGE = "@agentre-hub/agentre-wire";
const RPC_METHODS_IMPORT = "rpcMethods";

/**
 * 声明为 **agentred 专属**的调用路径。
 *
 * 每一条的含义是：这个文件里、作为实参交给这个函数的 `rpcMethods.X`，其目标机器被
 * 限死在 kind === "agentred" 上，因此**不必**由桌面端答得出。
 *
 * 加一条进来不是免检——第 3 条用例会去核实这个声明此刻还成立。
 */
const AGENTRED_ONLY_CALLERS: readonly {
  file: string;
  callee: string;
  /** 限死在 agentred 上的那个取机器函数。第 3 条用例据它核实。 */
  via: string;
  why: string;
}[] = [
  {
    file: "src/lib/enginePorts.ts",
    callee: "relayRequest",
    via: "onlineAgentred",
    why: "供应商级的连通性检测 / 模型发现不绑机器，随便挑一台在线 agentred 问即可；桌面端不注册 engineDiscover。",
  },
];

/** 取一条通道的三个入口。目标就是它们的第一个实参。 */
const CHANNEL_ENTRYPOINTS = new Set([
  "withRelayClient",
  "acquireRelayClient",
  "useRelayChannel",
]);

/** 造通道目标的两个函数（`lib/relayTarget.ts`）。 */
const TARGET_BUILDERS = new Set(["machineTarget", "conversationTarget"]);

/**
 * 目标只是**穿过**这里、由调用方决定的入口。
 *
 * 两条，都是入口自己转交给下一层入口：`useRelayChannel` 把收到的 target 原样递给
 * `acquireRelayClient`，`withRelayClient` 也是。它们的每个调用方都在第 4 条用例的
 * 扫描范围内（三个入口全在 CHANNEL_ENTRYPOINTS 里），所以这两条不是漏洞。
 */
const TARGET_PASSTHROUGH: readonly { file: string; callee: string }[] = [
  { file: "src/hooks/use-relay.ts", callee: "acquireRelayClient" },
  { file: "src/lib/relayClientPool.ts", callee: "acquireRelayClient" },
];

// ── 扫描 ────────────────────────────────────────────────────────────────────

interface SourceFileEntry {
  rel: string;
  text: string;
  ast: ts.SourceFile;
}

/** 生产源码：`src/` 下除测试与测试设施之外的全部 .ts/.tsx。 */
function productionSources(): SourceFileEntry[] {
  const out: SourceFileEntry[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, item.name);
      const rel = path.relative(FRONTEND_ROOT, abs);
      if (item.isDirectory()) {
        if (item.name === "__tests__" || item.name === "test") continue;
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(item.name)) continue;
      if (/\.(test|spec)\.tsx?$/.test(item.name)) continue;
      const text = fs.readFileSync(abs, "utf8");
      out.push({
        rel,
        text,
        ast: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true),
      });
    }
  };
  walk(SRC_ROOT);
  return out;
}

const sources = productionSources();

function lineOf(entry: SourceFileEntry, node: ts.Node): number {
  return (
    entry.ast.getLineAndCharacterOfPosition(node.getStart(entry.ast)).line + 1
  );
}

function eachNode(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => eachNode(child, visit));
}

/** 被调者的名字：`foo(...)` → "foo"，`a.b(...)` → "b"。 */
function calleeName(call: ts.CallExpression): string | null {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

/**
 * 一处 `rpcMethods.X`：它在哪、是哪个方法、被谁当实参收走了。
 *
 * 「被谁收走」是分类的判据：`relayRequest(rpcMethods.engineTest, …)` 与
 * `relayCall(fp, rpcMethods.engineTest, …)` 是同一个方法的两个调用点，目标机器的
 * 可能范围却完全不同 —— 所以分类的粒度必须是**调用点**，不是方法。
 */
interface MethodUse {
  file: string;
  line: number;
  method: string;
  /** 把它当实参收走的那个函数；不是实参（比如只是读一下）时为 null。 */
  consumer: string | null;
}

function collectMethodUses(): MethodUse[] {
  const uses: MethodUse[] = [];
  for (const entry of sources) {
    eachNode(entry.ast, (node) => {
      if (!ts.isPropertyAccessExpression(node)) return;
      if (!ts.isIdentifier(node.expression)) return;
      if (node.expression.text !== RPC_METHODS_IMPORT) return;
      // 往上找第一个「把我当实参」的调用。中间可能隔着 as / 括号 / 对象字面量。
      let child: ts.Node = node;
      let consumer: string | null = null;
      for (let p = node.parent; p; p = p.parent) {
        if (ts.isCallExpression(p) && p.arguments.some((a) => a === child)) {
          consumer = calleeName(p);
          break;
        }
        child = p;
      }
      uses.push({
        file: entry.rel,
        line: lineOf(entry, node),
        method: node.name.text,
        consumer,
      });
    });
  }
  return uses;
}

const methodUses = collectMethodUses();

function isAgentredOnly(use: MethodUse): boolean {
  return AGENTRED_ONLY_CALLERS.some(
    (rule) => rule.file === use.file && rule.callee === use.consumer,
  );
}

/** 这一处调用点的人话地址，红的时候直接照着去看。 */
function where(use: MethodUse): string {
  return `${use.file}:${use.line} rpcMethods.${use.method}`;
}

// ── 用例 ────────────────────────────────────────────────────────────────────

describe("能打到 desktop 的调用点只用桌面端答得出的方法", () => {
  it("扫到了调用点（扫空了说明扫描本身坏了，不是「没有违规」）", () => {
    expect(methodUses.length).toBeGreaterThan(30);
    expect(new Set(methodUses.map((u) => u.file)).size).toBeGreaterThan(10);
  });

  /**
   * 正题。默认每个调用点都能打到 desktop；只有 AGENTRED_ONLY_CALLERS 声明过的那些
   * 例外，而例外的真实性由下面第三条核实。
   */
  it("每一处可能打到 desktop 的方法都在 desktopAnsweredMethods 里", () => {
    const answered = new Set(desktopAnsweredMethods);
    const offenders = methodUses
      .filter((use) => !isAgentredOnly(use))
      .filter((use) => !answered.has(use.method))
      .map(where);
    expect(
      [...new Set(offenders)].sort(),
      "这些调用点的目标机器可能是 desktop，而桌面端不注册这个方法：请求会被对端拒掉，前端 catch 成空结果，看起来和「这台机器上什么都没有」一模一样",
    ).toEqual([]);
  });

  /** 例外那一档也得有人答得出，否则它谁都打不到。 */
  it("声明为 agentred 专属的方法在 agentredAnsweredMethods 里", () => {
    const answered = new Set(agentredAnsweredMethods);
    const offenders = methodUses
      .filter(isAgentredOnly)
      .filter((use) => !answered.has(use.method))
      .map(where);
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  /**
   * 例外声明的**真实性**。
   *
   * 这一条是整道守卫的支点：只要有人把 `relayRequest` 里的 `onlineAgentred()` 放宽成
   * `executionDevice()`（目标从此可能是 desktop），或者另开一条限死 agentred 的路
   * 却不声明，这里就红。
   */
  it("AGENTRED_ONLY_CALLERS 里每条声明此刻仍然成立", () => {
    for (const rule of AGENTRED_ONLY_CALLERS) {
      const entry = sources.find((s) => s.rel === rule.file);
      expect(entry, `${rule.file} 不在生产源码里了`).toBeTruthy();

      const fns = new Map<string, ts.Node>();
      const identifierCounts = new Map<string, number>();
      eachNode(entry!.ast, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) {
          fns.set(node.name.text, node);
        }
        if (ts.isIdentifier(node)) {
          identifierCounts.set(
            node.text,
            (identifierCounts.get(node.text) ?? 0) + 1,
          );
        }
      });

      const caller = fns.get(rule.callee);
      expect(caller, `${rule.file} 里找不到函数 ${rule.callee}`).toBeTruthy();

      // (a) 它仍然经那个限死 agentred 的取机器函数拿目标。
      let viaUsed = false;
      eachNode(caller!, (node) => {
        if (ts.isIdentifier(node) && node.text === rule.via) viaUsed = true;
      });
      expect(
        viaUsed,
        `${rule.callee} 不再经 ${rule.via} 取机器了：它的目标可能已经不再限于 agentred，请重新判定它发的方法`,
      ).toBe(true);

      // (b) 那个取机器函数仍然按 kind === "agentred" 过滤。
      const picker = fns.get(rule.via);
      expect(picker, `${rule.file} 里找不到函数 ${rule.via}`).toBeTruthy();
      let filtersAgentred = false;
      eachNode(picker!, (node) => {
        if (!ts.isBinaryExpression(node)) return;
        if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
          return;
        if (!ts.isPropertyAccessExpression(node.left)) return;
        if (node.left.name.text !== "kind") return;
        if (!ts.isStringLiteral(node.right)) return;
        if (node.right.text === "agentred") filtersAgentred = true;
      });
      expect(
        filtersAgentred,
        `${rule.via} 不再按 kind === "agentred" 过滤了`,
      ).toBe(true);

      // (c) 它没有第二个使用方。多一个就说明有一条没声明的 agentred 专属路径 ——
      //     那条路上的方法会被这道守卫当成「能打到 desktop」而误报，作者得回到
      //     AGENTRED_ONLY_CALLERS 上说清楚。
      expect(
        identifierCounts.get(rule.via),
        `${rule.via} 的出现次数变了：除了它自己的声明，应当只有 ${rule.callee} 用它`,
      ).toBe(2);
    }
  });
});

describe("通道目标只有两种造法", () => {
  /**
   * 上面那套判法的前提：一条请求打到哪台机器，只由通道目标决定，而目标只能由
   * `machineTarget` / `conversationTarget` 造出来。多一种造法（比如从 URL 直接拼一个
   * 目标串）就意味着多一类没被判定过的调用点。
   */
  it("每个取通道的入口，第一个实参都源自 machineTarget / conversationTarget", () => {
    const offenders: string[] = [];
    for (const entry of sources) {
      // 同文件里的 `const x = …`，用于跟一层局部变量。
      const locals = new Map<string, ts.Node>();
      eachNode(entry.ast, (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer
        ) {
          locals.set(node.name.text, node.initializer);
        }
      });

      const buildsTarget = (node: ts.Node): boolean => {
        let found = false;
        eachNode(node, (n) => {
          if (!ts.isCallExpression(n)) return;
          const name = calleeName(n);
          if (name && TARGET_BUILDERS.has(name)) found = true;
        });
        return found;
      };

      eachNode(entry.ast, (node) => {
        if (!ts.isCallExpression(node)) return;
        const name = calleeName(node);
        if (!name || !CHANNEL_ENTRYPOINTS.has(name)) return;
        const arg = node.arguments[0];
        if (arg === undefined) return;
        if (buildsTarget(arg)) return;
        // 跟一层局部变量：SessionDetailView 的 relayTarget 是个三目，两支各造一种。
        if (ts.isIdentifier(arg)) {
          const init = locals.get(arg.text);
          if (init && buildsTarget(init)) return;
        }
        if (
          TARGET_PASSTHROUGH.some(
            (p) => p.file === entry.rel && p.callee === name,
          )
        ) {
          return;
        }
        offenders.push(`${entry.rel}:${lineOf(entry, node)} ${name}(…)`);
      });
    }
    expect(
      offenders.sort(),
      "这里的通道目标不是由 machineTarget / conversationTarget 造的：本守卫判不出它能打到哪种机器",
    ).toEqual([]);
  });
});

describe("扫描赖以成立的两个前提", () => {
  it("rpcMethods 一律以原名从共享包导入", () => {
    const offenders: string[] = [];
    for (const entry of sources) {
      eachNode(entry.ast, (node) => {
        if (!ts.isImportDeclaration(node)) return;
        if (!ts.isStringLiteral(node.moduleSpecifier)) return;
        if (node.moduleSpecifier.text !== WIRE_PACKAGE) return;
        const bindings = node.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) return;
        for (const el of bindings.elements) {
          if (el.propertyName?.text !== RPC_METHODS_IMPORT) continue;
          // `import { rpcMethods as m }` 之后，下面按标识符名扫的那一路全瞎。
          offenders.push(`${entry.rel}:${lineOf(entry, el)} → ${el.name.text}`);
        }
      });
    }
    expect(offenders, "rpcMethods 换名导入会让本守卫静默失明").toEqual([]);
  });

  it("方法不是按变量动态取的", () => {
    const offenders: string[] = [];
    for (const entry of sources) {
      eachNode(entry.ast, (node) => {
        if (!ts.isElementAccessExpression(node)) return;
        if (!ts.isIdentifier(node.expression)) return;
        if (node.expression.text !== RPC_METHODS_IMPORT) return;
        offenders.push(`${entry.rel}:${lineOf(entry, node)}`);
      });
    }
    expect(
      offenders,
      "rpcMethods[expr] 取出来的方法是运行期才定的，本守卫看不见",
    ).toEqual([]);
  });
});

/**
 * 本守卫**管不到**的两处，写在这里免得下一个人以为它全覆盖：
 *
 *  1. **Go 后端自己发的那些**（`mirror_svc` / `sessionimport_svc` 经 wirecall 发的
 *     activityRollup 与转录导入四条）。它们不经 `rpcMethods`，而且那 5 条在 TS 侧
 *     压根没有 descriptor，两个数组里都没有。给它们立守卫要另一条路（直接 pin
 *     `wireinbound.Contract()` 那个 Go 包）。
 *
 *  2. **反方向**：「可能打到 agentred 的调用点必须在 agentredAnsweredMethods 里」。
 *     本仓确实有一处 desktop 专属的写法 —— `projectSetLocalPath` /
 *     `projectClearLocalPath` 只发给 desktop（agentred 走 REST），判据在
 *     `lib/projectPorts.ts` 的 `writeMachinePath` / `clearMachinePath` 里，而调用点
 *     在 `lib/projectLocalPath.ts`。判据与调用点**不在同一个文件**，上面这套按
 *     「谁把它当实参收走」分类的办法看不见它，硬加只会得到一条靠约定俗成的假守卫。
 */
