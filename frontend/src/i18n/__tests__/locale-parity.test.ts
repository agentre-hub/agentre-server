import { describe, expect, it } from "vitest";

import en from "../locales/en.json";
import zhCN from "../locales/zh-CN.json";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, resources } from "../index";

type Json = { [k: string]: string | Json };

/** 把嵌套对象拍平成 'a.b.c' 形式的键集合。 */
function flatten(obj: Json, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return typeof v === "string" ? [key] : flatten(v, key);
  });
}

/** 收集所有叶子字符串值（用于检查文案内容）。 */
function leafValues(obj: Json): string[] {
  return Object.entries(obj).flatMap(([, v]) =>
    typeof v === "string" ? [v] : leafValues(v as Json),
  );
}

/**
 * 设计旁白（spec「视觉真源与旁白判定」明确排除的文案）。locale 值里出现任何
 * 一条都说明有人把评审说明/能力解释当成了产品文案。注意「撤销这台设备」不在
 * 清单里——它作为 revokeCard* 键已经存在于上轮实现，由 task 4 随危险卡一起删除。
 */
const NARRATION_PHRASES = [
  "这里记什么",
  "现状 vs 优化",
  "只读改动说明",
  "执行目标按顺序",
  "改动在设备上",
  "N1",
  "N2",
];

const REFERENCE = "en";

describe("locale parity", () => {
  const reference = flatten(en as Json).sort();

  // en 是基准语言：漏 key 时 i18next 会 fallback 回英文，界面上是「某几段忽然变英文」，
  // 不报错、不崩，靠人眼发现——所以必须机械拦住。
  it.each(Object.entries({ "zh-CN": zhCN }))(
    "%s has exactly the same keys as en",
    (_lang, locale) => {
      const actual = flatten(locale as Json).sort();

      const missing = reference.filter((k) => !actual.includes(k));
      const extra = actual.filter((k) => !reference.includes(k));

      expect(
        missing,
        `缺少 key（会静默 fallback 回 ${REFERENCE}）：${missing.join(", ")}`,
      ).toEqual([]);
      expect(
        extra,
        `多出 key（${REFERENCE}.json 里没有，属于死翻译）：${extra.join(", ")}`,
      ).toEqual([]);
    },
  );

  it("every supported language is wired into resources and has a label", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(resources, `resources 缺 ${lang}`).toHaveProperty(lang);
      expect(LANGUAGE_LABELS[lang], `LANGUAGE_LABELS 缺 ${lang}`).toBeTruthy();
    }
    expect(Object.keys(resources).sort()).toEqual(
      [...SUPPORTED_LANGUAGES].sort(),
    );
  });

  it("no translation value is left empty", () => {
    for (const [lang, bundle] of Object.entries({ en, "zh-CN": zhCN })) {
      const empties = flatten(bundle as Json).filter((key) => {
        const value = key
          .split(".")
          .reduce<unknown>((acc, part) => (acc as Json)?.[part], bundle);
        return typeof value === "string" && value.trim() === "";
      });
      expect(empties, `${lang} 有空翻译：${empties.join(", ")}`).toEqual([]);
    }
  });

  it("locale 值不含设计旁白文案", () => {
    // 旁白不是产品文案：不许为它建键，也不许混进任何翻译值。
    for (const [lang, bundle] of Object.entries({ en, "zh-CN": zhCN })) {
      const hits = leafValues(bundle as Json).filter((v) =>
        NARRATION_PHRASES.some((p) => v.includes(p)),
      );
      expect(hits, `${lang} 混入旁白：${hits.join(", ")}`).toEqual([]);
    }
  });
});
