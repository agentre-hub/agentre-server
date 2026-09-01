/**
 * 一条虚拟通道声明的目标（决策 10 的两种形式，决策 11 的入口分流）。
 *
 * 连接本身没有目标：`/v1/relay/client` 上不再有 `daemon_fingerprint`，一个账号
 * 一条连接，每条通道开通时自己说要接哪条对话或哪台机器。
 *
 * 分流不是将就：
 *  - **已保存的对话**走 `conversation:` —— 服务端查名单解析出承载它的机器，
 *    客户端全程不知道也不需要知道那是哪一台（对话页、跨机器的统一列表、深链接）；
 *  - **机器轴**走 `machine:` —— 机器作用域的操作（目录选择器、引擎设置、技能
 *    目录、`session.list`、派发计划）、**新建对话**（对话尚不存在，服务端解析不
 *    出目标）、以及**从机器轴点开的未保存对话**（它们在服务端没有索引行，而机器
 *    是用户刚选定的，本来就在上下文里）。
 *
 * 两种通道共用同一条 socket，「一个账号一条 WebSocket」不因分流打折。
 */

/** 与服务端 relay_svc.TargetPrefixConversation 同一个词。 */
export const ConversationTargetPrefix = "conversation:";

/** 与服务端 relay_svc.TargetPrefixMachine 同一个词。 */
export const MachineTargetPrefix = "machine:";

/** 按对话寻址：服务端解析出承载机器。 */
export function conversationTarget(conversationId: string): string {
  return `${ConversationTargetPrefix}${conversationId}`;
}

/** 按机器寻址：机器是调用方刚选定的那一台。 */
export function machineTarget(fingerprint: string): string {
  return `${MachineTargetPrefix}${fingerprint}`;
}
