/**
 * 「新对话」里「最近用过」那一组的数据源。
 *
 * 只住在这个浏览器里：这是一份使用习惯，不是账号数据。存进账号意味着加字段、
 * 加迁移、加一个写入端点，还要想清楚多端之间怎么合并——为一个排序付这个代价
 * 不值。代价是换个浏览器就记不住，换来的是这一整组功能不依赖后端。
 *
 * 三处读写都吞掉 localStorage 的异常（隐私模式、配额满）：记不住最多是下次不
 * 显示「最近用过」，绝不该让「新对话」整个打不开。
 */
export const RECENT_AGENTS_KEY = "agentre.chat.recentAgents";

/** 这一组是入口不是历史：再长就不再是「最近」，只会把「可以开」挤下去。 */
const LIMIT = 5;

export function readRecentAgents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_AGENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 逐项校验而不是整体断言：存的东西是上一版本的自己写的，格式变过就当没记过，
    // 不能让一条脏数据把列表渲染成一堆 undefined。
    return parsed.filter((v): v is string => typeof v === "string" && v !== "");
  } catch {
    return [];
  }
}

/** 记一次「刚用过它」。已经在列表里就提到最前，不留下两条。 */
export function rememberAgent(syncId: string): void {
  if (!syncId) return;
  const next = [syncId, ...readRecentAgents().filter((id) => id !== syncId)];
  try {
    localStorage.setItem(
      RECENT_AGENTS_KEY,
      JSON.stringify(next.slice(0, LIMIT)),
    );
  } catch {
    // 见文件头：记不住不是错误路径。
  }
}
