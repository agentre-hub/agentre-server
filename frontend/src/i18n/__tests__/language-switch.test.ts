import { afterAll, describe, expect, it } from "vitest";

import i18n, { SUPPORTED_LANGUAGES } from "../index";

/**
 * 回归测试：切换语言必须真的换掉文案。
 *
 * 起因是一个几乎看不出来的坑——init 里开了 nonExplicitSupportedLngs: true，
 * 它会拿请求语言的基码（zh-CN → zh）去比对 supportedLngs，比不中就静默回落。
 * 表现是 i18n.language === 'zh-CN' 而 i18n.resolvedLanguage === 'en'，
 * <html lang> 和 localStorage 都变了，界面却纹丝不动，且不报任何错。
 *
 * 所以这里断言的是 resolvedLanguage 和 t() 的实际返回值，
 * 只断言 language 会漏掉整个 bug。
 */
afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("language switching", () => {
  it.each(SUPPORTED_LANGUAGES)(
    "resolves %s to itself, not to a fallback",
    async (lang) => {
      await i18n.changeLanguage(lang);
      expect(
        i18n.resolvedLanguage,
        `language=${i18n.language} 但 resolvedLanguage=${i18n.resolvedLanguage}；` +
          "说明 i18next 判定该语言不受支持，静默回落了",
      ).toBe(lang);
    },
  );

  it("actually returns different copy per language", async () => {
    await i18n.changeLanguage("en");
    const en = i18n.t("login.github");
    await i18n.changeLanguage("zh-CN");
    const zh = i18n.t("login.github");

    expect(en).toBe("Sign in with GitHub");
    expect(zh).toBe("使用 GitHub 登录");
    expect(zh).not.toBe(en);
  });

  it("maps Chinese variants onto zh-CN instead of falling back to English", async () => {
    for (const variant of ["zh", "zh-TW", "zh-Hans"]) {
      await i18n.changeLanguage(variant);
      expect(i18n.t("login.github"), `${variant} 落到了英文`).toBe(
        "使用 GitHub 登录",
      );
    }
  });

  it("falls back to English for a genuinely unsupported language", async () => {
    await i18n.changeLanguage("fr");
    expect(i18n.t("login.github")).toBe("Sign in with GitHub");
  });
});
