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
});
