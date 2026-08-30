import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import i18next from "eslint-plugin-i18next";
import prettier from "eslint-plugin-prettier/recommended";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

import { restrictedSyntax } from "./eslint-rules/design-tokens.js";
import { nativeControlSyntax } from "./eslint-rules/native-controls.js";
import { secureContextSyntax } from "./eslint-rules/secure-context.js";

export default defineConfig([
  globalIgnores(["dist", "node_modules", "coverage"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  i18next.configs["flat/recommended"],
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // exhaustive-deps 不在 react-hooks v7 的 recommended 里，但它是真正的正确性规则
      // （漏依赖 = 读到过期闭包），所以显式打开。
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // ── 设计 token 守卫 + 原生表单控件守卫 + 安全上下文守卫 ────────
      // 详见 eslint-rules/design-tokens.js（与 docs/design.md#colour-tokens）、
      // eslint-rules/native-controls.js 与 eslint-rules/secure-context.js。
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        ...nativeControlSyntax,
        ...secureContextSyntax,
      ],

      // ── i18n 守卫 ─────────────────────────────────────────────────
      // 界面文案一律走 t()，否则新语言只能翻到一半而且没人发现。
      // 见 docs/design.md#i18n
      "i18next/no-literal-string": [
        "error",
        {
          mode: "jsx-only",
          "jsx-components": {
            exclude: ["Trans", "code", "pre", "script", "style"],
          },
          "jsx-attributes": {
            include: [
              "aria-label",
              "aria-description",
              "aria-valuetext",
              "title",
              "placeholder",
              "alt",
            ],
          },
          words: {
            exclude: [
              // 纯标点 / 数字 / 分隔符不算文案
              "[0-9!-/:-@[-`{-~]+",
              // 全大写的枚举值、协议常量
              "[A-Z_-]+",
              String.raw`^\p{Emoji}+$`,
            ],
          },
        },
      ],
    },
  },
  {
    // 规则数据文件本身要列出被禁的色名，否则规则无处可写。
    //
    // Tailwind v4 之后 token 定义在 src/styles/globals.css 里，eslint 不 lint CSS，
    // 所以原来给 tailwind.config.ts 开的豁免已经没有对象，一并去掉了——
    // 现在没有任何 .ts/.tsx 能写死颜色值。
    // 新增豁免必须在这里写清理由。
    files: ["eslint-rules/**"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // 随机标识的退化实现自己要调得动 crypto.randomUUID —— 安全上下文守卫的唯一豁免。
    files: ["src/lib/randomId.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // 测试与守卫 fixture 需要构造违规样本；对它们开这两条规则会自相矛盾。
    files: [
      "**/__tests__/**/*.{ts,tsx}",
      "**/*.{test,spec}.{ts,tsx}",
      "tests/**",
    ],
    rules: {
      "no-restricted-syntax": "off",
      "i18next/no-literal-string": "off",
    },
  },
  // prettier 必须放在最后：它同时关掉所有与格式化冲突的规则，
  // 再把「格式不符」本身报成 prettier/prettier。放前面会被后续配置覆盖回去。
  // 不写 .prettierrc——用 prettier 默认值，和同级仓库 agentre 保持一致。
  prettier,
]);
