import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Transcript from "@/components/session/Transcript";
import {
  createTranscriptProjector,
  reduceFrames,
  type TranscriptFrame,
} from "@agentre-hub/agentre-ui";

import "@/i18n";

/**
 * 转录正文由共享包 `@agentre-hub/agentre-ui` 渲染后的行为守卫。
 *
 * 改之前这个组件把助手消息塞进 `<p>`、把工具入参塞进裸 `<pre>` —— 而它当时
 * **一条渲染用例都没有**，所以换成共享组件时没有任何测试变红。这份用例把那段
 * 空白补上，锁住「正文走共享渲染器」这件事本身。
 *
 * 输入刻意是 **wire 事件帧**而不是手搓的消息对象：本站真实的输入就是帧，
 * 归约与渲染合起来才是「用户看到什么」。中间那层单独的单元测试在
 * `transcript-frames.test.ts`。
 */

let seq = 0;
function f(event: Record<string, unknown>): TranscriptFrame {
  return { sessionId: 1, event, seq: ++seq };
}

function renderFrames(...frames: TranscriptFrame[]) {
  return render(
    <Transcript messages={reduceFrames(frames, 1)} sessionId={1} />,
  );
}

describe("Transcript", () => {
  it("给定助手消息含 markdown，当渲染，则真的解析成 markdown 而不是纯文本", () => {
    const { container } = renderFrames(
      f({ kind: "text_delta", text: "hello **world**" }),
    );

    // <strong> 存在才说明 markdown 真的跑了；此前是 `<p>{text}</p>`，
    // 星号会原样显示给用户。
    expect(container.querySelector("strong")?.textContent).toBe("world");
  });

  it("给定用户消息含 markdown 记号，当渲染，则与助手消息一样解析成 markdown", () => {
    // 本站此前刻意让用户消息保持字面量（理由是「用户输入的原样就是它的意思」），
    // 而桌面端一直按 markdown 渲染 —— 包里的 MessageBody 对所有 text 块一视同仁，
    // 没有按角色分支。接入共享渲染器时对齐到桌面端那一侧。
    const { container } = renderFrames(
      f({ kind: "user_message", text: "a **b** c" }),
    );

    expect(container.querySelector("strong")?.textContent).toBe("b");
  });

  it("给定工具调用，当渲染，则出工具卡并带上工具名", () => {
    renderFrames(
      f({
        kind: "tool_use_start",
        id: "tu-1",
        name: "Bash",
        input: { command: "ls -la" },
      }),
    );

    expect(screen.getByText("Bash")).toBeTruthy();
  });

  it("给定空列表，当渲染，则仍是空态文案", () => {
    render(<Transcript messages={[]} sessionId={1} />);

    expect(screen.getByText("No messages yet.")).toBeTruthy();
  });

  /**
   * 行间距必须与桌面端同一套刻度，理由不是「好看」而是**可读性**：
   * 一条助手消息会摊成好几行（思考 / 正文 / 工具卡各一行），消息之间的间距
   * 如果不明显大于消息内部的行距，读者就分不出「这还是刚才那条」还是「换人了」。
   *
   * 桌面端 chat.tsx:rowWrapperPad 是 `isLastRowOfMessage ? pb-7 : pb-2.5`
   * （28px / 10px）。本站此前是一律 space-y-3（12px）—— 两档压成一档，
   * 于是整段转录糊成一片。
   */
  it("给定一条助手消息摊成多行，当渲染，则消息内用 pb-2.5、消息末行用 pb-7", () => {
    const { container } = renderFrames(
      f({ kind: "text_delta", text: "先看一下" }),
      f({ kind: "tool_use_start", id: "tu-1", name: "Read", input: {} }),
    );

    const pads = [...container.querySelectorAll("[data-row-pad]")].map(
      (el) => el.className,
    );

    // 两行同属一条助手消息，所以只有最后一行是消息末行。
    expect(pads.length).toBe(2);
    expect(pads[0]).toContain("pb-2.5");
    expect(pads[pads.length - 1]).toContain("pb-7");
  });

  it("给定用户消息与助手消息相邻，当渲染，则各自的末行都是 pb-7", () => {
    const { container } = renderFrames(
      f({ kind: "user_message", text: "帮我看看" }),
      f({ kind: "text_delta", text: "好的" }),
    );

    const pads = [...container.querySelectorAll("[data-row-pad]")].map(
      (el) => el.className,
    );

    // 两条消息各一行，两行都是各自的末行 —— 消息之间必须是大间距。
    expect(pads.length).toBe(2);
    expect(pads.every((cls) => cls.includes("pb-7"))).toBe(true);
  });

  /**
   * 这一组钉住的是本轮修掉的那个症状本身。
   *
   * 此前记账帧（usage / runtime_status / context_window_updated /
   * tool_permission_resolved）会各自铺成一张「未知事件」JSON 卡，**并且**每铺
   * 一张就切一次消息段 —— 于是一轮助手被劈成好几条，各自长出一个头像 +
   * 「Assistant」抬头，而那些卡又不在包的对话列里。
   */
  it("给定一轮里夹着记账帧，当渲染，则不出现「未知事件」卡，一轮仍是一条消息", () => {
    const { container } = renderFrames(
      f({ kind: "text_delta", text: "我先读一下。" }),
      f({
        kind: "usage",
        usage: { promptTokens: 1200, completionTokens: 340 },
      }),
      f({ kind: "runtime_status", status: "compacting" }),
      f({ kind: "context_window_updated", tokens: 42000 }),
      f({ kind: "text_delta", text: "读完了。" }),
    );

    expect(container.textContent).not.toContain("Unknown");
    expect(container.textContent).not.toContain("usage");
    // 一条消息 = 一个头像抬头。此前这里会是四条。
    expect(screen.getAllByText("Assistant").length).toBe(1);
  });

  it("给定授权请求随后被批准，当渲染，则只有一张卡且带着工具名（不是第二张未知事件卡）", () => {
    const { container } = renderFrames(
      f({
        kind: "tool_permission_request",
        requestId: "r9",
        toolName: "Edit",
        input: { file_path: "internal/api/router.go" },
      }),
      f({ kind: "tool_permission_resolved", requestId: "r9", allowed: true }),
    );

    expect(container.textContent).not.toContain("tool_permission_resolved");
    expect(screen.getByText("Edit")).toBeTruthy();
  });

  /**
   * 本站自渲染的块曾经横在对话列外面：包的内容列是 `max-w-measure`（720px），
   * 本站那些块是外层容器的整宽（768px），左右各探出去一截。现在没有本站自渲染的
   * 块了，所以每一行都该在包的列里。
   */
  it("给定各种形态混在一段里，当渲染，则每一行都在包的对话列内", () => {
    const { container } = renderFrames(
      f({ kind: "user_message", text: "帮我看看" }),
      f({ kind: "text_delta", text: "好的。" }),
      f({ kind: "tool_use_start", id: "tu-1", name: "Read", input: {} }),
      f({ kind: "tool_result", toolCallId: "tu-1", content: "package a" }),
      f({ kind: "compact_boundary", preTokens: 120000, trigger: "auto" }),
      f({ kind: "brand_new_kind", payload: 1 }),
    );

    const rows = [...container.querySelectorAll("[data-row-pad]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 行 wrapper 只负责间距；内容列的宽度由包内部的 max-w-measure 决定，
      // 所以这里钉的是「本站没有再往外套一层自己的块」。
      expect(row.className).not.toContain("border");
      expect(row.className).not.toContain("bg-");
    }
  });

  /**
   * 「这一轮还在跑」的三点。
   *
   * 此前这里恒为 false，理由写在 `Transcript.tsx` 的文件头：「本站没有流式增量
   * 渲染，live 系列 props 恒为静态空值」。那句话对**正文**成立（中转事件流是
   * 到一条画一条），对**指示器**不成立：三点说的是「对端还在生成」，与正文是不是
   * 一帧一帧长出来无关。少了它，用户发完一条消息后对着一段不动的转录，分不清是
   * 在跑还是发丢了。
   *
   * 判据与桌面端 `chat.tsx` 逐字同构：末行 && 在跑 && 这条是最后一条助手消息。
   */
  it("给定这一轮还在跑，当渲染，则末条助手消息后出现三点", () => {
    render(
      <Transcript
        messages={reduceFrames(
          [
            f({ kind: "user_message", text: "帮我看看" }),
            f({ kind: "text_delta", text: "好的。" }),
          ],
          1,
        )}
        sessionId={1}
        streaming
      />,
    );

    expect(screen.getByRole("status", { name: "Generating" })).toBeTruthy();
  });

  // 缺省不出：「只读转录」是一个合法形态（共享包 live-state 的注释点名说了这件
  // 事），历史会话不该无缘无故永远转着三个点。
  it("给定这一轮已经结束，当渲染，则没有三点", () => {
    renderFrames(
      f({ kind: "text_delta", text: "好的。" }),
      f({ kind: "done" }),
    );

    expect(screen.queryByRole("status", { name: "Generating" })).toBeNull();
  });

  // 三点只挂在**最后一条**助手消息上：一段转录里出现两个「正在生成」，等于说
  // 有两轮同时在跑。
  it("给定前面还有别的助手消息，当渲染，则只有最后一条带三点", () => {
    render(
      <Transcript
        messages={reduceFrames(
          [
            f({ kind: "text_delta", text: "第一轮。" }),
            f({ kind: "done" }),
            f({ kind: "user_message", text: "再来" }),
            f({ kind: "text_delta", text: "第二轮。" }),
          ],
          1,
        )}
        sessionId={1}
        streaming
      />,
    );

    expect(screen.getAllByRole("status", { name: "Generating" })).toHaveLength(
      1,
    );
  });

  /**
   * 通道断了就先说通道（共享包 transcript-row-view 的契约：断连形态优先于
   * 三点）。此刻「还在生成吗」根本观察不到，继续转三个点是在替远端撒谎。
   */
  it("给定通道在重连，当渲染，则出断连指示器而不是三点", () => {
    render(
      <Transcript
        messages={reduceFrames([f({ kind: "text_delta", text: "好的。" })], 1)}
        sessionId={1}
        streaming
        reconnecting
      />,
    );

    expect(
      screen.getByRole("status", { name: "Connection lost, reconnecting" }),
    ).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Generating" })).toBeNull();
  });
});

/**
 * 行缓存必须真的传下去。
 *
 * 包里 `TranscriptRowView` 是 `React.memo`，它成立的前提写在
 * `transcript-rows.d.ts` 的 `cache` 字段上：「persisted 消息的 blocks 引用稳定 →
 * 缓存命中返回同一 row 对象数组 → 行组件 React.memo 恒命中」。不传这个 WeakMap，
 * 每次重渲染都是全部行现场重建，memo 一次也命中不了——转录页每来一个 token 就
 * 把整段行组件重渲染一遍。桌面端 `chat.tsx` 传的正是这个。
 *
 * 引用稳定那一半由 `createTranscriptProjector` 负责（见 transcript-frames 的用例）；
 * 这里钉的是另一半：本站确实把缓存交给了包。
 */
describe("Transcript 的行缓存", () => {
  it("把一个跨渲染存活的 WeakMap 交给 buildSettledTranscriptRows", async () => {
    const pkg = await import("@agentre-hub/agentre-ui");
    const spy = vi.spyOn(pkg, "buildSettledTranscriptRows");
    try {
      const messages = reduceFrames([f({ kind: "text_delta", text: "hi" })], 1);
      const { rerender } = render(
        <Transcript messages={messages} sessionId={1} />,
      );
      rerender(<Transcript messages={messages} sessionId={1} reconnecting />);

      expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
      const caches = spy.mock.calls.map(([args]) => args.cache);
      expect(caches[0]).toBeInstanceOf(WeakMap);
      // 每次渲染新建一个 WeakMap 等于没有缓存,所以「同一个实例」才是这条断言的重点。
      for (const cache of caches) expect(cache).toBe(caches[0]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * 增量投影与行缓存必须合起来仍然渲染出最新正文。
 *
 * 两者各自都有用例，但各自都看不见对方：transcript-frames 那份只断言消息对象的
 * 引用，这份此前一直用 `reduceFrames` 现造消息（每次都是新对象，缓存必然 miss，
 * 等于没开缓存）。真正的线上组合是「投影器保持引用稳定 + 包按消息对象缓存行」，
 * 那条路径此前没有任何用例走过。
 */
describe("增量投影 + 行缓存", () => {
  it("逐帧追加时,转录渲染的是最新正文而不是缓存里的旧行", () => {
    const projector = createTranscriptProjector(1);
    const frames: TranscriptFrame[] = [];

    frames.push(f({ kind: "user_message", text: "问题" }));
    const { rerender } = render(
      <Transcript messages={projector.project(frames)} sessionId={1} />,
    );

    frames.push(f({ kind: "text_delta", text: "你" }));
    rerender(<Transcript messages={projector.project(frames)} sessionId={1} />);
    expect(screen.getByText("你")).toBeTruthy();

    frames.push(f({ kind: "text_delta", text: "好" }));
    rerender(<Transcript messages={projector.project(frames)} sessionId={1} />);

    expect(screen.getByText("你好")).toBeTruthy();
    // 先前那条用户消息一直在,不能被缓存挤掉。
    expect(screen.getByText("问题")).toBeTruthy();
  });
});

/**
 * 流式期间的正文必须走 `StreamingMarkdown`。
 *
 * 包里的分流在 `transcript-row-view` 上：`item.streaming ? <StreamingMarkdown/>
 * : <MessageBody/>`，而 `streaming` 只由 `liveTail` 那一段标出来
 * （`transcript-rows` 的 `appendText(liveTail, true)`）。也就是说——不把仍在生长的
 * 尾巴单独交出去，这条路径就永远走不到，每来一个 token 都是整段 markdown 连同
 * highlight.js 的语言探测重跑一遍，开销 O(n²)。包的注释把这件事写得很直白：
 * 「把单 chunk 渲染开销从 O(n) 降到 O(Δ)」。
 *
 * 与之配套的安全性质写在第二条里：摘出去的那一段必须原样回到画面上，一次，
 * 不能重复也不能丢。
 */
describe("流式正文的增量渲染", () => {
  it("把仍在生长的那条消息的尾巴交给 liveByMessageId", async () => {
    const pkg = await import("@agentre-hub/agentre-ui");
    const spy = vi.spyOn(pkg, "applyLiveTranscriptRows");
    try {
      const messages = reduceFrames(
        [f({ kind: "text_delta", text: "正在生成的正文" })],
        1,
      );
      render(<Transcript messages={messages} sessionId={1} streaming />);

      const live = spy.mock.calls.at(-1)?.[1].liveByMessageId;
      expect(live?.get(messages[0].id)?.liveTail).toBe("正在生成的正文");
    } finally {
      spy.mockRestore();
    }
  });

  it("摘出去的尾巴原样回到画面上,不重复也不丢", () => {
    const messages = reduceFrames(
      [
        f({ kind: "text_delta", text: "开头" }),
        f({ kind: "tool_use", toolCallId: "c1", name: "read", input: {} }),
        f({ kind: "text_delta", text: "结尾" }),
      ],
      1,
    );
    render(<Transcript messages={messages} sessionId={1} streaming />);

    expect(screen.getAllByText("开头")).toHaveLength(1);
    expect(screen.getAllByText("结尾")).toHaveLength(1);
  });

  it("一轮结束后不再有 live 内容,正文仍然只出现一次", () => {
    const messages = reduceFrames(
      [f({ kind: "text_delta", text: "说完了" }), f({ kind: "done" })],
      1,
    );
    render(<Transcript messages={messages} sessionId={1} />);

    expect(screen.getAllByText("说完了")).toHaveLength(1);
  });
});

/**
 * 行虚拟化。
 *
 * 一条长对话有上千行，此前全部常驻 DOM：内存与每次强制同步布局（详情页的钉底
 * effect 每帧要读一次 scrollHeight）都按行数线性增长。开窗之后只挂视口内的那些。
 *
 * 回落是有意的，而且与详情页「够不够一屏」那条 effect 同一条原则：量不出视口高度
 * 时那是**「不知道」而不是「视口为零」**——判成后者会一行都画不出来。jsdom 里没有
 * 布局，所以用例走的正是这条回落。
 */
describe("转录的行虚拟化", () => {
  it("给不出滚动容器时整列渲染,不吞行", () => {
    const messages = reduceFrames(
      Array.from({ length: 12 }, (_, i) =>
        f({ kind: "user_message", text: `第${i}条` }),
      ),
      1,
    );
    render(<Transcript messages={messages} sessionId={1} />);

    for (let i = 0; i < 12; i++) {
      expect(screen.getByText(`第${i}条`)).toBeTruthy();
    }
  });

  it("开窗时行外层带着虚拟器要用的下标,且总高由 spacer 撑出来", () => {
    const messages = reduceFrames(
      Array.from({ length: 6 }, (_, i) =>
        f({ kind: "user_message", text: `行${i}` }),
      ),
      1,
    );
    // jsdom 量不出高度,这里把视口补出来逼出开窗那一支。两处各测各的:组件用
    // clientHeight 判「量不量得出视口」,而 virtual-core 的 observeElementRect 读的
    // 是 offsetHeight/offsetWidth。
    const host = document.createElement("div");
    for (const [prop, value] of [
      ["clientHeight", 600],
      ["clientWidth", 800],
      ["offsetHeight", 600],
      ["offsetWidth", 800],
    ] as const) {
      Object.defineProperty(host, prop, { configurable: true, value });
    }
    document.body.append(host);

    const { container } = render(
      <Transcript
        messages={messages}
        sessionId={1}
        getScrollElement={() => host}
      />,
    );

    const spacer = container.querySelector("[data-transcript-spacer]");
    expect(spacer).toBeTruthy();
    // 行外层必须带 data-index：虚拟器的 measureElement 靠它认行。
    expect(container.querySelectorAll("[data-index]").length).toBeGreaterThan(
      0,
    );
    host.remove();
  });
});

/**
 * 一轮的 meta（模型 · ↑↓ · 首字 · 耗时 · 速率）。
 *
 * 画这一行的 `TranscriptMessageMeta` 一直就是共享包的 —— 本站从来没有自己的一份。
 * 它此前全是空值，是因为数据没上过 wire：模型只在终态帧 `runtime.runResultDone`
 * 上（`usage` 帧根本没有这个字段），计时由 agentred 就着它扇出的同一条事件流量出
 * 来。宿主把那一帧压成一条空的 `done` 标记，于是 meta 恒为「模型 —、耗时 0.0s」。
 *
 * 这一组从**帧**进（本站真实的输入就是帧），钉住那条链路真的通到了像素。
 */
describe("Transcript 的一轮 meta", () => {
  it("给定终态帧带模型与计时，当渲染，则 meta 栏画出来", async () => {
    renderFrames(
      f({ kind: "text_delta", text: "好的" }),
      f({
        kind: "done",
        model: "claude-sonnet-4-6",
        durationMs: 9640,
        firstTokenMs: 8010,
        tokensPerSec: 14.2,
      }),
    );

    expect(await screen.findByText("claude-sonnet-4-6")).toBeTruthy();
    expect(screen.getByText("9.6s")).toBeTruthy();
    expect(screen.getByTestId("message-first-token").textContent).toContain(
      "8.0s",
    );
    expect(screen.getByTestId("message-tokens-per-sec").textContent).toContain(
      "14 tok/s",
    );
  });

  /**
   * 老 agentred 答不出这三个数：那时一格都不该画。渲染成「0.0s」等于把「没上报」
   * 说成「这一轮零耗时」。
   */
  it("给定终态帧不带计时，当渲染，则不编出 0.0s", () => {
    renderFrames(f({ kind: "text_delta", text: "好的" }), f({ kind: "done" }));

    expect(screen.queryByText("0.0s")).toBeNull();
    expect(screen.queryByTestId("message-first-token")).toBeNull();
    expect(screen.queryByTestId("message-tokens-per-sec")).toBeNull();
  });

  /**
   * 一轮还在跑时终态帧还没来 —— 而这一轮用的是哪个模型，本站此刻就知道（底栏那颗
   * pill 正显示着它）。桌面端把它作为 `fallbackModel` 交给行渲染器，本站此前不交，
   * 于是流式期间模型那一格是空的，等 done 到了才「跳」出一个名字。
   */
  it("给定还没收到终态帧，当渲染，则模型退到会话此刻钉的那一个", async () => {
    render(
      <Transcript
        messages={reduceFrames([f({ kind: "text_delta", text: "在写了" })], 1)}
        sessionId={1}
        fallbackModel="glm-5.3"
      />,
    );

    expect(await screen.findByText("glm-5.3")).toBeTruthy();
  });
});
