import { describe, expect, it } from "vitest";

import { edgeClasses } from "./edge-classes";

function el(html: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as Element;
}

describe("edgeClasses", () => {
  it("收集自身与后代上的 border / 单边 / divide / 变体前缀", () => {
    const root = el(
      '<div class="border"><p class="border-t hover:border"></p><ul class="divide-y"><li class="border-x"></li></ul></div>',
    );
    expect(edgeClasses(root).sort()).toEqual(
      ["border", "border-t", "border-x", "divide-y", "hover:border"].sort(),
    );
  });

  it("不把带宽度的色条或边色当结构线", () => {
    const root = el(
      '<div class="border-l-2 border-field-border bg-card"></div>',
    );
    expect(edgeClasses(root)).toEqual([]);
  });
});
