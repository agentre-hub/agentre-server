/**
 * 会话的地址（规格 2026-09-17-chat-session-url「Address contract」）。
 *
 * 一条会话只有 `/chat/:conversationId` 这一个入口：身份就是全局唯一的
 * conversation_id，已保存的会话凭它就认得出承载机器（账号镜像那一行的
 * device_fingerprint）。只有账号里还没有的会话要带 `?device=`——那时除了用户刚点的
 * 那台机器，没有别处说得出它在哪。
 *
 * 查询参数分两类：索引**范围**（axis / machine …）属于左栏，打开、切换、关闭会话
 * 时原样带着走；`device` 属于这一条会话的寻址，`compose` 是一次性的动作，两者都
 * 不随范围带走。
 */

/** 只属于某一次寻址或某一次动作、不算索引范围的参数。 */
const NON_SCOPE_PARAMS = ["device", "compose"] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** conversation_id 是 UUID；别的形状不必去问服务端。 */
export function isConversationId(value: string): boolean {
  return UUID_RE.test(value);
}

/** `?device=` 是账号设备的数字 id，只认正整数。 */
export function readDeviceParam(search: URLSearchParams): number | null {
  const raw = search.get("device");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

function scopeParams(search?: URLSearchParams | string): URLSearchParams {
  const params = new URLSearchParams(search ?? "");
  for (const key of NON_SCOPE_PARAMS) params.delete(key);
  return params;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/**
 * 一条会话的地址。`device` 只在会话还没进账号时给；`search` 是当前地址上的查询串，
 * 范围参数从它那里继承。
 */
export function sessionAddress(
  conversationId: string,
  opts: { device?: number } = {},
  search?: URLSearchParams | string,
): string {
  const params = scopeParams(search);
  if (opts.device !== undefined) params.set("device", String(opts.device));
  return withQuery(`/chat/${encodeURIComponent(conversationId)}`, params);
}

/** 不开任何会话的 `/chat`，带着当前的索引范围。 */
export function chatIndexAddress(search?: URLSearchParams | string): string {
  return withQuery("/chat", scopeParams(search));
}
