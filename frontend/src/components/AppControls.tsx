import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, cn, ThemeToggle } from "@agentre-hub/agentre-ui";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "@/i18n";
import type { SupportedLanguage } from "@/i18n";

/**
 * 主题 / 语言切换。挂在 AuthLayout 与控制台外壳的顶栏里，随文档流走，不再 fixed
 * 悬浮——顶栏本身就是一段普通内容，不用跟它抢屏幕角落。没有顶栏的控制台页由外壳
 * 摆到侧栏底部（外框上），收起成 56px 时用竖排。
 * 移动端也要够得着，所以用 icon 尺寸而不是带文字的按钮。
 *
 * 尺寸写死 34：稿子的 IconButton 是 34×34，而 shadcn 的 icon-sm 是 32。
 * 仍然带上 size="icon-sm"，是为了拿它那份 padding/图标尺寸，只覆写宽高。
 */
export default function AppControls({
  orientation = "horizontal",
}: {
  /**
   * 竖排给 56px 的收起侧栏用：两颗 34px 并排要 72px，放不下。
   */
  orientation?: "horizontal" | "vertical";
} = {}) {
  const { t, i18n } = useTranslation();

  const currentLang = (SUPPORTED_LANGUAGES as readonly string[]).includes(
    i18n.resolvedLanguage ?? "",
  )
    ? (i18n.resolvedLanguage as SupportedLanguage)
    : "en";
  const nextLang =
    SUPPORTED_LANGUAGES[
      (SUPPORTED_LANGUAGES.indexOf(currentLang) + 1) %
        SUPPORTED_LANGUAGES.length
    ];

  return (
    <div
      className={cn(
        "flex items-center gap-1",
        orientation === "vertical" && "flex-col",
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-[34px]"
        onClick={() => void i18n.changeLanguage(nextLang)}
        aria-label={`${t("common.language.label")}: ${LANGUAGE_LABELS[currentLang]}`}
        title={LANGUAGE_LABELS[nextLang]}
      >
        <Languages />
      </Button>
      {/* 主题按钮整件（图标、三态顺序、无障碍文案）来自共享包；这里只把外壳
          尺寸传进去 —— 稿子的 IconButton 是 34×34，包里那份默认 36。 */}
      <ThemeToggle className="size-[34px]" />
    </div>
  );
}
