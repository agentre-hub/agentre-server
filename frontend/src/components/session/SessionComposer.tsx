/**
 * 详情页钉在底上的那一带：输入框 + 单行底栏。
 *
 * 输入框是共享包的 `AIChatInput`（TipTap），与桌面端**同一个组件** —— 此前这里是
 * 一个裸 `<textarea>`：没有 @ 提及、没有 / 命令，也没有任何关于「按什么键发出去」
 * 的提示。形状与桌面端 `chat.tsx` 的 `ChatComposer` 同构：提示在框里，底栏一行摆
 * 快捷键提示与右侧的发送。
 *
 * **这一端接得上什么、接不上什么**是有依据的，不照抄桌面端那张表：
 *   @ 引用       接得上 —— Agent 提及序列化成 `<agent id="N">名字</agent>` 写进正文，
 *                「正文里是对的」（桌面端 chat_svc 的原话），模型读得懂。
 *                **设备**同样摆得上：`/v1/devices` 给得出指纹，而设备提及在正文里
 *                只存指纹（`<device fp="…">机器名</device>`）—— 那条消息被别的机器
 *                读到时，只有指纹还指得回同一台。这一端没有「本机」那一档：浏览器
 *                不是一台机器。
 *                **项目**提及不摆：它的 XML 带 `path` 属性，而服务端响应里一条路径
 *                都没有（R19），摆上去就是个空 path 的假引用。
 *   / 触发命令    接得上 —— 见 lib/slashCommands.ts 逐条对照的结果。
 *   $ 调用 Skill  接不上 —— 要列 skill 目录，那是桌面端的 Wails 绑定。
 *   ! 执行终端命令 接不上 —— wire 上没有任何 PTY / 本地执行方法。而 `AIChatInput`
 *                缺 `onCommandSubmit` 时会把 `!foo` **静默吞掉**，所以回调照接，
 *                只是拿来挡一下、如实说一句（见下面的 localCommandsEnabled）。
 *
 * 占位文案不在这里拼：`AIChatInput` 自己按上面这几样接上没有推（省略 `placeholder`
 * 时生效）。原先两端各按 backendType 查一张表，而 backendType 与「宿主接没接那些
 * 能力」无关，照抄就是许诺做不到的事。
 *
 * 审批**不**在这一带：对话流里已经有审批卡了，底下再摆一条是同一件事说两遍。
 */
import {
  buildMentionSources,
  ChatComposer,
  ContextMeter,
  PermissionModePill,
  type AIChatInputHandle,
  type ChatImageAttachment,
  type SlashCommand,
} from "@agentre-hub/agentre-ui";
import {
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { useDeviceMentions } from "@/hooks/use-device-mentions";
import type { PermissionModeMeta } from "@/lib/backendCapabilities";
import { buildSlashCommands } from "@/lib/slashCommands";

/** @ 菜单里可提及的 Agent。项目那一维不给，理由见文件头。 */
export interface ComposerAgent {
  id: number;
  name: string;
  avatarColor?: string;
}

export default function SessionComposer({
  backendType,
  agents,
  disabled,
  disabledReason,
  sending,
  onSubmit,
  contextUsage,
  feedback,
  handleRef,
  permissionMode,
  permissionModeMeta,
  permissionRuntimeKey,
  permissionHasActiveSession,
  permissionError,
  onPermissionModeChange,
  modelControl,
  reasoningEffortControl,
}: {
  backendType?: string;
  agents: ComposerAgent[];
  disabled: boolean;
  /** 发不出去时的如实说明（离线 / 设备已撤销 / 机器没升级）。 */
  disabledReason?: string | null;
  /**
   * 发送 RPC 在途。包据此把提交键转成 spinner。
   *
   * 它与 `disabled` 是两件事：按下之后到回声落地之前，用户那句话在转录里还不存在，
   * 三点也没点亮——把在途折进 `disabled` 的话，输入框整块变灰而屏幕上一个字都没有
   * 他刚说的话，这段窗口里界面看起来像卡住了。
   */
  sending?: boolean;
  onSubmit: (text: string, images?: ChatImageAttachment[]) => void;
  /**
   * 上下文用量。给不出（runtime 还没探到窗口）时整块不摆 —— 不拿一个编出来的
   * 分母画进度条。
   */
  contextUsage?: { used: number; max: number };
  /** 发送结果的反馈（失败 / 已排队）。 */
  feedback?: ReactNode;
  /** 当前生效的权限档位。 */
  permissionMode?: string;
  /**
   * 执行端报出来的档位元数据。
   *   - `undefined` = 还没问到（连着但应答没回来），控件不摆；
   *   - `null` = **问不出**（对端太老 / 机器答不上来），写一句说明为什么这里空着；
   *   - `allowedModes` 为空 = 这个后端没有权限门，控件同样不摆，且**不说话**。
   *
   * 三态在解码那一侧仍必须分开（拿空清单冒充「问不出」是句用户无法证伪的假话），
   * 但摆到界面上只剩两种处置：只有「本该有档却问不出」是异常，值得占一行说明；
   * 「这个后端就是没有权限门」是稳定答案，底栏空着本身已经把话说完了——桌面端
   * 也是这么办的，没有档可切就不摆那颗 pill。
   */
  permissionModeMeta?: PermissionModeMeta | null;
  /** 这条会话的 runtime key（claudecode 的 bypass 锁死规则要用）。 */
  permissionRuntimeKey?: string;
  /** 会话是否已经启动过（bypass 锁死判定的另一半）。 */
  permissionHasActiveSession?: boolean;
  /** 上一次切换失败的说明；null = 没有错误。 */
  permissionError?: string | null;
  onPermissionModeChange?: (value: string) => void;
  /**
   * 模型选择器整块由宿主递进来，而不是拆成七八个 prop 传进这里。
   *
   * 它要的东西（目录、解析出的四态、写入与回滚、两台机器的写入结果）全在宿主手上；
   * 把它们逐个搬过这道边界，只会让这个组件多知道一堆它不参与的事。`feedback` 那一
   * 格早就是这么办的。
   */
  modelControl?: ReactNode;
  /**
   * 思考力度控件整块同样由宿主递进来（理由同 modelControl）。它排在**右侧**、紧邻
   * 提交键（规格 2026-09-01 决策 9）：底栏左边是「怎么跑」，右边是「这一轮花多少」，
   * 思考力度属于后者。后端不支持时宿主根本不递，这一格连同它的空档一起消失。
   */
  reasoningEffortControl?: ReactNode;
  /**
   * 想从外面往输入框里塞字时给（草稿态的「快捷开头」按钮）。不给就用内部这只 ——
   * 富文本的内容住在编辑器里而不是 React state，外面拼字符串是够不着的。
   */
  handleRef?: RefObject<AIChatInputHandle | null>;
}) {
  const { t } = useTranslation();
  // 发送按钮走输入框自己的 submit：只有它知道富文本里的提及要序列化成什么。
  const ownRef = useRef<AIChatInputHandle>(null);
  const inputRef = handleRef ?? ownRef;
  /** 刚刚有一行以 `!` 开头被挡下来了（见 onCommandSubmit）。 */
  const [localCommandRejected, setLocalCommandRejected] = useState(false);

  const slashCommands = useMemo(() => {
    const all = buildSlashCommands((k) => t(k));
    // `filterByQuery` 不调 `resolve`，所以按 backend 过滤这件事必须宿主先做完 ——
    // 否则菜单里会列出这个后端根本不支持的命令。
    return backendType
      ? all.filter((c) => c.resolve(backendType) !== null)
      : [];
  }, [backendType, t]);

  const devices = useDeviceMentions();
  const mentionSources = useMemo(
    () =>
      buildMentionSources(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          avatarColor: a.avatarColor,
        })),
        [],
        devices,
      ),
    [agents, devices],
  );

  /** 上下文计量器：给不出窗口时整块不摆（不拿一个编出来的分母画进度条）。 */
  const contextMeter =
    contextUsage && contextUsage.max > 0 ? (
      <ContextMeter {...contextUsage} dataTestId="composer-context-meter" />
    ) : null;

  return (
    <div data-testid="session-detail-composer-form">
      <div data-testid="session-detail-composer">
        <ChatComposer
          inputHandleRef={inputRef}
          disabled={disabled}
          sending={sending}
          backendType={backendType}
          supportsImageInput
          sendButtonTestId="session-detail-send"
          slashCommands={slashCommands as SlashCommand[]}
          mentionSources={mentionSources}
          // 两个都给才启用 / 菜单（包的既定条件）。literal_text 由包自己填回编辑器，
          // 宿主这里没有 rpc 类命令要处理。
          onSlashSelect={() => {}}
          // 这一端没有 PTY 方法，`!` 真按下去执行不了 —— 说给包听，它据此在占位
          // 文案里不提这一段（否则「接了 onCommandSubmit」会被当成「! 能用」）。
          localCommandsEnabled={false}
          // 接这个回调**不是**为了执行本地命令，而是为了不让它静默吃字：包在缺
          // 这个回调时会把 `!` 开头的内容 clearContent 掉、既不发也不说 ——
          // 于是「!!! 这条很重要」这种普通消息会凭空消失。这里如实说一句，
          // 并把文本还回去。
          onCommandSubmit={(command) => {
            setLocalCommandRejected(true);
            // 包是在这个回调**返回之后**才 clearContent 的，所以要等它清完再填回去。
            setTimeout(() => inputRef.current?.loadDraft(`!${command}`), 0);
          }}
          onSubmit={(message) => {
            setLocalCommandRejected(false);
            onSubmit(message.text, message.images);
          }}
          // 发不出去时，快捷键提示这一格改说原因：再教一次「按 Enter 发送」
          // 是句废话，用户此刻需要的是「为什么发不出去」。
          shortcutsHint={
            disabled && disabledReason ? (
              <p
                id="session-compose-unavailable"
                data-testid="session-compose-unavailable"
                className="min-w-0 flex-1 truncate text-2xs text-muted-foreground"
              >
                {disabledReason}
              </p>
            ) : undefined
          }
          // 设置项跟在提示后，计量器贴着发送键 —— 与桌面端同一顺序。
          leadingControls={
            <div className="flex shrink-0 items-center gap-1">
              {permissionModeMeta !== undefined && onPermissionModeChange ? (
                permissionModeMeta === null ? (
                  <span className="text-2xs text-muted-foreground">
                    {t("session.composerControls.permissionUnavailable")}
                  </span>
                ) : permissionModeMeta.allowedModes.length === 0 ? null : (
                  <PermissionModePill
                    mode={permissionMode || permissionModeMeta.defaultMode}
                    modes={permissionModeMeta.order}
                    onSelect={onPermissionModeChange}
                    errorMessage={permissionError}
                    runtimeKey={permissionRuntimeKey}
                    hasActiveSession={permissionHasActiveSession}
                  />
                )
              ) : null}
              {modelControl}
            </div>
          }
          trailingControls={
            contextMeter || reasoningEffortControl ? (
              <>
                {contextMeter}
                {reasoningEffortControl}
              </>
            ) : null
          }
        />
      </div>
      {localCommandRejected && (
        <p
          role="status"
          data-testid="composer-local-command-unsupported"
          className="border-t border-border px-3.5 py-1.5 text-xs text-muted-foreground"
        >
          {t("composer.localCommandUnsupported")}
        </p>
      )}
      {feedback}
    </div>
  );
}
