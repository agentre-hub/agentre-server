import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import PageTitle from "@/components/PageTitle";

const FRONTEND_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** 页面标题的那一档字号，此前在 9 个页面里各写一遍。 */
const TITLE_CLASSES = "text-2xl font-semibold text-foreground";

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe("PageTitle", () => {
  it("渲染成一级标题", () => {
    render(<PageTitle>设备配对</PageTitle>);

    expect(
      screen.getByRole("heading", { level: 1, name: "设备配对" }),
    ).toBeTruthy();
  });

  // 字号是设计系统里的一档，不是每个页面自己的选择。9 个页面各抄一遍那串 class
  // 的后果是：改一档要改 9 处，漏掉的那几页从此和别人不一样，而且没人会发现。
  it("页面标题的字号只在这一处写死", () => {
    const offenders = walk(FRONTEND_SRC)
      .filter((f) => !f.endsWith(path.join("components", "PageTitle.tsx")))
      .filter((f) => !f.includes("__tests__"))
      .filter((f) => fs.readFileSync(f, "utf8").includes(TITLE_CLASSES))
      .map((f) => path.relative(FRONTEND_SRC, f));

    expect(offenders).toEqual([]);
  });
});
