/**
 * `conversation_id` 在浏览器这一侧的铸法。
 *
 * 一条对话在桌面端、agentred 与 server 三套库以及线格式上的**唯一身份**（决策 1），
 * 由**发起端**在建档那一刻铸出来。浏览器发起一条对话时发起端就是它自己，所以号在
 * 这里铸——不向 server 要：那会让新建对话需要联网 + 登录，而且 server 将知晓每条
 * 对话的存在。
 *
 * 版本取 UUIDv7：前 48 位是毫秒时间戳，因此新铸的 id 在索引里天然近似有序；其余位
 * 取自 CSPRNG，唯一性无需任何协调（这正是 v7 的价值，也是「不需要发号器」的理由）。
 * 与桌面仓 `internal/pkg/conversationid.New()` 是同一件事、同一种布局（本仓不再
 * 铸号，那个包只在桌面仓）。
 *
 * `crypto.randomUUID()` 只给 v4，用不了；这里自己按 RFC 9562 §5.7 拼。
 */

const HEX = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, "0"),
);

/**
 * 取 16 字节随机数。
 *
 * 非安全上下文（http 部署）里 `crypto.getRandomValues` 仍然可用——它不像
 * `crypto.subtle` 那样被安全上下文限制住，所以这里没有需要兜底的真实浏览器。
 *
 * 取不到就**如实报错**，不退回 `Math.random`。铸出来的这个值是四张镜像表的主键，
 * 唯一性完全由这 74 位随机承担（v7 没有发号器可以复核）；用一个可预测的 PRNG 悄悄
 * 顶上，只会在没人看得见的环境里把「不需要协调」这个前提换掉。一个铸不出号的浏览器
 * 本来就发不起对话，当场失败比发一个来路不明的主键便宜。
 */
function randomBytes(length: number): Uint8Array {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error("conversation id requires crypto.getRandomValues");
  }
  const bytes = new Uint8Array(length);
  webCrypto.getRandomValues(bytes);
  return bytes;
}

/** 铸一条新对话的 `conversation_id`（UUIDv7，规范小写带连字符形式）。 */
export function newConversationId(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  // 前 48 位：Unix 毫秒。用除法而不是位运算——JS 的 `>>>` 先把操作数截成 32 位，
  // 48 位的时间戳会被削掉一半。
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  // 版本位 7 与 RFC 4122 变体位 10。
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => HEX[b]).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 这个取值能不能当 `conversation_id` 用。
 *
 * 只接受**规范形式**：36 字符、小写、带连字符、非全零——与桌面仓
 * `conversationid.Validate` 同一条判据。放行大写 / 花括号 / 无连字符等变体等于让
 * 同一条对话有多种写法，而这个值要当路由键与数据库主键用；全零能解析但不指称任何
 * 对话，一律视为「没给」。
 */
export function isConversationId(value: string): boolean {
  return (
    CANONICAL_UUID.test(value) &&
    value !== "00000000-0000-0000-0000-000000000000"
  );
}
