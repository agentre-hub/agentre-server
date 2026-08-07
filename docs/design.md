# Design system

The frontend is React 19 + Vite + Tailwind 4 + shadcn components, embedded into the
Go binary at build time. It ships **light and dark**, **desktop and mobile**, and
**English and Simplified Chinese** — all four are supported, so all four have to work
in anything you add.

## Where the pixels come from

The pixels come from a design canvas (`agentre-server.pen`, kept in the designer's
`设计稿` folder — it is **not** in this repository and is not version-controlled), whose
boards are cited by number: the auth flow and 404 are boards 01–19 and 38–39, each screen
drawn desktop and mobile, light and dark.

This document is the layer between that canvas and the code. It says which utility class
carries which name on the board, and which numbers the shell has already decided so you
never measure them a second time. It does not restate the boards — for a pixel that is not
here, open the board. For a pixel that is here but disagrees with the code, the code is
what ships: fix this file.

## Colour tokens

There is exactly one place colours are defined: `frontend/src/styles/globals.css`.
`:root` holds the light values, `.dark` overrides them, and the `@theme inline` block in
the same file maps each to a semantic utility name.

```
--background / --foreground     page surface + text
--card / --card-foreground      raised surface
--popover / --popover-foreground
--primary / --primary-foreground    brand, also --ring
--primary-soft / --primary-text     brand tint + readable brand text
--secondary / --muted / --accent    + their -foreground pairs
--subtle-foreground             the third text level, below muted
--border / --border-strong / --input
--destructive / --destructive-foreground / --destructive-soft
--status-running / -bg, --status-waiting / -bg, --status-idle, --status-error
--code-surface / --code-foreground / --code-muted-foreground
--overlay-shadow                elevation for dialogs   → shadow-overlay
--overlay-scrim                 the dim behind a dialog → bg-scrim
```

The two `--overlay-*` names are deliberate. Tailwind v4 derives utilities from the
`--shadow-*` and `--color-*` namespaces, so a root token literally named
`--shadow-overlay` would make the mapping `--shadow-overlay: var(--shadow-overlay)`,
which references itself.

**Write `bg-background`, `text-muted-foreground`, `border-border`, `bg-scrim`.
Never write `bg-slate-900`, `text-white`, `#0f172a` or `rgba(...)` in a `.ts`/`.tsx` file.**

This is enforced — `no-restricted-syntax` in `frontend/eslint.config.js`, with the patterns
in `frontend/eslint-rules/design-tokens.js` and a guard test in
`frontend/src/__tests__/eslint-guardrails.test.ts`. The rule catches variants and opacity
modifiers too (`dark:bg-black/70`, `text-red-500/50`).

The reason is not tidiness. A literal colour does not change between themes, so it looks
correct in whichever mode you built it in and wrong in the other — and nobody notices until
a user in the other mode complains.

Need a colour that has no token? **Add the token** — to both `:root` and `.dark` — add its
`--color-*` alias to `@theme inline`, then use it. Miss the alias and nothing errors: the
utility simply generates no rule, so the element renders with no colour at all.
`frontend/src/__tests__/design-token-contract.test.ts` guards both halves.

Only `eslint-rules/` is exempt from the literal-colour rule, because it is where the banned
colour names are listed. No `.ts`/`.tsx` file may hard-code a colour.

### The canvas's names are not the code's names

The boards say `brand`, `surface`, `text`, `ok`, `warn`, `idle`. The code keeps shadcn's
names for the surfaces and the desktop app's `status-*` names for the states, so that a
palette fix lands once and both products get it. Holding a board, read across:

| On the board | Token in `globals.css` | What you type |
| --- | --- | --- |
| `bg` | `--background` | `bg-background` |
| `surface` | `--card` | `bg-card`, `text-card-foreground` |
| `surface-raised` | `--popover` | `bg-popover`, `text-popover-foreground` |
| `chrome`, `code-bg` | `--code-surface` | `bg-code-surface` |
| `text` | `--foreground` | `text-foreground` |
| `text-muted` | `--muted-foreground` | `text-muted-foreground` |
| `text-subtle` | `--subtle-foreground` | `text-subtle-foreground` |
| `brand` | `--primary` | `bg-primary`, `border-primary`, `ring-primary` |
| `brand-fg` | `--primary-foreground` | `text-primary-foreground` |
| `brand-soft` | `--primary-soft` | `bg-primary-soft` |
| `brand-text` | `--primary-text` | `text-primary-text` |
| `ok` | `--status-running` | `text-status-running` |
| `ok-soft` | `--status-running-bg` | `bg-status-running-bg` |
| `warn` | `--status-waiting` | `text-status-waiting` |
| `warn-soft` | `--status-waiting-bg` | `bg-status-waiting-bg` |
| `idle` | `--status-idle` | `text-status-idle` |
| `danger` | `--destructive` | `text-destructive`, `bg-destructive`, `border-destructive` |
| `danger-soft` | `--destructive-soft` | `bg-destructive-soft` |
| `danger-fg` | `--destructive-foreground` | `text-destructive-foreground` |
| `scrim` | `--overlay-scrim` | `bg-scrim` |

Two groups do not line up, and both are intentional:

- The canvas also carries `warn-fg` and `proj-1`…`proj-5`. Nothing in this repo uses them —
  they belong to console surfaces outside this flow — so they are absent from `globals.css`.
  Adding a token nobody uses just creates a pair of values that silently drift apart between
  `:root` and `.dark`.
- The code carries tokens the boards never name: `--secondary`, `--muted`, `--accent`,
  `--border-strong`, `--input`, `--ring`, `--status-error`, `--code-foreground`,
  `--code-muted-foreground`. They are what shadcn's component styles and the desktop
  palette need. Leave them alone unless a component asks for them.

`design-token-contract.test.ts` holds the authoritative list of names *and* both values of
each. Change a colour there first — that is the test that goes red.

## Type scale

Tailwind's default `--text-*` steps are untouched, so `text-xs` is 12px, `text-sm` 14px,
`text-2xl` 24px. Two of the canvas's steps — 13 and 15 — are not Tailwind steps, and are
written as arbitrary values rather than rounded to the nearest one.

| Role on the board | Class | Size / weight | Where it lands |
| --- | --- | --- | --- |
| H1 | `text-2xl font-semibold` | 24 / 600 | every screen's `<h1>` |
| H2 | `text-[15px] font-semibold` | 15 / 600 | product name in `AuthLayout`, device name in `DeviceApproval` |
| Eyebrow | `text-xs font-semibold` + `text-primary-text` | 12 / 600 | the "device authorization" line above the title |
| Body | `text-sm` | 14 / 400 | the paragraph under a title |
| Body strong | `text-sm font-semibold` | 14 / 600 | capability names, device name on the result screens |
| Small | `text-[13px]` | 13 / 400–500 | capability descriptions, inline code error, countdown |
| Caption | `text-xs` | 12 / 400 | footer, hints, fine print, `platform · version` |
| Mono, inline | `font-mono` + `text-xs` / `text-[13px]` / `text-sm` | 12–14 / 400–600 | identifiers, see [Mono](#the-mono-font) |
| Mono, code box | `font-mono text-[22px] font-semibold sm:text-[26px]` | 22→26 / 600 | `CodeInput` |
| Mono, confirmation code | `font-mono text-[28px] font-semibold tracking-[7px] sm:text-[34px]` | 28→34 / 600 | `DeviceApproval` |

Three things the table does not show:

- **Weights are 400, `font-medium` (500) and `font-semibold` (600), nothing else.** The
  canvas's headings are all 600.
- **Line height needs saying out loud.** Tailwind pairs `text-sm` with a 20px line height
  (≈1.43); the canvas asks for 1.5–1.6 on multi-line body copy. Where it matters the class
  is explicit — `leading-[1.5]` on the capability descriptions in `DeviceApproval.tsx`.
- **The 404 numeral is not a type step.** It is `text-7xl font-semibold text-border-strong`
  and `aria-hidden`, i.e. a graphic that happens to be made of digits.

## Spacing

Tailwind's spacing scale is 4px per step, and the boards were drawn on the same grid, so
most measurements land on a step:

| px | Class | Typical use |
| --- | --- | --- |
| 8 | `gap-2` | icon ↔ its label |
| 10 | `gap-2.5` | rows inside a title block |
| 12 | `gap-3` | capability icon ↔ text, stacked buttons |
| 14 | `gap-3.5`, `p-3.5` | inline panel padding |
| 16 | `p-4` | the device panel, the code-surface block |
| 20 | `py-5` | top bar and footer, vertical |
| 24 | `p-6`, `gap-6`, `px-6` | card padding on mobile, block gaps inside a card, the shell's horizontal padding |
| 32 | `px-8` | top bar and footer, horizontal |
| 36 | `p-9` | the login card |
| 40 | `sm:p-10` | card padding from `sm:` up |

A handful of values are off the grid and written as arbitrary utilities — `gap-[26px]`,
`gap-[18px]`, `gap-[9px]`, `gap-[7px]`, `py-[13px]`, `py-[11px]`, `px-[18px]`. Those are
measured off the boards. If one looks wrong, check the board rather than rounding it to
the nearest step.

## Radius

| Class | Value | Applies to |
| --- | --- | --- |
| `rounded-sm` | 6px | brand mark, capability and device icon plates |
| `rounded-md` | 10px | buttons, inputs, code boxes, inline panels |
| `rounded-lg` | 14px | the cards |

The three are declared as literal pixel values in `@theme inline`, not derived from one
`--radius` base. 6/10/14 is not an arithmetic progression, so no `calc(var(--radius) ± n)`
chain produces it; the base token was removed rather than left around unused.
`design-token-contract.test.ts` asserts the three resolved values, not merely that they
are non-empty.

Only these three steps are redeclared. `rounded-full` and `rounded-xl` still resolve to
Tailwind's built-ins — which is why `@/components/ui/card.tsx` (`rounded-xl` plus
`shadow-sm`) is *not* the auth card. See [Components](#components).

## The auth shell

`@/components/AuthLayout` is the frame for every page this app renders — the auth flow, the
device list, the `/terms` `/privacy` `/status` placeholders (`@/pages/ComingSoon`) and 404.
Eight page components import it and nothing else lays itself out. It is a vertical
three-part layout — top bar, main, footer — on `flex min-h-screen flex-col bg-background`.

**Top bar.** Brand mark (a 28px `rounded-sm bg-primary` square holding a terminal glyph)
plus the product name at `text-[15px] font-semibold`, a flexible spacer, then `AppControls`
— the language and theme toggles as `Button size="icon-sm"`. It sits **in the document
flow**. `AppControls` used to be a `fixed right-3 top-3 z-50` overlay mounted outside the
router, floating over whatever each page happened to draw in that corner;
`frontend/src/__tests__/auth-layout.test.tsx` asserts the header is not `fixed`, so it
cannot drift back.

**Main.** `flex flex-1 items-center justify-center px-6` — centred both ways, and it owns
the horizontal safe margin each page used to supply for itself. The wrapper is
`min-h-screen`, not `h-screen`: content taller than the viewport makes the whole page
scroll instead of being clipped at the bottom.

**Footer.** One centred, wrapping row at `text-xs text-subtle-foreground`: copyright plus
links to `/terms`, `/privacy` and `/status`. Those three are public routes in `App.tsx`,
deliberately outside `RequireAuth` — the footer is also on the login screen, and a footer
link that bounces you to login is worse than no link.

**Cards.** A card is a plain element with `rounded-lg border border-border bg-card`; the
width is per screen, and comes from the board:

| Screen | File | Width class | Rendered |
| --- | --- | --- | --- |
| Login | `pages/Login.tsx` | `w-full max-w-sm` | 384px |
| Device code entry | `pages/Device.tsx` | `w-full max-w-[496px]` | 496px |
| Authorization confirm | `components/DeviceApproval.tsx` | `w-full max-w-[576px]` | 576px |
| Success / denied / expired | `pages/Device{Success,Denied,Expired}.tsx` | `w-full max-w-[28rem]` | 448px |
| Device list | `pages/Devices.tsx` | `w-full max-w-2xl` | 672px |
| 404, coming soon | `pages/NotFound.tsx`, `pages/ComingSoon.tsx` | — | no card |

`border` on its own is enough — `globals.css` sets `border-color: var(--border)` on `*` in
its base layer, because Tailwind v4's default border colour is `currentColor` and would
otherwise draw the border in the text colour.

### How it degrades on mobile

Everything is written mobile-first; `sm:` (640px) is the only breakpoint the auth screens
use, and it adds to the mobile shape rather than replacing it.

- Cards are `w-full max-w-*`, so below their maximum they fill whatever main leaves after
  `px-6`. Nothing else needs to change for them to fit.
- Card padding is `p-6 sm:p-10` — 24 on a phone, 40 on a desktop. (`Login.tsx` is the one
  exception: `p-9` at every width.)
- The six code boxes flex: `min-w-0 max-w-[54px] flex-1`, `h-14` → `sm:h-[66px]`,
  `text-[22px]` → `sm:text-[26px]`. `min-w-0` is load-bearing — without it a flex item
  refuses to shrink below its content and the row pushes a horizontal scrollbar.
- The confirmation code is `text-[28px]`, `sm:text-[34px]`.
- The approval actions stack: `flex flex-col gap-3 sm:flex-row-reverse`.
- The footer row wraps.

## Theming

Three pieces, and they only work as a set:

1. `globals.css` defines `.dark { ... }`.
2. `globals.css` declares **`@custom-variant dark (&:is(.dark *))`**.
3. `frontend/src/lib/theme.tsx` toggles the `dark` class on `<html>`.

Miss the second and Tailwind's `dark:` variant falls back to the `prefers-color-scheme`
media query and stops following the class, so the whole `.dark` block becomes dead code —
silently, since light mode still looks fine.

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

- **The shell already gives you full height and horizontal padding.** Do not add a second
  `min-h-screen` inside it: main is already at least a viewport tall minus the bars, so a
  `min-h-screen` child pushes the footer off-screen and every page gains a scrollbar worth
  exactly the header plus footer. The only `min-h-screen` outside `AuthLayout` is
  `RequireAuth`'s loading state, which renders *instead of* the page and so has no shell
  around it.
- Dialogs need `w-[calc(100%-2rem)]` alongside `max-w-*`, or they touch both edges — see
  `components/ui/dialog.tsx`.
- A row of actions stacks on mobile: `flex flex-col gap-3 sm:flex-row-reverse`
  (`DeviceApproval.tsx`). The DOM order puts the primary action first, so keyboard and
  screen-reader users reach it first; `row-reverse` puts it back on the right on desktop.
- Controls must stay reachable — see `AppControls`, which uses icon-sized buttons rather
  than labelled ones so it fits a narrow viewport.

The e2e suite runs **every spec against `desktop-chromium` and `mobile-chromium`**, and
one spec asserts the login screen has no horizontal overflow — under the mobile project,
that is the assertion that catches a card sitting edge-to-edge. A desktop-only pass tells
you nothing about mobile.

## The mono font

`font-mono` resolves to JetBrains Mono, self-hosted from
`frontend/src/assets/fonts/jetbrains-mono/` (`@font-face` in `globals.css`, `--font-mono`
in `@theme inline`). Body copy stays on the system sans stack set on `body`; nothing else
is self-hosted, because this bundle is `//go:embed`-ed into the Go binary and every KB
ships in the image.

Mono is for strings the user has to compare character by character, or that a machine
emitted. In this flow that is exactly:

| What | Where |
| --- | --- |
| `user_code` in the six boxes | `components/CodeInput.tsx` |
| the large confirmation code | `components/DeviceApproval.tsx` |
| the `user_code` echoed back on the login screen | `pages/Login.tsx` |
| `platform · version` | `components/DeviceApproval.tsx`, `pages/DeviceSuccess.tsx` |
| a capability key with no entry in the copy | `components/DeviceApproval.tsx` |

Everything else — titles, body, buttons, footer — is the UI font. Two reasons for the
boundary, and both are about the font file rather than taste:

1. **Only the Latin subset is hosted, at weights 400 and 600.** Put mono on a string that
   can contain Chinese and the CJK glyphs fall through to the next family in the stack,
   producing one line in two typefaces at two metrics. Nothing in the table above can:
   every item is a code or a machine-reported identifier. Translated copy never gets
   `font-mono`.
2. **`font-medium` has no face.** With only 400 and 600 available, a 500 on mono text is
   matched to whichever neighbour the browser picks. Use 400 or `font-semibold`.

## i18n

All UI copy goes through `t()`. Locale files are `frontend/src/i18n/locales/{en,zh-CN}.json`,
**`en` is the reference** for the key set.

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();
return <h1>{t('device.entry.title')}</h1>;
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

<div className={cn('rounded-md border border-border p-4', className)} />
```

Prefer a variant on the existing component over a one-off wrapper. `Button` already has
`variant` (default / destructive / outline / secondary / ghost / link) and `size`
(default / xs / sm / lg, plus `icon`, `icon-xs`, `icon-sm`, `icon-lg`).

Two shapes that look interchangeable and are not:

- **`Card` is not the auth card.** `@/components/ui/card.tsx` is `rounded-xl` with
  `shadow-sm` — Tailwind's 12px, not the boards' 14px, and it carries elevation the auth
  screens do not have. It is what the device list uses. An auth card is written out:
  `rounded-lg border border-border bg-card`.
- **`Dialog` is not a screen.** The approval step is a region of `/device`, not a dialog,
  because `role="dialog"` tells a screen reader the rest of the page is inert when it is
  the whole page. Reach for `Dialog` for a confirm-and-dismiss interaction, as the device
  list does.

## Adding a page

1. Component under `frontend/src/pages/`, route in `App.tsx`. Wrap in `<RequireAuth>` if
   it needs a session.
2. Copy into **both** locale files; use `t()` from the first line — retrofitting i18n is
   much worse than starting with it.
3. Semantic token classes only.
4. Wrap the page in `<AuthLayout>` and render **one** child into it: a card if the page
   asks for something, a bare centred block if it only tells you something (`NotFound`,
   `ComingSoon`). Do not write your own full-height wrapper — see
   [Responsive](#responsive) for what that costs.

   ```tsx
   import { useTranslation } from 'react-i18next';

   import AuthLayout from '@/components/AuthLayout';

   export default function Thing() {
     const { t } = useTranslation();
     return (
       <AuthLayout>
         <div className="w-full max-w-[496px] rounded-lg border border-border bg-card p-6 sm:p-10">
           <h1 className="text-2xl font-semibold text-foreground">
             {t('thing.title')}
           </h1>
         </div>
       </AuthLayout>
     );
   }
   ```

5. Sizes, spacing and radii from the three scale tables above; the width from the board.
6. Check light **and** dark, desktop **and** mobile.
7. `cd frontend && pnpm lint && pnpm test`, then `cd e2e && pnpm smoke`. Neither `pnpm lint`
   nor `pnpm test` type-checks — only `pnpm build` (`tsc -b && vite build`) does, so run
   `pnpm exec tsc -b` before you call it done.
