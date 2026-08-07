import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES } from "@/i18n";
import type { SupportedLanguage } from "@/i18n";
import { useTheme } from "@/lib/theme";
import type { Theme } from "@/lib/theme";

const THEME_CYCLE: Theme[] = ["system", "light", "dark"];

const THEME_ICON: Record<Theme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

/**
 * 主题 / 语言切换。挂在 AuthLayout 的顶栏里，随文档流走，不再 fixed 悬浮——
 * 顶栏本身就是一段普通内容，不用跟它抢屏幕角落。
 * 移动端也要够得着，所以用 icon 尺寸而不是带文字的按钮。
 *
 * 尺寸写死 34：稿子的 IconButton 是 34×34，而 shadcn 的 icon-sm 是 32。
 * 仍然带上 size="icon-sm"，是为了拿它那份 padding/图标尺寸，只覆写宽高。
 */
export default function AppControls() {
  const { t, i18n } = useTranslation();
  const { theme, setTheme } = useTheme();

  const ThemeIcon = THEME_ICON[theme];
  const nextTheme =
    THEME_CYCLE[(THEME_CYCLE.indexOf(theme) + 1) % THEME_CYCLE.length];

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
    <div className="flex items-center gap-1">
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
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-[34px]"
        onClick={() => setTheme(nextTheme)}
        aria-label={`${t("common.theme.label")}: ${t(`common.theme.${theme}`)}`}
        title={t(`common.theme.${nextTheme}`)}
      >
        <ThemeIcon />
      </Button>
    </div>
  );
}
