import type {
  PickerProvider,
  TranscriptMessage,
} from "@agentre-hub/agentre-ui";

/**
 * 「这条会话此刻算作用哪个模型、它的上下文窗口多大」—— 事件流答不出时的兜底。
 *
 * ## 为什么需要它
 *
 * wire 上这两样都有长时间缺席的档：
 *
 *   - **模型**只挂在终态帧上（`usage` 帧没有这个字段），一轮跑着的时候没有；
 *   - **窗口**本该由 `context_window_updated` / `usage.contextWindow` 带来，而
 *     dev 环境的持久帧里这两样一条都没有 —— agentred 确实探到了窗口
 *     （fanout 日志里有 `ContextWindowUpdated:1`），却把那一跳 emit 成了
 *     `{"kind":"session_status","sessionStatus":{"contextWindow":N}}`，wire 上
 *     没有这个 kind，共享包认不出。修正源属于 agentre 仓。
 *
 * 桌面端两样都不受影响，因为它根本不看事件流：`chat_svc` 的
 * `resolveContextWindowWithRuntime` 有四级兜底，`latestAssistantModel` 从落库的
 * 消息里取模型。控制台手上只有帧，所以在这里补上同形的一条链。
 *
 * 纯函数，不碰任何宿主设施：目录怎么来（REST 的 `/v1/engine/providers`，见
 * `lib/engineCatalog`）由调用方解决，这里只认共享包的 `PickerProvider`。
 */

/**
 * 这条会话**上一次真的用过**的模型 ID；一条都没报过时是空串。
 *
 * 从后往前找第一条报得出模型的**助手**消息，与桌面端 `latestAssistantModel` 逐条
 * 同义 —— 特别是「末条助手消息的 `model` 还是空」时要继续往前找，而不是就此认输：
 * 正在跑的那一轮就是这个形状（消息已经开了，模型要等终态帧才填进来）。
 *
 * 空串是一个诚实的答案，调用方据此整块不摆。绝不退回「配置里写的那个模型」——
 * 那是**下一轮**会用的，不是这条会话用过的。
 */
export function lastUsedModelId(
  messages: readonly TranscriptMessage[],
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (message.model) return message.model;
  }
  return "";
}

/**
 * 目录里那个模型 ID 的上下文窗口；查不到（模型不在目录里、或目录没报窗口）是 0。
 *
 * 按 `modelId` 而不是 `modelKey` 查：这条链上两个入参都是模型 **ID** —— 终态帧带
 * 的是运行时上报的 ID，pill 解析出来的那一格（`ProviderPillState.modelId`）也是。
 * 同一个 ID 出现在多家供应商下时取第一个命中：窗口是模型自身的属性，同一个模型
 * 换一家接入不会变大变小；真不一致时也没有第二条判据可用。
 */
function catalogContextWindow(
  catalog: readonly PickerProvider[],
  modelId: string,
): number {
  if (!modelId) return 0;
  for (const provider of catalog) {
    const model = provider.models.find((m) => m.modelId === modelId);
    if (model?.contextWindow) return model.contextWindow;
  }
  return 0;
}

export interface ContextWindowInput {
  /** 事件流归约出来的那一格（`reduceSessionState` 的 contextWindow）。0 = 没探到。 */
  runtimeWindow: number;
  catalog: readonly PickerProvider[];
  /** 这条会话上一次真的用过的模型（`lastUsedModelId`）。 */
  lastUsedModelId: string;
  /** 这条会话此刻钉着 / 跟随解析到的模型（底栏那颗 pill 的 `modelId`）。 */
  pinnedModelId: string;
}

/**
 * 这条会话该按多大的窗口画进度条；答不出是 0（整块不摆）。
 *
 * 次序与桌面端 `resolveContextWindowWithRuntime` 同序，逐级同义：
 *
 *   1. **runtime 上报的窗口** —— 桌面端是会话行上那一格，本站是事件流归约出来的
 *      同一个值（两者都由 runtime 探测后写下，是这条链上唯一的实测值）。
 *   2. **上一次真的用过的模型**查目录 —— 已经发生过的事实，比配置更贴近这条会话
 *      真正在烧的那个窗口（续轮换过模型时尤其）。
 *   3. **此刻钉着的模型**查目录 —— 一轮都还没跑过时唯一说得出话的。
 *
 * 桌面端在 1 与 2 之间还有一级「有效 LLM 配置自带的 ContextWindow」（那是供应商
 * 配置上的显式覆盖值）。本站没有对应物：REST 目录上的 `context_window` 已经是
 * 2 / 3 查的那一格，再列一级只是把同一个数查两遍。
 *
 * 查不到就是 0，不编一个分母出来 —— 一条按错误上限画的进度条比没有进度条更糟，
 * 它会让用户在还早的时候就以为快满了（或反过来）。
 */
export function resolveContextWindow(input: ContextWindowInput): number {
  if (input.runtimeWindow > 0) return input.runtimeWindow;
  const used = catalogContextWindow(input.catalog, input.lastUsedModelId);
  if (used > 0) return used;
  return catalogContextWindow(input.catalog, input.pinnedModelId);
}
