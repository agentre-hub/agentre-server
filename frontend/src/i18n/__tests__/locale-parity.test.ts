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
 * 一条都说明有人把评审说明/能力解释当成了产品文案。常驻「撤销这台设备」说明卡
 * 是旁白，它的 revokeCard* 键由专项断言检查（不能放进 NARRATION_PHRASES：
 * 授权确认页的 fineprint 里也含该词组，但那句是真实产品文案）。
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

  it("audit 区段键在两种语言中齐全且文案符合设计稿", () => {
    // task 7 审计页用到的 14 个产品键：缺一个就会在界面上静默 fallback 回英文。
    const expected: Record<string, [string, string]> = {
      "audit.filters.all": ["All", "全部"],
      "audit.filters.deviceAuth": ["Device authorization", "授权接入"],
      "audit.filters.token": ["Tokens", "令牌"],
      "audit.filters.revoke": ["Revocation", "撤销"],
      "audit.table.time": ["Time", "时间"],
      "audit.table.event": ["Event", "事件"],
      "audit.table.object": ["Object", "对象"],
      "audit.table.source": ["Source", "来源"],
      "audit.table.result": ["Result", "结果"],
      "audit.events.emptyTitle": ["No audit events yet", "暂无审计事件"],
      "audit.events.emptyBody": [
        "Audit records are not available yet.",
        "审计记录暂未开放。",
      ],
      "audit.credentials.title": ["Active credentials", "活跃凭证"],
      "audit.credentials.emptyTitle": ["No active credentials", "暂无活跃凭证"],
      "audit.credentials.emptyBody": [
        "Nothing here yet — credentials appear once devices sign in.",
        "暂无可显示内容——设备登录后凭证会出现在这里。",
      ],
    };

    const resolve = (bundle: Json, key: string): string =>
      key
        .split(".")
        .reduce<unknown>(
          (acc, part) => (acc as Json)?.[part],
          bundle,
        ) as string;

    for (const [key, [enValue, zhValue]] of Object.entries(expected)) {
      expect(resolve(en as Json, key), `en 缺 ${key}`).toBe(enValue);
      expect(resolve(zhCN as Json, key), `zh-CN 缺 ${key}`).toBe(zhValue);
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

  it("设备页常驻「撤销这台设备」旁白卡已删：不为其创建 locale 键", () => {
    // spec 明确排除设备页常驻撤销说明卡，且旁白不为其创建 locale 键。
    // 专项断言键本身（而不查词组），避免误伤授权确认页 fineprint 里合法的同一词组。
    for (const [lang, bundle] of Object.entries({ en, "zh-CN": zhCN })) {
      const dead = flatten(bundle as Json).filter((k) =>
        k.startsWith("device.manage.revokeCard"),
      );
      expect(dead, `${lang} 仍有旁白卡键：${dead.join(", ")}`).toEqual([]);
    }
  });
});
