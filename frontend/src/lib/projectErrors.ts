/**
 * 一次写失败该给用户看什么。
 *
 * 服务端的业务码自带 i18n 文案（`internal/pkg/code`），`ApiError.message` 就是它；
 * 有正文就用正文——它比任何前端编的兜底都具体（「该 Agent 已经是这个项目的成员」
 * 对比「保存失败」）。真的什么都没有时才落到调用方给的那句。
 */
import { ApiError } from "@/lib/api";

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message.trim()) return err.message;
  return fallback;
}
