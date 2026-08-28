import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 依赖目录与构建产物不该被版本控制跟踪。
 *
 * 起因是一次真事故（2026-08-21）：有人在**仓库根**跑了一次 vitest，它在 cwd 下
 * 建了 `node_modules/.vite/vitest/**\/results.json` 缓存；而当时 .gitignore 只按
 * 目录锚定忽略了 `/frontend/node_modules/` 与 `/e2e/node_modules/`，根级那个盖不到，
 * 于是它被 `git add` 一并扫了进去，直到看提交统计才发现。
 *
 * 光加一条 .gitignore 挡不住已经**被跟踪**的文件（gitignore 对已跟踪文件无效），
 * 所以这里查的是 `git ls-files` 而不是 `git status`：前者回答「仓库里现在有什么」，
 * 后者只回答「工作树此刻脏不脏」。
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/** 不该出现在版本控制里的路径片段。 */
const ARTIFACT_DIRS = ["node_modules/", "/dist/", ".vite/", "coverage/"];

describe("版本控制里没有依赖目录与构建产物", () => {
  const tracked = execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

  it("确实读到了文件清单（读不到的话下面那条是假绿）", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  it.each(ARTIFACT_DIRS)("没有被跟踪的 %s 下的文件", (fragment) => {
    const offenders = tracked
      .filter((file) => `/${file}`.includes(fragment))
      .sort();

    expect(
      offenders,
      `这些是产物或依赖，不该进版本控制：${offenders.slice(0, 5).join(", ")}` +
        `${offenders.length > 5 ? ` 等 ${offenders.length} 个` : ""}。` +
        `补 .gitignore 拦不住已经跟踪的文件，要先 git rm --cached。`,
    ).toEqual([]);
  });
});
