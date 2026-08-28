import {
  AGENTRE_UI_NAMESPACE,
  agentreUiResources,
} from "@agentre-hub/agentre-ui/i18n";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import en from "./locales/en";
import zhCN from "./locales/zh-CN";

/**
 * 支持的语言。新增语言时：
 *   1. 在 locales/ 下加一个目录，模块文件与 en/ 一一对应、键集合完全一致
 *   2. 加进这里的 resources
 * 键集合一致性由 src/i18n/__tests__/locale-parity.test.ts 守卫。
 */
export const SUPPORTED_LANGUAGES = ["en", "zh-CN"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  "zh-CN": "简体中文",
};

/**
 * 共享 UI 包 `@agentre-hub/agentre-ui` 的文案挂在它自己的 namespace 下，
 * 与本站的 `translation` 互不覆盖 —— 包里的组件只经 `useUiTranslation()`
 * （= `useTranslation("agentreUi")`）取文案，取不到就整片显示原始 key。
 *
 * 从**窄入口** `/i18n` 导入而不是包主入口：主入口会把整棵组件树拖进来，
 * 而这里只要语言包。
 */
export const resources = {
  en: {
    translation: en,
    [AGENTRE_UI_NAMESPACE]: agentreUiResources.en,
  },
  "zh-CN": {
    translation: zhCN,
    [AGENTRE_UI_NAMESPACE]: agentreUiResources["zh-CN"],
  },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    // 把中文各变体收敛到 zh-CN，其余落 en。
    //
    // 不要用 nonExplicitSupportedLngs: true 来做这件事——它的方向是反的：
    // 它拿请求语言的 **基码** 去比对 supportedLngs，于是 'zh-CN' 会被降成 'zh'，
    // 而 'zh' 不在 supportedLngs 里，结果 zh-CN 被判为不支持、静默回落到 en。
    // 症状极隐蔽：i18n.language 是 'zh-CN'，但 resolvedLanguage 是 'en'，
    // 界面文案一个字都不变。
    fallbackLng: {
      zh: ["zh-CN"],
      "zh-Hans": ["zh-CN"],
      "zh-SG": ["zh-CN"],
      "zh-TW": ["zh-CN"],
      "zh-HK": ["zh-CN"],
      "zh-MO": ["zh-CN"],
      default: ["en"],
    },
    supportedLngs: SUPPORTED_LANGUAGES,
    load: "currentOnly",
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      lookupLocalStorage: "agentre.lang",
      caches: ["localStorage"],
    },
    interpolation: { escapeValue: false },
    // 资源是打包进来的，没有异步加载，不需要 Suspense；
    // 开着的话首帧会被挂起，反而让 useTranslation 的订阅时机变得不确定。
    react: { useSuspense: false },
  });

// index.html 里写死的是 lang="zh-CN"；这里跟着实际语言走，
// 屏幕阅读器和浏览器翻译都依赖它。
i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
