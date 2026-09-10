import type {
  AnswerToolPermissionInput,
  AnswerUserQuestionInput,
  TranscriptPorts,
} from "@agentre-hub/agentre-ui";

/**
 * 浏览器端的对话流端口实现 —— 与桌面端 `transcript-ports-desktop.ts` 对位。
 *
 * 包的端口文档把这条边界说得很清楚：「渲染什么进包，**按下去会发生什么由宿主
 * 注入**」。桌面端注入 Wails 绑定，这边注入 relay RPC。
 *
 * ## 为什么从常量改成了工厂
 *
 * 此前这里是一个模块级常量，五个必需端口全是 `notWiredYet()` 抛错，理由写的是
 * 「交互卡只在 block 带 canonical 时才渲染，而中转事件流里没有 canonical，所以
 * 这条链路上它们不可达」。归约器改成产出包的 DTO（共享包的 `reduceFrames`）之后
 * 那个前提不成立了：canonical 现在真的会产出来，授权卡与提问卡会带着**能点的
 * 按钮**渲染出来。再留着抛错的桩，就是给用户一个点下去必炸的按钮。
 *
 * 所以能做的两个接到真的 RPC 上，做不到的三个如实保留抛错 —— 见下。
 */

/** 宿主要提供的两个提交动作。sessionId / peerFingerprint 由调用方自己闭包进去。 */
export interface ServerTranscriptPortDeps {
  submitToolPermission(input: AnswerToolPermissionInput): Promise<unknown>;
  submitAnswer(input: AnswerUserQuestionInput): Promise<unknown>;
}

/**
 * 这三个动作**中继上没有对应方法**。
 *
 * wire 的方法表（`constants.gen.ts`）里与决策相关的只有 `runtime.submitAnswer`
 * 与 `runtime.submitToolPermission` 两条；OpenClaw 的工具/exec 审批与计划动作
 * 都是桌面端经 Wails 直连本机 runtime 做的，没有走中继的形态。
 *
 * 抛错而不是 no-op：一个点了什么都不发生的按钮只有用户能发现，而抛错当场暴露。
 * 目前这三条也确实到不了 —— 归约器不产带 actions 的计划块，exec 审批卡在没有
 * `allowedDecisions` 时是只读的。哪天它们能点了，这里就是那次改动的入口。
 */
function notWiredYet(action: string): never {
  throw new Error(
    `Transcript port "${action}" has no relay method on the browser host`,
  );
}

export function createServerTranscriptPorts(
  deps: ServerTranscriptPortDeps,
): TranscriptPorts {
  return {
    // 契约：失败要**冒泡**给卡片自己的错误态，包内不吞异常、不做 toast。
    // 所以这里不 catch —— 吞掉的话按钮会显示成功，而那台机器上的工具还阻塞着。
    async answerToolPermission(input) {
      await deps.submitToolPermission(input);
    },
    async answerUserQuestion(input) {
      await deps.submitAnswer(input);
    },

    // OpenClaw 网关的工具审批 / exec 审批、以及计划动作：中继没有对应方法。
    answerToolApproval: () => notWiredYet("answerToolApproval"),
    resolveExecApproval: () => notWiredYet("resolveExecApproval"),
    resolvePlanAction: () => notWiredYet("resolvePlanAction"),

    // 外链是浏览器**本来就有**的能力，如实提供。
    openExternalURL(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },

    // openPath / readWorkspaceFile 是桌面能力（在文件管理器里打开、读工作区文件），
    // 浏览器里不存在。按包的约定，**不提供**就等于告诉组件「宿主没有这个能力」，
    // 组件会把对应入口整个不渲染 —— 而不是渲染出来点下去失败。
  };
}
