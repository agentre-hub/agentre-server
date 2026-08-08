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
 * 固定在右上角的主题 / 语言切换。所有页面共用一份，放在 App 的 Layout 里。
 * 移动端也要够得着，所以用 icon 尺寸而不是带文字的按钮。
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
    <div className="fixed right-3 top-3 z-50 flex items-center gap-1 sm:right-4 sm:top-4">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void i18n.changeLanguage(nextLang)}
        aria-label={`${t("common.language.label")}: ${LANGUAGE_LABELS[currentLang]}`}
        title={LANGUAGE_LABELS[nextLang]}
      >
        <Languages />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => setTheme(nextTheme)}
        aria-label={`${t("common.theme.label")}: ${t(`common.theme.${theme}`)}`}
        title={t(`common.theme.${nextTheme}`)}
      >
        <ThemeIcon />
      </Button>
    </div>
  );
}
