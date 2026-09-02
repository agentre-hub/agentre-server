import {
  ReasoningEffortPicker,
  type ReasoningEffortValue,
} from "@agentre-hub/agentre-ui";

/**
 * 输入框底栏右侧那颗「思考力度」控件。会话详情与「还没发第一句」的草稿共用同一个 ——
 * 与旁边的模型 pill 同一条理由：第一句和第二句该是同一件事。
 *
 * 视图、六档词表、有效档位的合成与 no-op 判据整个住在共享包里（规格 2026-09-01
 * 决策 8）；这里只把宿主手上的东西喂进去：会话行上的值、后端配置那一档、一个回调，
 * 外加双写的结果如实说一句。
 */
export default function SessionReasoningEffortControl({
  value,
  backendValue,
  onChange,
  note,
}: {
  /**
   * 会话行上的值（空串 = 跟随后端配置）。它同时是共享控件的 no-op 判据：会话行为空
   * 而后端配的是 high 时，用户显式选 high 是一次真实写入，不是空操作。
   */
  value: string;
  /** 后端配置的档位，会话行为空时由它兜底显示。空串 = 后端也没配。 */
  backendValue: string;
  onChange: (next: ReasoningEffortValue) => void;
  /** 旁边那一行如实说明（另一台没跟上 / 两台都写失败）。 */
  note?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ReasoningEffortPicker
        // 两格在 wire / REST 上都是裸 string（写入前已由执行端按那张六档表校验），
        // 窄化的做法与后端编辑器里那一处一致。
        value={value as ReasoningEffortValue}
        backendValue={backendValue as ReasoningEffortValue}
        onChange={onChange}
        dataTestId="composer-reasoning-effort"
      />
      {/*
        说明摆在控件**旁边**而不是弹层里（共享控件的 errorText 那一格）：这一端的
        失败有一半是「只写成一台」——那不是错误，而是一句必须当场看见的实话，
        而弹层此刻已经关上了。模型 pill 的那一行说明是同一处置。
      */}
      {note ? (
        <span
          role="status"
          data-testid="composer-effort-note"
          className="min-w-0 truncate text-2xs text-muted-foreground"
        >
          {note}
        </span>
      ) : null}
    </div>
  );
}
