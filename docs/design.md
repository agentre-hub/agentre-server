# Design system

The frontend is React 19 + Vite + Tailwind 3 + shadcn components, embedded into the
Go binary at build time. It ships **light and dark**, **desktop and mobile**, and
**English and Simplified Chinese** — all four are supported, so all four have to work
in anything you add.

## Colour tokens

There is exactly one place colours are defined: `frontend/src/styles/globals.css`.
`:root` holds the light values, `.dark` overrides them, and `tailwind.config.ts` maps
each to a semantic utility name.

```
--background / --foreground     page surface + text
--card / --card-foreground      raised surface
--popover / --popover-foreground
--primary / --primary-foreground    brand, also --ring
--secondary / --muted / --accent    + their -foreground pairs
--border / --input
--destructive / --destructive-foreground
--shadow-overlay                elevation for dialogs
--overlay-scrim                 the dim behind a dialog  → bg-scrim
```

**Write `bg-background`, `text-muted-foreground`, `border-border`, `bg-scrim`.
Never write `bg-slate-900`, `text-white`, `#0f172a` or `rgba(...)` in a `.ts`/`.tsx` file.**

This is enforced — `no-restricted-syntax` in `frontend/eslint.config.js`, with the patterns
in `frontend/eslint-rules/design-tokens.js` and a guard test in
`frontend/src/__tests__/eslint-guardrails.test.ts`. The rule catches variants and opacity
modifiers too (`dark:bg-black/70`, `text-red-500/50`).

The reason is not tidiness. A literal colour does not change between themes, so it looks
correct in whichever mode you built it in and wrong in the other — and nobody notices until
a user in the other mode complains.

Need a colour that has no token? **Add the token** — to both `:root` and `.dark` — map it in
`tailwind.config.ts`, then use it. Only `tailwind.config.ts` and `eslint-rules/` are exempt,
because they are where tokens are defined.

## Theming

Three pieces, and they only work as a set:

1. `globals.css` defines `.dark { ... }`.
2. `tailwind.config.ts` sets **`darkMode: 'class'`**.
3. `frontend/src/lib/theme.tsx` toggles the `dark` class on `<html>`.

Miss the second and Tailwind defaults to `'media'`, so nothing ever adds the class and the
whole `.dark` block becomes dead code — silently, since light mode still looks fine.

`ThemeProvider` wraps the app in `main.tsx`. `useTheme()` gives `{ theme, resolved, setTheme }`,
where `theme` is the user's choice (`'light' | 'dark' | 'system'`) and `resolved` is what is
actually showing. The choice persists to `localStorage` under `agentre.theme`, and `'system'`
follows `prefers-color-scheme` live.

```tsx
import { useTheme } from '@/lib/theme';

const { theme, resolved, setTheme } = useTheme();
```

Verify both modes. `e2e/smoke.spec.ts` asserts the class lands on `<html>` and survives a
reload; it cannot tell you the result looks right.

## Responsive

Both form factors are supported, so build mobile-first and add `sm:`/`md:` upward.

- Give full-height centred layouts horizontal padding: `px-4`. Without it a card sits
  edge-to-edge on a phone.
- Dialogs need `w-[calc(100%-2rem)]` alongside `max-w-*`, or they touch both edges.
- Primary actions go full-width on mobile, auto on desktop: `className="w-full sm:w-auto"`.
- Controls must stay reachable — see `AppControls`, which uses icon-sized buttons rather
  than labelled ones so it fits a narrow viewport.

The e2e suite runs **every spec against `desktop-chromium` and `mobile-chromium`**, and
asserts no horizontal overflow. A desktop-only pass tells you nothing about mobile.

## i18n

All UI copy goes through `t()`. Locale files are `frontend/src/i18n/locales/{en,zh-CN}.json`,
**`en` is the reference** for the key set.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();
return <h1>{t('device.title')}</h1>;
```

Enforced by `i18next/no-literal-string` (`mode: 'jsx-only'`), which also covers
`aria-label`, `title`, `placeholder` and `alt` — those are user-visible too, and they are
the ones that get forgotten.

Adding copy: add the key to **both** locale files.
`locale-parity.test.ts` fails on a key present in one and missing from the other,
because i18next's response to a missing key is to silently serve the English one.

### Two things that will bite you

**`i18n.language` is not `i18n.resolvedLanguage`.** i18next will happily set `language` to
`'zh-CN'` while resolving to `'en'` and serving English. Nothing errors. Assert on
`resolvedLanguage` and on what `t()` actually returns — that is what
`language-switch.test.ts` does.

**Do not use `nonExplicitSupportedLngs: true` to map variants.** It works the opposite way
round from what the name suggests: it reduces the *requested* language to its base code
(`zh-CN` → `zh`) before checking `supportedLngs`. With `supportedLngs: ['en', 'zh-CN']`,
`zh` is not in the list, so `zh-CN` is judged unsupported and falls back to English —
silently. Map variants with an explicit `fallbackLng` object instead — see
`frontend/src/i18n/index.ts`.

`<html lang>` is driven from the `languageChanged` event; `index.html` only carries the
fallback value.

## Components

Use `@/components/ui/*` (shadcn). Compose class names with `cn()` from `@/lib/utils` —
it merges Tailwind classes correctly, which naive string concatenation does not.

```tsx
import { cn } from '@/lib/utils';

<div className={cn('rounded-xl border p-6', className)} />
```

Prefer a variant on the existing component over a one-off wrapper. `Button` already has
`variant` (default / destructive / outline / secondary / ghost / link) and `size`
(including `icon`, `icon-sm`, `icon-xs`, `icon-lg`).

## Adding a page

1. Component under `frontend/src/pages/`, route in `App.tsx`. Wrap in `<RequireAuth>` if
   it needs a session.
2. Copy into **both** locale files; use `t()` from the first line — retrofitting i18n is
   much worse than starting with it.
3. Semantic token classes only.
4. Outer wrapper: `flex min-h-screen items-center justify-center bg-background px-4 py-12`
   (the existing pages' shape).
5. Check light **and** dark, desktop **and** mobile.
6. `cd frontend && pnpm lint && pnpm test`, then `cd e2e && pnpm smoke`.
