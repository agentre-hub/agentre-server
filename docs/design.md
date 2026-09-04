# Design system

The frontend is React 19 + Vite + Tailwind 4 + shadcn components, embedded into the
Go binary at build time. It ships **light and dark**, **desktop and mobile**, and
**English and Simplified Chinese** — all four are supported, so all four have to work
in anything you add.

## Source of truth

This document records the design contract that is present in the tracked frontend:
tokens, reusable components, layout rules and their guard tests. The current code is what
ships; when it and this document disagree, verify the rendered result and update the owning
implementation and this contract together. Do not cite an untracked canvas or a deleted
spec as branch-verifiable evidence.

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
--status-running / -bg, --status-waiting / -bg / -foreground, --status-idle, --status-error
--code-surface / --code-foreground / --code-muted-foreground
--sidebar                       the console SideNav surface (chrome on the board)
--heat-0 … --heat-4             the overview heatmap's five-level scale
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
| `chrome` (side-nav) | `--sidebar` | `bg-sidebar` |
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
| `warn-fg` | `--status-waiting-foreground` | `text-status-waiting-foreground` |
| `idle` | `--status-idle` | `text-status-idle` |
| `danger` | `--destructive` | `text-destructive`, `bg-destructive`, `border-destructive` |
| `danger-soft` | `--destructive-soft` | `bg-destructive-soft` |
| `danger-fg` | `--destructive-foreground` | `text-destructive-foreground` |
| `scrim` | `--overlay-scrim` | `bg-scrim` |
| `heat-0`…`heat-4` | `--heat-0`…`--heat-4` | `bg-heat-0` … `bg-heat-4` |

Two groups do not line up, and both are intentional:

- The board draws the SideNav in the same `chrome` family the code splits in two:
  `--code-surface` keeps the command/hook output surfaces, and `--sidebar` (added with the
  console) is the console's nav surface — light #f4f4f5 (the light of `--secondary`) and
  dark #111316 (the dark of `--code-surface`). A dedicated token lets the two diverge
  without touching either. `warn-fg` gained one too: `--status-waiting-foreground`, the
  dark-brown text on the amber badge, shared by the SideNav chat badge and the unread chip.
- `--heat-0`…`--heat-4` are the one colour family this site declares itself, in its own
  `:root` / `.dark` plus five `--color-heat-*` aliases in `@theme inline`. They belong here
  rather than in the shared package because only the server console draws an activity
  heatmap; adding a pair of light/dark values the desktop never renders just creates two
  numbers that drift apart. `heat-0` is a visible grey, not transparent — it means
  "nothing started that day", which is a fact, not a gap.
- The canvas also carries `proj-1`…`proj-5`. Nothing in this repo uses them — they belong
  to console surfaces outside this flow — so they are absent from `globals.css`. Adding a
  token nobody uses just creates a pair of values that silently drift apart between `:root`
  and `.dark`.
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
| Name | `text-[15px] font-semibold` | 15 / 600 | product name in `AuthLayout`, device name in `DeviceApproval` |
| Eyebrow | `text-xs font-semibold` + `text-primary-text` | 12 / 600 | the "device authorization" line above the title |
| Body | `text-sm` | 14 / 400 | the paragraph under a title |
| Body strong | `text-sm font-semibold` | 14 / 600 | device name on the result screens |
| Small | `text-[13px]` | 13 / 400–500 | code-confirmation prompt, inline code error, countdown |
| Caption | `text-xs` | 12 / 400 | footer, hints, fine print, `platform · version` |
| Mono, inline | `font-mono` + `text-xs` / `text-[13px]` / `text-sm` | 12–14 / 400–600 | identifiers, see [Mono](#the-mono-font) |
| Mono, code box | `font-mono text-[22px] font-semibold sm:text-[26px]` | 22→26 / 600 | `CodeInput` |
| Mono, confirmation code | `font-mono text-[28px] font-semibold tracking-[7px] sm:text-[34px]` | 28→34 / 600 | `DeviceApproval` |
| Console wordmark | `text-[15px] font-semibold` | 15 / 600 | product name in `AppShell`'s Brand |
| Console title | `text-[15px] font-bold` | 15 / 700 | `AppShell` TopBar title slot |
| Console h1 / section title | `text-sm font-bold` | 14 / 700 | Overview stats-card titles |
| Console card title | `text-[13px] font-bold` | 13 / 700 | Account section card title |
| Console group heading | `text-sm font-semibold` | 14 / 600 | `ChatList` / `SessionList` group headers |
| Metric value | `text-[23px] leading-none font-bold` | 23 / 700 | the shared `Metric` tiles (Overview) |
| Metric label / sub | `text-[11.5px]` / `text-[10.5px]` | 11.5 / 10.5 | the shared `Metric` label and optional sub |
| Empty-state title | `text-lg font-bold` | 18 / 700 | the shared `EmptyState` title |
| Console small | `text-xs` | 12 / 400–500 | rows, chips, TopBar counts, `Fresh` |
| Console caption / mono meta | `text-[10px]` / `text-[11px]` | 10–11 / 400–600 | brand sub, account meta, badges, `online/total` Meta |

The canvas's scale also names `Display / 32 · 600` and `H2 / 18 · 600`. Neither has a use in
this flow, so no class carries one; add `text-[32px]` / `text-lg` at 600 when a screen
finally needs them, rather than stretching a step that is already spoken for.

Three things the table does not show:

- **Weights are 400, `font-medium` (500) and `font-semibold` (600), with `font-bold`
  (700) reserved for the console's titles** — the TopBar, section titles, `Metric` values
  and `EmptyState` titles. The auth canvas's headings are all 600.
- **Line height needs saying out loud.** Tailwind pairs `text-sm` with a 20px line height
  (≈1.43); the canvas asks for 1.5–1.6 on multi-line body copy. Where it matters the class
  is explicit — `leading-[1.5]` on the full-access risk paragraph in `DeviceApproval.tsx`.
- **The 404 numeral is not a type step.** It is `text-7xl font-semibold text-border-strong`
  and `aria-hidden`, i.e. a graphic that happens to be made of digits.

## Spacing

Tailwind's spacing scale is 4px per step, and the boards were drawn on the same grid, so
most measurements land on a step:

| px | Class | Typical use |
| --- | --- | --- |
| 8 | `gap-2` | icon ↔ its label |
| 10 | `gap-2.5` | rows inside a title block |
| 12 | `gap-3` | stacked buttons |
| 14 | `gap-3.5`, `p-3.5` | inline panel padding |
| 16 | `p-4` | the device panel, the code-surface block |
| 20 | `py-5` | top bar and footer, vertical |
| 24 | `p-6`, `gap-6`, `px-6` | card padding on mobile, block gaps inside a card, the shell's horizontal padding |
| 32 | `px-8` | top bar and footer, horizontal |
| 36 | `sm:p-9` | the login card from `sm:` up |
| 40 | `sm:p-10` | every other card's padding from `sm:` up |

A handful of values are off the grid and written as arbitrary utilities — `gap-[26px]`,
`gap-[18px]`, `gap-[11px]`, `gap-[9px]`, `gap-[7px]`, `py-[13px]`, `py-[11px]`,
`px-[18px]`. Those are measured off the boards. If one looks wrong, check the board rather
than rounding it to the nearest step.

## Radius

| Class | Value | Applies to |
| --- | --- | --- |
| `rounded-sm` | 4px | brand mark and device icon plates |
| `rounded-md` | 6px | buttons, inputs, code boxes, inline panels |
| `rounded-lg` | 8px | the cards |
| `rounded-xl` | 12px | `@/components/ui/card.tsx` and the `Dialog` panel |

**The scale comes from the shared package, and this site declares none of it.** The
package derives all four from one `--radius: 0.5rem` base
(`calc(var(--radius) ± n)` in its `@theme inline`), so the desktop app and this console
round every shared component identically.

This used to be a fork: the site declared 6/10/14 as literals, measured off the boards. It
was reverted on 2026-08-19 because it silently made **every shared-package component**
about 1.7× rounder here than on the desktop. The transcript avatar was the tell — the
package ships `MESSAGE_AVATAR_CLASS` as `size-7 rounded-lg`, and 28px against a 14px radius
is a perfect circle, where the desktop draws a rounded square. Note the trap if anyone
proposes forking again: `@theme inline` bakes the literal **into the utility class** and
emits no `--radius-*` custom property, so a fork cannot afterwards be scoped back for the
package's subtree. Shared components and site components round together or not at all.

`design-token-contract.test.ts` asserts both halves: that the site's `@theme` declares no
`--radius-*` step, and that the package's chain still resolves to 4/6/8/12. The expected
values are computed from the package's own declaration rather than copied into a table, so
a deliberate change to `--radius` upstream flows through instead of going red.

`rounded-full` resolves to Tailwind's built-in. `rounded-xl` is unaffected by the revert —
it always came from the package's `--radius-xl`, which happens to equal Tailwind's built-in
12px, so the old note here that it "resolves to Tailwind's built-ins" was true only by
coincidence. `@/components/ui/card.tsx` (`rounded-xl` plus `shadow-sm`) is still *not* the
auth card. See [Components](#components).

## Cursors

**Do not write `cursor-pointer` on a component.** One rule in `@layer base` in
`globals.css` gives every clickable shape its hand cursor:

```css
button:not(:disabled),
[role="button"]:not([aria-disabled="true"]),
select:not(:disabled),
summary,
input:is([type="checkbox"], [type="radio"]):not(:disabled),
label:has(input:is([type="checkbox"], [type="radio"]):not(:disabled))
```

That rule exists because **Tailwind v4 dropped v3's preflight line**
`button, [role="button"] { cursor: pointer }` in favour of the browser's own
`cursor: default`. Nothing about the upgrade announces this: the DOM is unchanged, no
style errors, the suite stays green, and every button on the site quietly reverts to an
arrow. It is only visible to a mouse. The agent picker — "choose an Agent and start
chatting" — is what surfaced it: a full-width card that looked like a dead panel.

Per-component `cursor-pointer` was the other option and it is the wrong one. The shared
package `@agentre-hub/agentre-ui` does it that way (every button class string carries its
own copy), so its components were unaffected while this site's were not — which is the
tell. Spelling the affordance out per call site means "this is clickable" depends on each
author remembering to repeat it, and one omission is a regression only a mouse can find.
One concept, one implementation.

Two exclusions in that selector list are deliberate:

- **Disabled things get no hand.** `:not(:disabled)` for `button` and `select`; a
  hand-rolled `role="button"` (the project group-header menu) has only `aria-disabled`
  to go on. Where a disabled control should read as refused rather than merely inert,
  add `cursor-not-allowed` at the call site, as the agent rows do.
- **A `label` only counts when it wraps a checkbox or radio.** The search and filter
  fields here are also written `<label><input …></label>` (the chat top bar, the org
  index); those want an I-beam. A bare `label` in the list would take them with it.

Forking is still done with a utility class — `base` sits before `utilities`, so layer
order settles it and you never have to reason about specificity. That is how the org drag
handles keep `cursor-grab`.

`cursor-affordance.test.tsx` guards it: it reads the selector list out of `globals.css`
and runs it against each shape with `Element.matches`, so it fails on a rule that was
deleted *and* on one written too wide, rather than just asserting the string is present.

## The auth shell

`@/components/AuthLayout` is the frame for the auth screens — the login flow, the `/terms`
`/privacy` `/status` placeholders (`@/pages/ComingSoon`) and 404. The privacy placeholder
also states the served credential policy: API keys are account-hosted and synced only to
the user's own devices. The signed-in console uses its own frame, `AppShell` (see
[The console](#the-console)). It is a vertical
three-part layout — top bar, main, footer — on `flex min-h-screen flex-col bg-background`.

**Top bar.** Brand mark (a 28px `rounded-sm bg-primary` square holding a terminal glyph)
plus the product name at `text-[15px] font-semibold`, a flexible spacer, then `AppControls`
— the language and theme toggles, `Button size="icon-sm"` with the width and height
overridden to the board's 34px (`icon-sm` alone is 32). It sits **in the document
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
| Login | `pages/Login.tsx` | `w-full max-w-[424px]` | 424px |
| Device code entry | `pages/Device.tsx` | `w-full max-w-[496px]` | 496px |
| Authorization confirm | `components/DeviceApproval.tsx` | `w-full max-w-[576px]` | 576px |
| Success / denied / expired | `pages/Device{Success,Denied,Expired}.tsx` | `w-full max-w-[28rem]` | 448px |
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
  exception, `p-6 sm:p-9`: its board is drawn at 36 rather than 40.)
- The six code boxes flex: `min-w-0 max-w-[54px] flex-1`, `h-14` → `sm:h-[66px]`,
  `text-[22px]` → `sm:text-[26px]`. `min-w-0` is load-bearing — without it a flex item
  refuses to shrink below its content and the row pushes a horizontal scrollbar.
- The confirmation code is `text-[28px]`, `sm:text-[34px]`.
- The approval actions stack: `flex flex-col gap-3 sm:flex-row-reverse`.
- The footer row wraps.

## The console

`@/components/AppShell` is the frame for signed-in console pages. It is a two-part frame
on desktop (a 224px SideNav plus a TopBar/main column) and a single column with a bottom
TabBar on mobile — there is no hamburger or drawer. The auth screens keep `AuthLayout`
(above); the two shells never nest.

### Formal UI vs design commentary

An element from a design board may enter the product only when **all four** hold:

1. it serves the user's real task on that page — it is not explaining the design, the
   review, or the capability to someone;
2. it shows data that can come from real frontend state or a backend endpoint, or is
   expressed as an honest empty state;
3. it offers an action that has a real result and real failure handling;
4. it belongs to the product information hierarchy of the corresponding desktop or mobile
   board (not a note, callout, number, connector, rule line or comparison caption).

Everything else is commentary and is **deleted from the contract, not deprecated**:
Note/Context/Prompt/Callout elements, the `p5Orc` "现状 vs 优化" explanation, `N1`/`N2`-style
rule lines, the audit "这里记什么" card, the device page's persistent "撤销这台设备"
explainer card, and any other region that only explains a capability or its consequences.
The one exception is the short danger-consequence copy inside a revoke-confirmation dialog:
it supports an irreversible decision, so it appears only after the user has already chosen
the dangerous action.

There is no mechanical shortcut — a frame-drawn card can still be commentary. The tests
pin the *consequences* instead: no persistent revoke card, no audit nav item, no fake
search affordance, no sample numbers.

### Server console primitives

Server-owned repeated shapes live in `frontend/src/components/console/` (exported from
`index.ts`) and pages compose them without copying their dimensions, status colours or
type steps. Cross-host components continue to belong to `@agentre-hub/agentre-ui` as
described in [architecture.md](architecture.md#shared-frontend-packages).

| Component | Board node | Shape (what it fixes, so no one re-measures) | Used by |
| --- | --- | --- | --- |
| `ConsoleNavItem` | `ZC7pI` nav item | `h-[34px] rounded-md px-2.5`, 17px icon, 13px label; active = `bg-primary-soft text-primary-text`, idle = `text-muted-foreground hover:bg-accent`; trailing `badge` (> 0 only) / `meta` / `dot` are honest — the caller passes them only with real data | `AppShell` desktop SideNav (all six items) |
| `MobileTabBar` | `A6Z3k` bottom tab | `h-[74px] bg-card` + top border, 21px icon, 10px label, active = `text-primary-text font-semibold`, idle = `text-subtle-foreground font-medium`; items carry only real destinations | `AppShell` mobile bottom nav |
| `StatusMark` | `zF5jv` status pill | `rounded-full px-2.5 py-[5px]`, 6px dot + `text-xs font-semibold` text in the same token; `tone` maps to `running`/`waiting`/`idle`/`error` semantic tokens only; the label is always visible text — colour is never the only signal | `Devices` row status |
| `Metric` | `IhldU` stat card | `rounded-md border px-3.5 py-3`, label `text-[11.5px]` + 13px icon, value `text-[23px] leading-none font-bold` + `text-xs` unit, sub `text-[10.5px]`; `tone="danger"` swaps the whole card to destructive tokens; a data-less block renders `value="—"`, never a made-up number | `Overview` four stat tiles |
| `FilterChip` | `rNQXR` filter chip | `h-[22px] rounded-full px-[9px] text-[11px] font-medium`, active = `bg-primary-soft text-primary-text`, idle = `bg-secondary`; `disabled` renders a non-button `aria-disabled` span out of the focus order — the honest form when there is no real filtering | no current page (shared primitive) |
| `EmptyState` | the formal empty boards | 62px icon circle (`bg-primary-soft text-primary-text`, or warn), `text-lg font-bold` title, `text-[12.5px] leading-[22px]` body, optional action; only the shared hierarchy — page-specific content is assembled by the page from real data | `Overview` (the three distributions + the stats-unavailable state), `Devices` (no devices), `Chat` (desktop unselected + mobile empty) |

`frontend/src/__tests__/console-primitives.test.tsx` pins the sizes, states and the
"commentary must not become a component/locale key" boundary; `design-token-contract.test.ts`
pins the tokens those states use; `locale-parity.test.ts` keeps the two locale files
symmetric so commentary never enters the product copy either.

### The shell

`AppShell`'s root is `flex h-screen flex-col overflow-hidden bg-background md:flex-row` —
column on mobile, two parts on desktop. **The page itself never scrolls**: scrolling lives
inside `main`. That is what makes a pinned composer possible at all — with a root that grows
past the viewport, the SideNav, the TopBar and the session list scroll away with the
transcript.

**SideNav (desktop only).** `flex w-[224px] shrink-0 flex-col gap-3 border-r border-border
bg-sidebar p-3`, drawn on `--sidebar` — the board's `chrome` surface, made its own token
with this console (light #f4f4f5 / dark #111316, see [Colour tokens](#colour-tokens)).
Top to bottom:

- **Brand.** A 28px `rounded-md bg-primary` mark holding a `SquareTerminal` glyph
  (`size-4 text-primary-foreground`), then the product name at `text-[15px] font-semibold`
  — the same `authLayout.brand` string the login screen uses — over a 10px
  `text-subtle-foreground` line: `appShell.productSub`, "Console" (「控制台」).
- **Search, honestly disabled.** A 32px (`h-8`) full-width `rounded-md border border-border
  bg-card px-2.5` *display* element: a 13px `Search` icon and `appShell.searchPlaceholder`
  ("Search agents, devices, and records") at `text-xs`. There is no command palette, so it
  is a `div` with `aria-hidden` — not a `button`/`input`, no `tabindex`, no `⌘K` hint, and
  out of the focus order. It must never accept focus or imply a shortcut (`app-shell.test.tsx`).
- **Nav.** Five items rendered through the shared `ConsoleNavItem` (board `ZC7pI`), in
  this order: Overview, Chat, Devices, Org, Settings. Audit is not among them — it has no
  backend and its placeholder page was retired. Trailing data is best-effort
  and honest — none of it blocks the shell and none is invented:
  - **Chat** carries an amber badge — how many conversations this account has —
    `bg-status-waiting text-status-waiting-foreground`, `h-[17px] min-w-[17px]
    rounded-full text-[10px] font-semibold`, rendered only when it is > 0. The number comes
    from the server's `total` (`?axis=time&per_group=1`), never from `items.length`, which
    would silently become "how many are on this page". A page that already tracks that
    number can take the badge over with `chatBadge` — Chat does, so the badge follows its
    optimistic save/delete overlay instead of going stale until the next mount.
  - **Devices** carries a mono `online/total` Meta (`font-mono text-[10px]
    text-subtle-foreground`) — rows of `/v1/devices` (the same set as the Overview
    **Devices online** tile; the list no longer includes web) — rendered only when that
    list resolves.
- A `border-t border-border` divider, then **Account**: `h-[42px] rounded-md px-1.5` with a
  28px `rounded-full bg-primary-soft` avatar holding the first character of `display_name`
  at `text-sm font-semibold text-primary-text`, the name at `text-xs font-semibold`, and
  `appShell.accountMeta` at `text-[10px] text-subtle-foreground`. The row renders only once
  `/v1/auth/me` resolves — no account fetched, no fake avatar.

**TopBar.** `h-[52px] shrink-0 items-center gap-3 border-b border-border bg-card px-4`.
Left to right: a title slot at `text-[15px] font-bold` (the page's `nav.*` label), a
flexible spacer, the page's `right` slot, then — on mobile only — the account chip, then
`AppControls`. Both `title` and `right` are optional, so the pages that only set a title
stay unchanged. Two `right` conventions recur:

- **Cnt** — a `font-mono text-xs` `text-subtle-foreground` count, `aria-label`led. **Chat
  does not use it**: a bare number with no label next to it cannot be read as "how many
  conversations this account has", and the SideNav badge says the same thing with its label
  attached. Use Cnt only where the count sits next to something that names it.
- **Fresh** — "Desktop connected" (`appShell.topBar.fresh`): a `size-[6px] rounded-full
  bg-status-running` dot plus `text-xs`. It renders only when an `agentred` device is
  online; a browser (`web`) alone, unknown or offline → nothing, never a fabricated status.

A page can also take the whole band over with **`ownHeader`** — the shell then draws no
header at all. Chat's mobile form does this: 52px cannot hold title + page actions + account
+ language/theme, and stacking them blew the bar out to ~100px with the title clipped to
「对.」. Chat instead keeps identity and global controls on the first row and gives search
its own.

**Mobile bottom tab (board `A6Z3k`).** Below `md` the SideNav is removed entirely — no
hamburger, no drawer. The four high-frequency destinations (Overview, Chat, Devices, Org)
render in a `MobileTabBar` held at the bottom with `shrink-0` (the root no longer scrolls,
so `sticky` would buy nothing). The list derives from the SideNav's real routes minus
Settings, which deliberately stays out of the bar and is reachable from the account menu,
like `/account` — so no fake "Me"/placeholder entry exists and no low-frequency destination
crowds the bar. The account chip moves into the TopBar, and `AppControls` (language/theme)
stays in the TopBar — account, language and theme remain reachable without competing with
the bottom bar. `app-shell.test.tsx` and `mobile-nav-drawer.test.tsx` pin the
desktop/mobile split, the four-item boundary and the "no drawer, no fake blue dot" rule.

**Main.** `min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6`; each page owns
its own `mx-auto w-full max-w-[1200px]` column inside it. Pages that fill the viewport
themselves pass **`flush`**: `main` then drops its padding and its scrollbar
(`overflow-hidden`) and the page bands the space itself. Chat and `SessionDetail` do this —
that, not a negative margin, is how they sit flush under the TopBar.

### Overview (board `r5xRl` / `XwJfx` dark)

`mx-auto w-full max-w-[1200px] space-y-4`, driven by `GET /v1/stats/overview?range=7d|30d|all`.

The page used to be an Agent list with an amber "waiting on you" action strip and three
data-less cards. Two of its four tiles rendered `—` and half the page said "no data". The
stats endpoint replaced the missing sources, and the strip moved to the SideNav badge, so
the page is now stats-first.

- **TopBar**: **Fresh** (only when an `agentred` device is online) plus a three-way range
  segment — Last 7 days / Last 30 days / All time, `role="group"` labelled
  `overview.stats.range.label`. **The range only governs the summary and the three
  distribution cards; the heatmap is always one year.** Below `md` both leave the bar and
  render as the page's first row instead: at 390px the bar cannot hold them next to the
  title, the account and `AppControls` — until 2026-08-31 it did not, and the range
  segment sat on top of the account avatar with the title clipped to one character.
- **Four stat tiles** through the shared `Metric`, `grid grid-cols-2 gap-3 md:grid-cols-4`:
  Conversations (range count, account total as the sub), Current streak, Active days
  (`active_days / window_days`), Devices online. All four have a real source, so none of
  them renders `—` — except streak and active days on an account with no history at all,
  where a `0` streak would be a claim rather than a fact.
- **Full-width activity heatmap**, `components/stats/Heatmap.tsx`: 13px cells on a 3px
  gap, weeks as columns with row 0 = Sunday, five levels `bg-heat-0`…`bg-heat-4`, month
  labels absolutely positioned on the 16px column pitch, and a Less→More legend. The
  card header carries the covered months and, when `scope` is `full`, a **"Stats
  settings →"** link to `/settings?tab=privacy`. Under `saved` that link is dropped: the
  page-level notice above already links to the same place, and two links to one
  destination on one screen is a choice the reader has to make for no reason. Two side
  highlights (busiest day, average per active day) render only when the response carries
  them, **with their unit** — a bare `11` next to "Busiest day" reads like an index.
  A footnote names the timezone the day boundaries were cut in: they are the server
  machine's, and a reader in another timezone otherwise just sees their "today" off by
  one cell with nothing to explain it.
  - **A cell counts the conversations *started* that day**, not the ones active that day
    (`docs/architecture.md`'s activity-statistics section owns why). A week-long
    conversation lights only its first cell.
  - **Days after `heatmap.to` are not drawn.** The cell keeps its slot so the last column
    does not collapse, but gets no colour: painting a future day `heat-0` says "you did
    nothing that day" about a day that has not happened.
  - **`heat-0` means "nothing started that day", not "no data".** Which is why the skeleton is
    the same grid: before the fetch resolves the grid is already there in `heat-0`, so an
    845px block does not appear out of nowhere and shove the page down.
  - **Mobile draws 18 weeks, not 53, and never scrolls horizontally** — 53 weeks need
    845px, and a horizontally scrolling heatmap on a phone is unusable. The card says so
    (interpolating the count, so the copy cannot drift from the grid) and points at the
    desktop app. The count is a width budget, not a taste: the grid also carries a 33px
    weekday gutter, and a 390px phone leaves 324px of card content —
    `heatmapWidthPx`/`MOBILE_CARD_CONTENT_PX` own that arithmetic and
    `heatmap-grid.test.ts` guards it in both directions. It was 19 until 2026-08-31,
    which was budgeted against the viewport with the gutter forgotten and overflowed the
    card by 10px, clipping today's column; e2e's Pixel 7 (412px) is wide enough to hide it.
- **`scope`** has two values and both carry real data. `full` = activity reporting is on.
  `saved` = it is off, and the numbers cover only conversations saved to the account; a
  single `bg-primary-soft` notice at the top of the page says so once (not per card) and
  links to the privacy tab. **The heatmap still draws** — the saved slice is real, just
  sparser — it is never downgraded to an empty state.
- **Bottom row**, `flex flex-col gap-4 lg:flex-row`. Left, the **Agent usage** ranking
  (name, department chip, the machine it currently lands on, count, bar). The per-tier
  reordering is *not* here — it lives on the Org page (`OrgExecTargetSection`); the
  overview keeps only "where does it currently land", and only when that tier is really
  available. Right, `w-full shrink-0 lg:w-[300px]`: **Backends & models** (stacked share
  bar + legend + top models) and **Projects**.
  - Two empties are two different facts and must not merge: an empty `backend_type` is
    **Not reported**; an empty `provider_key` *and* `model_key` is **Follows the agent
    binding**, a real configuration. An empty `project_sync_id` is **No project**.
  - A distribution with no rows renders the shared `EmptyState`, never sample numbers.
- **Three unstable states** (board `l2U9p`): loading paints the tile skeletons and the
  empty grid; a failed fetch replaces the whole stats area with an alert (carrying a real
  Retry) plus a warn `EmptyState` that states what is *not* affected and links to `/chat`
  — it never falls back to a summary of zeros; a brand-new account (0 devices, 0
  conversations) gets a "register a device first" guide bar and the all-grey grid with the
  line that says the grey is absence of activity, not breakage.
- The stat grid goes 2-up on mobile and 4-up on desktop; the bottom row stacks on
  mobile — no horizontal overflow (`overview.test.tsx`).
- Agent names, departments and landing targets come from `/v1/workspace/agents`; project
  names from `/v1/workspace/projects`. Neither blocks the page. Account-channel signals are
  subscribed one class each: device presence → devices, sync version → agents + projects,
  mirror changed → the stats fetch.

### Devices (boards `Q6qgs4` / `Ukz7i` desktop, `HUELX` mobile)

`mx-auto flex w-full max-w-[1200px] flex-col gap-5` — one device list, **no right-hand
column and no persistent "撤销这台设备" explainer card**.

- **Device rows**, `flex min-w-0 flex-1 flex-col gap-2.5`. Each `Card` forced to
  `rounded-lg border-border bg-card py-4 shadow-none`. The desktop title row (`px-5`):
  status dot + device icon (`deviceKind.ts`'s `DEVICE_KIND_ICONS`, decorative and
  `aria-hidden`) + name at `text-[15px] font-semibold` + mono kind chip (`rounded-md bg-muted
  px-1.5 py-0.5 font-mono text-[10px]`) + shared `StatusMark` (online / offline / revoked) +
  an expand chevron (absent on `web` rows — a browser holds no projects or agents) + a
  shared-package `DropdownMenu`. The sub-row (`px-5 pt-1.5`) holds the `font-mono text-xs` meta
  (`platform · version · last active`) and the `cardSummary` line
  ("{{projects}} projects · {{m}} conversations running") **only when both numbers are
  actually known** — the project count from the detail endpoint and the running count from
  the relay — and is otherwise omitted, not zeroed.
- **Expand (agentred).** Expanding an online `agentred` card mounts a relay session query
  and shows three labelled sections (`font-mono text-[10px]` labels, `gap-1.5` chips):
  **Agents that can run here** (with mono rank), **Projects** (configured →
  `bg-muted text-muted-foreground`, unconfigured → `bg-status-waiting-bg
  text-status-waiting` — path **content** is never shown, only whether it is configured,
  per the privacy boundary), and **Conversations** (relay counts plus a "View this
  machine's conversations" drill-down; an offline machine shows a destructive "Offline —
  conversations are unavailable" line instead). A desktop row lists every account project
  (configured or not) and has no agents section. Expanding a failed row retries on the next
  open rather than caching the error.
- **Revoke.** Each **active** device (`status === ACTIVE`) gets one `DropdownMenu` item,
  "Revoke", which opens a confirm `Dialog` before calling `POST /v1/oauth/token/revoke`.
  Failure keeps the dialog context open and shows the real error; success closes it and
  refreshes the device list. Revoked devices render no revoke action. The row menu is the
  *only* revoke entry — the old right-side explainer card is gone, and the short danger
  consequence copy lives in the dialog, where it supports the decision instead of occupying
  the page.
- **No fake capabilities.** No accept-work toggle, no concurrency load bar, no server-side
  device path — elements with no real backend are not rendered, not even as disabled
  controls (`devices.test.tsx`, `device-expand.test.tsx`).
- **Mobile (`HUELX`).** The mobile row starts with the icon box (`size-9 rounded-md
  bg-muted`), then name / kind chip / `StatusMark` / mono meta, expand and row menu — a
  different information order and density, not a squeezed desktop row. Revoke still goes
  through the row menu + confirm dialog.
- TopBar: **Cnt** = device count (`aria-label`led) and **Fresh** when an `agentred` device
  is online.

### Chat (desktop `X9Mjl` / `uqEha` / `kpP7A`, mobile `IC5sH` / `C87ty` / `j571mC` / `eh9zO`)

The desktop form fills the shell's main area (`AppShell` gets `flush`, so there is no
padding to cancel and no negative margin).

- **Left — the 320px session-list column**, `w-[320px] shrink-0 flex-col border-r
  border-border bg-card`. Its header is a 52px band (`h-[52px] shrink-0 border-b`) so it
  lines up with the detail header across the divider: a **real search input** plus a 30px
  "new conversation" button (`chat.startNew`) that hands the **right pane** over to the agent
  picker. The list scrolls below it, and it never grows a row for a conversation that has not
  been started — a draft is not a session.
- **The search box** is a `border border-border bg-background` label + `type="search"`
  input, labelled `chat.searchSessions` ("Search conversations"). Two things about it are
  deliberate:
  - **`bg-background`, not `bg-muted`.** In dark, `--muted` and `--card` are the same value
    (#1d2025) and this column *is* `bg-card` — a `bg-muted` field is invisible against its
    own container. Measured: field and column both `rgb(29,32,37)`. With `bg-background` it
    reads `rgb(23,25,28)` on `rgb(29,32,37)`, plus a border.
  - **The copy says "conversations", not "agents, devices, and records".** Search is
    title-only and server-side; two of the three things the old string promised are not
    searchable any more.
- **Right — the detail pane**, `flex min-w-0 flex-1 flex-col`, embedding the real
  `SessionDetailView` (`form="embedded"`) — the same implementation as the
  `/devices/:id/sessions/:id` route, so status, transcript, approval and composer behaviour
  are shared, never a static placeholder. With nothing selected (or no sessions) it shows
  the `kpP7A` empty state. Starting a new conversation takes over this same pane — first
  `NewConversationPane` (pick an agent), then `DraftSession` (a conversation with nothing
  said yet). **Desktop needs no dialog**: this pane was already idle, and covering the screen
  to ask one question costs more than filling the space that was already there.
- TopBar: **Fresh** only (online-`agentred` dot; web alone never counts). The bare count
  moved to the SideNav badge, and "find conversations on your devices" is gone — the
  machine axis answers that question **on this page**, and its online group headers carry a
  「在这台机器上找」 affordance.
- **Mobile** keeps the list → detail flow, never the two-pane layout. It owns its top band
  (`ownHeader`): row 1 is title + a connection chip (dot **and** text) + account +
  `AppControls`; row 2 is the same real search at `h-9`. Below that the index scrolls, with
  a `PenLine` FAB (`fixed bottom-24 right-4 size-14 rounded-full bg-primary`) that raises the
  agent-picker bottom sheet when sessions exist. Picking an agent replaces the whole screen
  with `DraftSession`; there is no second column to put it in.

### The detail's three bands

`SessionDetailView` renders **header / transcript / composer**, and only the middle one
scrolls. Both forms use it, so the route page gets the same treatment.

It used to be one scroll region containing all three. Measured on a 1440×900 viewport: the
page was 2145px tall and the composer sat 1245px below the fold — to reply you scrolled to
the bottom, while the transcript kept growing underneath you. After the change the document
is exactly viewport height, the middle band scrolls internally, and the composer stays put
(re-measured with a 3230px transcript: composer fixed at top 830 / bottom 888).

- **Header** (`shrink-0 border-b bg-card`): the agent avatar (palette background + initial +
  `role="img"`, the shape `primitives.tsx`'s `AgentAvatar` uses on the desktop app), the
  title, and a mono meta line — `●Agent · relative time · machine online/offline`.
  Separators sit **between** parts that actually exist; a legacy session with neither status
  nor activity time must not leave a stray leading `·`. A **Stop** button appears only while
  the turn is actually running, and sends the real `runtime.abort`.
  **Project is deliberately absent**: `SessionSummary` has no project field (only the
  account mirror row does), and a guessed project name is worse than none.
- **Transcript** (`min-h-0 flex-1 overflow-y-auto`), `max-w-measure` centred.
- **Composer** (`shrink-0 border-t bg-card`) — see below. Approvals are **not** repeated
  here: the transcript already renders the card, and `interactiveRequestIds` dedupes the two
  sources.

### The composer

The shared package's `AIChatInput` (TipTap) — the same component the desktop app uses — in a
`rounded-lg border` shell with a single-line footer: shortcut hint, spring, context meter,
send.

`SessionComposer` has **two** hosts: `SessionDetailView` and `DraftSession`. The first
message of a conversation and every message after it are the same act, so they get the same
box — mentions, slash menu, shortcut hint and the send button's enable rule are one
implementation, not two that drift. The draft host differs in three props only: `backendType`
comes from the chosen dispatch tier rather than a live session, there is no context meter to
draw (no window has been reported yet), and it passes `handleRef` so the quick-start chips can
`insertText` into the editor — rich-text content lives in the editor, not in React state, so
appending to a string outside it would not reach.

**The placeholder is not written here.** `AIChatInput` derives it from what this render
actually wired up — omit the `placeholder` prop and you get a string that is true by
construction. That derivation used to be duplicated on both sides, keyed on `backendType`,
which is unrelated to whether the host wired any of those triggers; it now lives in the
package (`chat-input/placeholder.ts`) with its copy in the `agentreUi` namespace. Here the
inputs resolve to: `@` yes (agent mentions), `/` yes (`lib/slashCommands.ts`), `$` no
(listing skills is a Wails binding), `!` no (the wire has no PTY method).

`!` needs care twice over. With no `onCommandSubmit`, the package **clears** any line
starting with `!` without sending or saying anything — so "!!! this matters" vanishes; the
handler is wired purely to say so and put the text back. But wiring it would otherwise read
as "`!` works", so the composer also passes `localCommandsEnabled={false}` — the one bit of
this the package cannot infer.

The footer's **context meter** reads `context_window_updated` / `usage` off the relay stream
(`reduceSessionState`) — data that was already arriving and had nowhere to land. Window `<= 0`
means "not detected yet", so the meter is hidden rather than drawn against an invented
denominator; `>= 90%` turns `bg-status-error`.

The composer is loaded with a plain dynamic `import()`, **not** `React.lazy` + `Suspense`:
TipTap costs 252 kB gzip that four other pages never touch, but Suspense's reveal path
(`reappearLayoutEffects`) re-runs the subtree's effects against a destroyed editor and takes
the whole React tree down — which StrictMode guarantees you hit in `make dev`.

### Session list UX (`p5Orc`)

`ChatList` owns the desktop list; `sessionView.ts` owns the pure helpers and the shared
row's status colour (`statusDotClass`).

- **Two-line row.** Row1 (`text-sm font-medium`): the status dot (`size-2 rounded-full`,
  colour from `statusDotClass` — amber waiting, green running, red interrupted, grey
  otherwise), the title (`truncate`) and the relative time (`text-xs`, `formatRelativeTime`).
  Row2 (`mt-0.5 truncate text-xs text-muted-foreground`): **device · backend**
  (`.join(" · ")`). Row2 is honest about the data: it prints only when the session has a
  real title (a legacy session's degraded title is already "cwd · backend · status", so a
  sub-line would repeat it), and it carries **only the device name and backend — there is
  no project name server-side, so none is invented.** Untitled legacy sessions degrade to
  the `session.list.legacy` title.
- **Recent · across agents.** The flat section above the groups: the newest five sessions
  across all agents, ordered by `recentTimestamp(updatedAt, followedAt)`, reusing the same
  two-line row with no follow toggle — it is a digest, not a management list.
- **Filter chips.** `all / running / unread`, each `h-7 rounded-md px-2.5 text-[12px]
  font-medium`, active = `bg-primary-soft text-primary-text`. `running` = lifecycle
  `running` **and not** waiting for input. `unread` is a **real read state**, not a rename
  of "waiting": `last_message_at > last_read_at`, the same predicate the desktop app's
  attention-store uses, backed by `agent_sessions.last_read_at` and written by
  `POST /v1/agent-sessions/read` when you open a conversation **and again at every turn
  boundary while it stays open** — a single stamp taken at open is overtaken by the very
  turn you are watching finish, and the row you are reading goes unread in front of you.
  The two are
  different questions — a conversation you have read but which is parked waiting for input
  is not unread — so the SideNav badge keeps counting "waiting for you" while the
  index says "unread". The chip shows an amber count
  (`bg-status-waiting text-status-waiting-foreground`) when unread > 0, taken from the
  server's `total` for `filter=unread`, not counted locally. The only place the predicate
  runs client-side is the machine axis (that list comes live off the device and never passed
  through the server), and there it carries one extra clause: a conversation not yet saved
  into the account cannot be unread — it is not in your account at all.
- **Keyboard navigation.** The list container is `tabIndex={0}`; `ArrowUp`/`ArrowDown` move
  the `bg-primary-soft/40` selection highlight through recent, group and offline rows,
  `Enter` opens the selection (desktop embeds the row's real detail in the right pane;
  mobile navigates), `Escape` closes the context menu. A session that appears in both the
  recent section and its group is a single nav target — `recentKeys`/`navTargets` dedupe it
  so the highlight never lands in two places at once.
- **Right-click menu.** `role="menu"`, `fixed z-50 min-w-[160px] rounded-md border
  border-border bg-popover p-1 shadow-overlay`, items `text-[13px]`. It ships **only
  actions with a real backend**: a session/offline row gets "Open in new tab" (`window.open`)
  and "Unfollow" (`/v1/follows/unfollow`); an invalid row gets "Remove". **Rename and delete
  are deliberately absent** — there is no backend for either, and a fake button that claims
  success is worse than no button.
- **Search.** The desktop search box above the list filters the same rows the chips do
  (`matchesRowSearch`, including offline rows by device name); it is real behaviour, not a
  fake control. Mobile (`屏 20`) shows the same real search above its status-grouped list —
  the same filter, not a separate implementation.
- **Mobile (`IC5sH` / `C87ty`).** The same rows regroup by status — waiting → running →
  interrupted → others (`STATUS_GROUP_ORDER`) — with the agent name pinned to the row, a
  text badge so status never relies on colour alone, and a touch target ≥ 44px
  (`min-h-11`). The follow toggle is not on the mobile row; it lives on the detail page's
  top bar. On desktop it sits on group rows only — never in the recent section.

### Settings

`/settings` is the fifth desktop SideNav destination and is also linked from `UserMenu`;
it is intentionally absent from the four-item mobile TabBar. The page has three
sections: **LLM providers**, **Agent backends** and **Privacy**. The first two render the
shared `@agentre-hub/agentre-ui` engine panels; this host supplies only the account shell,
section navigation, sync notice and `EngineSettingsPorts` adapter. The section is also
addressable — `?tab=privacy` opens Privacy directly, which is what the two overview links
point at; a deep link that lands on the default tab leaves the user two steps from the
thing they just clicked towards.

- Provider/backend CRUD uses `/v1/engine/providers`, `/v1/engine/backends`, and
  `/v1/engine/cli-overlays`. Browser view models contain only `masked_tail` and CLI status;
  the adapter whitelists those fields and never carries an `api_key` or `cli_path` value
  into the panel.
- Test, model discovery and CLI scan select an online `agentred` from `/v1/devices`, then
  call `engine.test`, `engine.discover` or `engine.scan` through the existing browser relay
  client. No server outbound probe exists. With no online `agentred`, the action fails with
  a visible translated reason; saving account objects remains available.
- `cliPath` and other desktop-only ports are omitted. Optional actions therefore follow the
  shared-panel rule: no port means no affordance. With no registered execution device, an
  honest alert says configuration remains in the account and will sync after registration.

#### Privacy (board `I5Gb5y`)

`components/settings/ActivityStatsPanel.tsx`, read and written through
`GET`/`PUT /v1/stats/settings`. It is fetched **only when the tab is opened** — the other
two sections must not pay a request for a page they do not show.

- **Activity stats**: a `Switch`, the one-line explanation of what is reported daily, the
  current state, and the per-machine reporting progress. Everything the response omits is
  simply not drawn — no per-machine list means no section, not a row of "unknown".
- **The switch state always comes from the server's reply**, never an optimistic flip. The
  other half of turning it off is deleting the daily counts already stored; flipping the
  control and then failing the write tells the user their data is gone when it is not.
- **Both directions confirm**, for different reasons. Turning it *on* opens a `DialogShell`
  carrying the reported / never-reported comparison and the backfill checkbox, because the
  `PUT`'s `backfill` flag is a decision the user has to have seen. Turning it *off* — from
  the switch or from the danger zone, the same dialog either way — is a `danger` shell with
  a destructive submit, because it is irreversible. The danger zone is absent when the
  feature is already off: there is nothing left to turn off.
- **Saved conversations** is an explanation block, not a switch: only conversations the
  user explicitly saved live in the account, and unsaving happens per conversation on the
  Chat page. The count renders only when the response carries it.

### Decisions

| Decision | What the code does | Why |
| --- | --- | --- |
| Formal UI vs design commentary | Only elements that serve a real task with real data and real actions enter the product; notes/callouts/rule lines/explainer cards are deleted from the contract | The boards mix product and review commentary; only the four-part test above separates them |
| Shared console primitives | The repeated shapes (nav item, bottom tab, status pill, metric, filter chip, empty state, row menu) are one implementation in `components/console/`; pages compose, never re-measure | A single contract stops per-page drift and lets pages be built in parallel |
| Desktop two-line rows vs mobile status grouping | Same sessions, two layouts: desktop shows flat recents + two-line rows grouped by agent; mobile regroups by status (waiting pinned to the top) and pins the agent name to the row | The board's "优化" (`p5Orc`) fixes the two-line row for desktop; a phone keeps one dimension per row, so status becomes the grouping axis |
| Mobile navigation is a bottom tab of real destinations, not a mirror of desktop | Below `md` the SideNav is replaced by the `A6Z3k` TabBar with Overview / Chat / Devices / Org; Settings stays in the account menu | The board gives mobile its own navigation; a drawer's fake entries would imply destinations that do not exist, and the desktop IA can grow without crowding the bar |
| Honest empty states | `—` in tiles and data-less cards, and the shared `EmptyState` in data-less sections; a missing source renders the real layout, never a fabricated number | A made-up number reads as a product promise that has to be un-made later |
| The overview is stats-first | `GET /v1/stats/overview` backs all four tiles, the heatmap and the three distributions; the action strip moved to the SideNav badge and the three data-less cards are gone | Two of four tiles rendered `—` and half the page said "no data"; the endpoint made the honest layout possible, and a page whose job is to say "here is what happened" should not be mostly absence |
| A failed stats fetch is not a summary of zeros | The whole stats area is replaced by an alert with a real Retry plus a warn `EmptyState` naming what is unaffected | Zeros are a claim the user cannot falsify; "could not load" is one they can act on |
| The heatmap skeleton is the heatmap | Before data arrives the same grid is already painted in `heat-0` | An 845px block that appears at fetch time shoves the whole page down once per visit |
| Never fake a backend | Only actions with a real endpoint exist: revoke on devices, allow/deny/reply in the session detail, unfollow/remove on the list — **no rename, no delete, no fake success, no disabled-looking future controls**. No audit route, nav item, or dead "go to audit" link | A button that claims success it cannot deliver is worse than no button |
| Revoke lives in the row menu | Revoke is a shared-package `DropdownMenu` item → confirm `Dialog` → real `POST /v1/oauth/token/revoke`, with failure keeping the dialog and success refreshing the list; no persistent explainer card | A dangerous action must be discoverable without dominating the page |
| Desktop chat embeds the real detail | The right pane renders `SessionDetailView` (`form="embedded"`), the same implementation the `/devices/:id/sessions/:id` route uses; unselected shows the `kpP7A` empty state | A static placeholder would drift from the real page; one implementation keeps relay/approval/composer behaviour shared |
| Search is honest | Chat's list search really filters rows, server-side and by title only, and its copy says exactly that | A search affordance that promises more than it matches is a fake control either way |
| Unread is a real column, not a relabel | `last_read_at` on the mirror row; opening a conversation writes it, and so does every turn that lands while it is open; the chip filters on `updated_at > last_read_at` | This chip was once called 「未读」 over a `waiting_for_input` predicate, and the 2026-08-17 rename to 「等你处理」 was the honest fix at the time. Giving it a real read state is the other way to make the name true — and it matches what the desktop app already means by "unread" |
| The composer is pinned, not appended | `SessionDetailView` bands header / transcript / composer; only the middle scrolls, and `AppShell` stops the page scrolling at all | Measured: 2145px page against a 900px viewport put the input 1245px below the fold, and the transcript kept growing under it |
| The placeholder states capabilities, not a backend | `AIChatInput` derives it from what this render wired up; the host passes no `placeholder` | A `backendType` table promises `@ / !` to hosts that wired neither — the desktop app had a call site hand-writing a replacement string for exactly that reason |
| Sidebar is its own token | `--sidebar` (light #f4f4f5 = `--secondary`'s light, dark #111316 = `--code-surface`'s dark) | The board draws the nav in `chrome`; splitting it lets the nav and the code surfaces diverge independently |
| Shell data is best-effort | Badge, Meta, Account and the TopBar Fresh/Cnt render only when their source resolves | The shell must not block the page on a number it cannot get |

## Theming

Three pieces, and they only work as a set:

1. `globals.css` defines `.dark { ... }`.
2. `globals.css` declares **`@custom-variant dark (&:is(.dark *))`**.
3. `@agentre-hub/agentre-ui`'s `ThemeProvider` toggles the `dark` class on `<html>`.

Miss the second and Tailwind's `dark:` variant falls back to the `prefers-color-scheme`
media query and stops following the class, so the whole `.dark` block becomes dead code —
silently, since light mode still looks fine.

`ThemeProvider` wraps the app in `main.tsx`. `useTheme()` gives `{ theme, resolved, setTheme }`,
where `theme` is the user's choice (`'light' | 'dark' | 'system'`) and `resolved` is what is
actually showing. The choice persists to `localStorage` under `agentre.theme`, and `'system'`
follows `prefers-color-scheme` live.

```tsx
import { useTheme } from '@agentre-hub/agentre-ui';

const { theme, resolved, setTheme } = useTheme();
```

Verify both modes. `e2e/smoke.spec.ts` asserts the class lands on `<html>` and survives a
reload; it cannot tell you the result looks right.

## Responsive

Both form factors are supported, so build mobile-first and add `sm:`/`md:` upward.

- **The shell already gives you full height and horizontal padding.** `AppShell`'s root
  carries its own `min-h-screen` (the console frame, the same pattern as `AuthLayout`), and
  `RequireAuth`'s loading state carries one too because it renders *instead of* the page.
  Do not add a second `min-h-screen` inside main: main is already at least a viewport tall
  minus the bars, so a `min-h-screen` child pushes the footer off-screen and every page
  gains a scrollbar worth exactly the header plus footer.
- **The console's mobile form is a different tree, not a squeezed desktop.** Below `md` the
  SideNav is replaced by the bottom `MobileTabBar` of real destinations; device and chat
  rows regroup (devices by their own mobile row shape, chat by status); Overview's stat
  grid goes 2-up and its two-column row stacks.
  Each page reorders without horizontal overflow (`overview.test.tsx`).
- Dialogs need `w-[calc(100%-2rem)]` alongside `max-w-*`, or they touch both edges — see
  the package's `dialog.tsx`.
- A row of actions stacks on mobile: `flex flex-col gap-3 sm:flex-row-reverse`
  (`DeviceApproval.tsx`). The DOM order puts the primary action first, so keyboard and
  screen-reader users reach it first; `row-reverse` puts it back on the right on desktop.
- Controls must stay reachable — see `AppControls`, which uses icon-sized buttons rather
  than labelled ones so it fits a narrow viewport.

The e2e suite runs **every spec against `desktop-chromium` and `mobile-chromium`**, and
one spec asserts no horizontal overflow on the login screen and on the six code boxes —
under the mobile project, that is the assertion that catches a card sitting edge-to-edge
or a flex row that refuses to shrink. A desktop-only pass tells you nothing about mobile,
and a jsdom unit test tells you nothing at all here: it computes no layout.

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

All UI copy goes through `t()`. Locale files are split by module, one file per top-level
key, under `frontend/src/i18n/locales/{en,zh-CN}/`; each directory's `index.ts` merges them
into the one bundle i18next receives. **`en` is the reference** for the key set.

```
locales/en/device.json        ->  t('device.entry.title')
locales/en/sessionIndex.json  ->  t('sessionIndex.…')
locales/en/index.ts           ->  merges all of them into one bundle
```

**The filename is the top-level key** — `device.json` holds the subtree *under* `device`,
without repeating that level inside the file. Adding a module means adding the json to both
language directories and one import line to each `index.ts`; forgetting the import, or
mounting a file under the wrong key, is caught by `locale-modules.test.ts`
(`locale-parity` cannot see it — a module missing from *both* languages is still in parity).

```tsx
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();
return <h1>{t('device.entry.title')}</h1>;
```

Enforced by `i18next/no-literal-string` (`mode: 'jsx-only'`), which also covers
`aria-label`, `title`, `placeholder` and `alt` — those are user-visible too, and they are
the ones that get forgotten.

Adding copy: add the key to **both** languages' module file.
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

Use the shadcn primitives exported by `@agentre-hub/agentre-ui`; `@/components/ui/` holds
only what is genuinely server-only (today: `card.tsx`). Compose class names with `cn()`
from the same package — it merges Tailwind classes correctly, which naive string
concatenation does not.

```tsx
import { cn } from '@agentre-hub/agentre-ui';

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
- **`Alert` has content slots; text is not one of them.** `Alert` is a two-column grid
  whose first column exists for an icon and is **zero-wide when there is none**; only
  `AlertTitle` and `AlertDescription` carry `col-start-2`. Text placed directly in
  `<Alert>` lands in that zero-wide column and renders as a single column of characters
  — measured at 28px wide by 457px tall on the live console before this was fixed. Put
  the copy in `<AlertDescription>` (and a heading in `<AlertTitle>`); the icon, if any,
  stays a direct child. A lint rule enforces it (`eslint-rules/alert-slots.js`).
- **`Dialog` is not a screen.** The approval step is a region of `/device`, not a dialog,
  because `role="dialog"` tells a screen reader the rest of the page is inert when it is
  the whole page. Reach for `Dialog` for a confirm-and-dismiss interaction, as the device
  list does.

## Dialogs

Two kits come out of `@agentre-hub/agentre-ui`, and which one you reach for is not a
matter of taste:

- **`DialogShell` — use this for anything new.** It is the spec below.
- The bare `Dialog` / `DialogContent` primitives — the older single-size shell. One place
  still reaches for them, and deliberately: `NewConversationSheet` wants a bottom sheet at
  **every** width, while `DialogShell`'s sheet form only holds below `sm:`. That is a
  reason, not debt. Anywhere else, use `DialogShell`.

### The spec

**Three sizes, chosen by purpose.** `sm` 420 for a single decision, `md` 560 for the
form of one thing, `lg` 760 for anything with a browsing panel. Pass `size`; do not
push a width in through `className` at the call site — that is how a confirm box ends
up as wide as a directory picker.

**Below 640px it is a bottom sheet, and that is the base style.** Full width, pinned
to the bottom, top corners rounded, at most `90dvh`, footer above the safe area, grip
visible. The centred card is the `sm:` override, not the other way round — writing the
card as the base and overriding with `max-sm:` paints one frame of the card first.
Same component, same props: the form is not written twice.

**Only the body scrolls.** Header and footer are `shrink-0`; the body is
`min-h-0 flex-1 overflow-y-auto`. Leave out `min-h-0` and the flex child refuses to
shrink, so long content pushes the header and footer out of view instead of scrolling.

**Errors land inside the dialog.** A whole-dialog error goes in the footer, on the
left, on the same line as the buttons — that is where the eyes of whoever pressed the
button already are. Field-level errors go under their field, which is the caller's job.
Do not hang the failure on the page behind the dialog.

**The primary button carries its own busy state** — spinner plus disabled, via
`DialogShellSubmit busy`. While busy, neither `Esc` nor a click on the overlay closes
the dialog: the write is in flight, and closing only makes the user think it never
went out.

**A dangerous confirm is a shape, not a sentence.** `danger` on the shell and the
header, `variant="destructive"` on the submit. The consequences go in the body; the
title stays one line.

**A dialog that saves as you go has no Save button.** Its footer holds only Done, and
the save state (`saving` / `saved` / `error`) sits at the top right of the header via
`saveState` — the same shape the org detail header already uses.

```tsx
<DialogShell open={open} onOpenChange={setOpen} size="md" busy={saving}>
  <DialogShellHeader title={t('project.create.title')} onClose={close} busy={saving} />
  <DialogShellBody>{/* fields */}</DialogShellBody>
  <DialogShellFooter error={error}>
    <Button variant="ghost" onClick={close}>{t('common.cancel')}</Button>
    <DialogShellSubmit busy={saving} onClick={submit}>
      {t('project.create.submit')}
    </DialogShellSubmit>
  </DialogShellFooter>
</DialogShell>
```

**Check the narrow variant in a real narrow viewport.** `sm:` reads the *viewport*
width, not the container's, so shrinking a box inside a wide window shows you a
centred card that no phone will ever render. Use the browser's device toolbar, or a
real device.

## Async state

**There is no shared query layer.** Each page or feature hook owns its own `loading` /
`error` state and calls `api()` directly. The one shared piece is `useAliveEffect`
(`frontend/src/hooks/use-api-query.ts`, used in 19 production files): it stops a round's
callbacks from writing state once that round no longer counts. Its own doc comment owns
why, including the fetch race it prevents. `useApiQuery` in the same file folds
mount-guard + loading + error together for a plain read, but only `use-me.ts` needs that
shape — `Promise.all`, relay calls and post-success work do not fit one hook, and forcing
them through it only adds a shell.

**Pending → empty → data, at the container that changed.** `ProjectAgentPane`:

```tsx
<nav aria-label={t('chat.projects')} aria-busy={projectsPending || undefined}>
  {projectsPending ? (
    <ProjectTreeSkeleton stacked={stacked} />
  ) : ordered.length === 0 ? (
    <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground">
      {t('chat.noProjects')}
    </p>
  ) : (
    ordered.map(/* … */)
  )}
</nav>
```

**Skeleton for a first paint, spinner for something in flight.** A list or grid whose
shape is already known paints that shape — `SessionListSkeleton`, `AgentPickList`,
`ProjectTreeSkeleton`, `DeviceListSkeleton`, `CardListSkeleton`, `OrgIndexSkeleton`,
`OrgDetailSkeleton`, `ActivityStatsSkeleton`, the `Overview` tiles and heatmap. A spinner
is only ever a small marker on a live control or status: `SessionConnectionIndicator`, the
transient state in `SessionIndex`, `OrgDetailHeader`'s save state, `DialogShellSubmit busy`,
and the composer's own submit key while a send is in flight (`ChatComposer sending`).

**The bar itself is not written here.** Every one of those skeletons is built from
`Skeleton`, the primitive exported by `@agentre-hub/agentre-ui`; it carries the fill, the
pulse, the reduced-motion form and `aria-hidden`, and the caller supplies only size, radius
and — where the placeholder is a card face rather than a bar — a different surface. Do not
re-declare that class string locally: it had been inlined at ten sites across the two hosts
and the package, and two of them had already drifted to `bg-muted`, which is nearly
invisible against `--background` in light mode and reads as a broken render rather than a
placeholder. `src/__tests__/shared-ui-package.test.tsx` guards that the copies do not grow
back.

**A skeleton has to hold the space it is standing in.** A single centred "Loading…" line
occupies almost no height, so the page jumps once when the real content lands — and it
looks identical to "this account has nothing here". Shape the placeholder like the rows it
replaces.

**A re-fetch over content already on screen does not go back to the skeleton.**
`useOrgData.reload()` sets data and error but never raises `loading` again, so the account
channel's `sync_version` signals refresh the org chart in place; only the first load
paints the skeleton.

**Nor does its label move before its numbers do.** `Overview` keeps the range that the
figures on screen actually came from (`loadedRange`, settled with the response) and labels
them with that, not with the range the user just clicked. Flipping the label first leaves a
window where four tiles read "Last 7 days" over 30-day numbers — legible and wrong, which
is worse than a moment of skeleton. The same shape answers "is this round still in
flight": compare the answer's key with the current one instead of keeping a `loading` flag
that some path forgets to raise (`OrgExecTargetSection`'s skill catalogue and
`DraftSession`'s dispatch plan are the other two).

**An error is not a slow load, and it always has a way back.** Test the error branch
*before* the not-yet-arrived branch: a failed round typically leaves the data `null`, so
ordering `data === null` first parks the card on a "Loading…" that never ends and renders
the translated failure copy nowhere (`Account`'s passkey and session cards both did). Every
load failure carries a retry next to it — `CardLoadError`, the `Overview` and privacy
alerts, `Org`'s two columns, the device detail panel, `SessionScrollBody`'s earlier-messages
row — because the alternative is asking the reader to reload a page whose other cards are
fine. A retry that is already in flight disables its own button; otherwise a second failure
changes nothing on screen and the reader just clicks again.

**A failed round must not be readable as a finished one.** Silence at the top of a
transcript reads as "this is the beginning of the conversation"; a dispatch placeholder
that unmounts on failure takes the user's typed message with it. Say the round failed, keep
what the reader wrote, and offer the retry.

## Accessibility

**Never encode meaning in colour alone.** Selection carries `aria-pressed` (`FilterChip`,
`AddDeviceGuide`'s device/OS buttons, the `SessionIndex` filter, the `Overview` range),
position in a flow carries `aria-current` (`"step"` on `AddDeviceGuide`'s step bar,
`"true"` on `ProjectAgentPane`'s project tree), and a collapsible row carries
`aria-expanded` (`Devices`, `Account`).

**A control with nothing behind it leaves the focus order** rather than rendering as a
disabled button. `FilterChip disabled` and the `AppShell` search display are the two
instances, each specified where it is defined above.

**Icons are decoration; text is the name.** An icon beside its own label carries
`aria-hidden="true"`; an icon that *is* the control carries `aria-label`. When
`ConsoleNavItem` collapses, its label drops to `sr-only` instead of unmounting — a link's
accessible name must not change with the sidebar's width.

**Announce by urgency.** In-place, non-urgent state uses `role="status"`
(`PendingSendBubble`, `DecisionPanel`, the composer's model and effort controls, and
`SessionConnectionIndicator`, which adds `aria-live="polite"`). A failure uses
`role="alert"` (`SendFailureBubble`, `DraftSession`, `Issues`, `Org`, `ChatIndexPanel`).
When the change has no visible text of its own, add an `sr-only` announcer, as
`DeviceApproval` and `OrgExecTargetSection` do.

**Fetching is announced once, by the container being filled.** `aria-busy` sits on that
region — `ProjectAgentPane`'s nav and list, `SessionScrollBody`, `Chat`'s panes,
`NewConversationSheet`, `NewConversationPane`, the `Overview` tile grid and its three
distribution cards, the device list and each expanded device panel, `Account`'s two cards,
the privacy panel, `Org`'s index and detail columns, and the group overflow popover — and
the skeleton inside it stays silent. A dozen grey bars read aloud add nothing the container
has not already said; the shared `Skeleton` is `aria-hidden` by default and records why at
its definition, so the only thing a caller has to remember is the `aria-busy` on the
container above it.

**Every animation has a reduced-motion form.** Skeleton pulses and spinners carry
`motion-reduce:animate-none` — for skeletons the primitive carries it, so it cannot be
forgotten one placeholder at a time. Degrade, do not delete: `SessionConnectionIndicator`'s
travelling bar becomes a static full-width line at 40% opacity, because the connection is
still live and the indicator still has something to say.

A hand-written focusable control brings its own ring —
`outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`, as `UserMenu`,
`AddDeviceGuide`, `Account` and `OrgIndexPanel` write it. Shadcn primitives from
`@agentre-hub/agentre-ui` already carry theirs; do not restyle those.

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
6. Check light **and** dark, desktop **and** mobile, keyboard focus order, and the
   pending → empty → data transition.
7. Run the frontend lint, test and build gates. Use `make e2e` when real browser coverage
   is required; [verification.md](verification.md) owns how to choose and report that run.
