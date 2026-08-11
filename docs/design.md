# Design system

The frontend is React 19 + Vite + Tailwind 4 + shadcn components, embedded into the
Go binary at build time. It ships **light and dark**, **desktop and mobile**, and
**English and Simplified Chinese** — all four are supported, so all four have to work
in anything you add.

## Where the pixels come from

The pixels come from a design canvas (`agentre-server.pen`, kept in the designer's
`设计稿` folder — it is **not** in this repository and is not version-controlled), whose
boards are cited by number: the auth flow and 404 are boards 01–19 and 38–39, each screen
drawn desktop and mobile, light and dark; the console is boards 40 (overview), 41/44
(devices, light and dark), 49/49b (chat) and 43 (audit), with 20/29/32 for the mobile
forms and the `p5Orc` "现状 vs 优化" comparison fixing the session-list UX.

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
--status-running / -bg, --status-waiting / -bg / -foreground, --status-idle, --status-error
--code-surface / --code-foreground / --code-muted-foreground
--sidebar                       the console SideNav surface (chrome on the board)
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

Two groups do not line up, and both are intentional:

- The board draws the SideNav in the same `chrome` family the code splits in two:
  `--code-surface` keeps the command/hook output surfaces, and `--sidebar` (added with the
  console) is the console's nav surface — light #f4f4f5 (the light of `--secondary`) and
  dark #111316 (the dark of `--code-surface`). A dedicated token lets the two diverge
  without touching either. `warn-fg` gained one too: `--status-waiting-foreground`, the
  dark-brown text on the amber badge, shared by the SideNav chat badge and the unread chip.
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
| Console h1 / section title | `text-sm font-bold` | 14 / 700 | Overview Agent-card h1, `SectionCard` titles |
| Console group heading | `text-sm font-semibold` | 14 / 600 | `ChatList` / `SessionList` group headers |
| Stat value | `text-2xl leading-none font-bold` | 24 / 700 | Overview stat tiles |
| Action strip title | `text-[13px] font-bold` | 13 / 700 | Overview `ActionStrip` |
| Console small | `text-xs` | 12 / 400–500 | rows, chips, TopBar counts, `Fresh` |
| Console caption / mono meta | `text-[10px]` / `text-[11px]` | 10–11 / 400–600 | brand sub, account meta, badges, `online/total` Meta |

The canvas's scale also names `Display / 32 · 600` and `H2 / 18 · 600`. Neither has a use in
this flow, so no class carries one; add `text-[32px]` / `text-lg` at 600 when a screen
finally needs them, rather than stretching a step that is already spoken for.

Three things the table does not show:

- **Weights are 400, `font-medium` (500) and `font-semibold` (600), nothing else.** The
  canvas's headings are all 600.
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
| `rounded-sm` | 6px | brand mark and device icon plates |
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

`@/components/AuthLayout` is the frame for the auth screens — the login flow, the `/terms`
`/privacy` `/status` placeholders (`@/pages/ComingSoon`) and 404. The signed-in console
uses its own frame, `AppShell` (see [The console](#the-console)). It is a vertical
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

`@/components/AppShell` is the frame for every signed-in page — Overview, Chat, Devices,
`DeviceSessions`, `SessionDetail` and `WorkspaceComingSoon`. It is a two-part frame (a
224px SideNav plus a TopBar/main column) on desktop and a hamburger + drawer on mobile.
The auth screens keep `AuthLayout` (above); the two shells never nest.

### The shell

**SideNav.** `flex w-[224px] shrink-0 flex-col gap-3 border-r border-border bg-sidebar p-3`,
drawn on `--sidebar` — the board's `chrome` surface, made its own token with this console
(light #f4f4f5 / dark #111316, see [Colour tokens](#colour-tokens)). Top to bottom:

- **Brand.** A 28px `rounded-md bg-primary` mark holding a `SquareTerminal` glyph
  (`size-4 text-primary-foreground`), then the product name at `text-[15px] font-semibold`
  — the same `authLayout.brand` string the login screen uses — over a 10px
  `text-subtle-foreground` line: `appShell.productSub`, "Console" (「控制台」).
- **⌘K search.** A 32px (`h-8`) full-width `rounded-md border border-border bg-card px-2.5`
  button: a 13px `Search` icon, `appShell.searchPlaceholder` at `text-xs`, and a
  `font-mono text-[10px]` `⌘K` kbd hint. It is a visual affordance — there is no command
  palette behind it yet.
- **NavGroup.** Four `NavLink`s, each `h-[34px] rounded-md px-2.5 text-[13px] font-medium`
  with a 17px icon. Active is `bg-primary-soft text-primary-text`; idle is
  `text-muted-foreground hover:bg-accent`. The trailing data is best-effort and honest —
  none of it blocks the shell and none of it is invented:
  - **Chat** carries an amber badge — the follow count from `/v1/follows` —
    `bg-status-waiting text-status-waiting-foreground`, `h-[17px] min-w-[17px]
    rounded-full text-[10px] font-semibold`, rendered only when it is > 0.
  - **Devices** carries a mono `online/total` Meta (`font-mono text-[10px]
    text-subtle-foreground`) — the agentred subset of `/v1/devices` — rendered only when
    that list resolves.
  - **Audit** carries a blue dot (`size-1.5 rounded-full bg-primary`). The audit page does
    not exist yet, so the dot is a placeholder, not a live alarm.
- A `border-t border-border` divider, then **Account**: `h-[42px] rounded-md px-1.5` with a
  28px `rounded-full bg-primary-soft` avatar holding the first character of
  `display_name` at `text-sm font-semibold text-primary-text`, the name at
  `text-xs font-semibold`, and `appShell.accountMeta` at `text-[10px] text-subtle-foreground`.
  The row renders only once `/v1/auth/me` resolves — no account fetched, no fake avatar.

**TopBar.** `h-[52px] items-center gap-3 border-b border-border bg-card px-4`, in the
document flow exactly like `AuthLayout`'s header. Left to right: a mobile `Menu`
hamburger, a title slot at `text-[15px] font-bold` (the page's `nav.*` label), a flexible
spacer, the page's `right` slot, then `AppControls`. Both `title` and `right` are optional,
so the older pages (`DeviceSessions`, `SessionDetail`, `WorkspaceComingSoon`) pass a title
and nothing else. Three `right` conventions recur:

- **Cnt** — a `font-mono text-xs` (`text-[12px]` on Chat) `text-subtle-foreground` count,
  `aria-label`led.
- **Fresh** — "Desktop connected" (`appShell.topBar.fresh`): a `size-[6px] rounded-full
  bg-status-running` dot plus `text-xs`. It renders only when an `agentred` device is
  online; unknown or offline → nothing, never a fabricated status.
- **FindBtn** — Chat's "Follow conversations from your device" (`chat.followFromDevice`),
  an `h-7 rounded-md border border-border px-2.5 text-[12px] font-semibold` link to
  `/devices`.

**Mobile drawer (board 29).** Below `md` the SideNav becomes a hamburger + left drawer:
`fixed inset-0 z-50`, a full-screen `bg-scrim` button that closes on tap, and a panel
`w-[280px] max-w-[80vw]` with `bg-sidebar border-r border-border shadow-overlay` carrying
the same Brand, ⌘K, NavGroup, divider and Account, plus the close button and `AppControls`
in its footer. Opening mounts the node and closing unmounts it, so hidden content never
stays in the focus order; `aria-expanded` on the hamburger tracks the state.

**Main.** `min-w-0 flex-1 px-4 py-5 md:px-8 md:py-6`; each page owns its own
`mx-auto w-full max-w-[1200px]` column inside it. Chat's desktop form is the exception — it
bleeds edge-to-edge (see below).

### Overview (board 40)

`mx-auto w-full max-w-[1200px] space-y-4`.

- **Four stat tiles**, `grid grid-cols-2 gap-3 md:grid-cols-4`. Each tile is
  `rounded-md border border-border bg-card p-3.5` with a 14px icon + `text-xs
  text-subtle-foreground` label, a value at `text-2xl leading-none font-bold` and an
  optional `text-[11px]` sub. Two tiles have real sources — **Devices online** (non-web
  rows of `/v1/devices`, first offline device as the sub) and **Waiting on you** (follows
  + relay `session.list`, counted only when every follow is decidable, longest wait as the
  sub). **Used today** and **Issues** have no backend source: the tile renders with `—` —
  the honest empty state, never a made-up number.
- **Amber action strip.** `rounded-lg border border-status-waiting/40 bg-status-waiting-bg
  p-3.5` (`gap-[11px]`), with a `text-[13px] font-bold text-status-waiting` title
  (`overview.actionStrip.title`), the longest-wait sub and an "All conversations →" link.
  Below, at most three waiting conversations as cards; each card gets only the actions its
  relay waiter data supports — Allow/Deny for a tool permission, Reply/View-details for a
  question. The strip renders **only when at least one waiting conversation's waiters
  resolved**; no waiting sessions, no strip, and never a fake button.
- **Two columns**, `flex flex-col gap-4 lg:flex-row`. Left (`flex min-w-0 flex-1 flex-col
  gap-4`): the **Agents** card — h1 `text-sm font-bold`, count subtitle, rows in
  `divide-y divide-border` with avatar dot, name, department chip and the execution-target
  chip chain — then **Recent authorizations & changes** (`SectionCard`:
  `rounded-lg border border-border bg-card p-3`, title `text-sm font-bold`, "All audit →").
  Right, `w-full shrink-0 lg:w-[340px]`: **Usage this month** and **Security & audit**
  (last sign-in and active-token rows). The three right/under cards have **no data source**
  — they render the real layout with `—` placeholders, and "View usage →" is plain text
  because no usage page exists, while "All audit →" is a real link to `/audit`.

### Devices (boards 41 / 44)

`mx-auto flex w-full max-w-[1200px] flex-col gap-5 lg:flex-row`.

- **Left — the device card list**, `flex min-w-0 flex-1 flex-col gap-2.5`. Each card
  (`Card` forced to `rounded-lg border-border bg-card py-4 shadow-none`) has a `px-5` title
  row: the name at `text-[15px] font-semibold`, a mono kind chip (`rounded-md bg-muted
  px-1.5 py-0.5 font-mono text-[10px]`), an online/offline/revoked `text-xs` status
  (`text-status-running` when active and online), a `font-mono text-xs` meta
  (`platform · version · last active`), and an expand chevron — except on `web` rows, which
  have nothing to expand (a browser holds no projects or agents). The `cardSummary` sub-row
  ("{{projects}} projects · {{m}} conversations running") prints **only when both numbers
  are actually known** — the project count from the detail endpoint and the running count
  from the relay — and is otherwise omitted, not zeroed.
  Expanding an online `agentred` card mounts a relay session query and shows three labelled
  sections (`font-mono text-[10px]` labels, `gap-1.5` chips): **Agents that can run here**
  (with mono rank), **Projects** (configured → `bg-muted text-muted-foreground`,
  unconfigured → `bg-status-waiting-bg text-status-waiting`), and **Conversations** (relay
  counts plus a "View this machine's conversations" drill-down; an offline machine shows a
  destructive "Offline — conversations are unavailable" line instead).
- **Right — the revoke danger card**, `w-full shrink-0 lg:w-[340px]`:
  `rounded-lg border border-destructive/30 bg-card p-3.5`, title `text-sm font-semibold
  text-destructive`, body `text-xs leading-relaxed text-muted-foreground`, and a full-width
  destructive **Revoke**. It targets the **first device in the list** — the list has no
  selection concept, matching the existing device-management semantics — and confirms in a
  `Dialog` before calling `/v1/oauth/token/revoke`. The card renders only when there is at
  least one device.

### Chat (board 49b)

The desktop form bleeds to the shell's edges with a negative margin
(`-mx-4 -my-5 flex h-full flex-row md:-mx-8 md:-my-6`) so the columns sit flush under the
TopBar.

- **Left — the 320px session-list column**, `w-[320px] shrink-0 flex-col border-r
  border-border bg-card`. Its `p-2.5` header row holds a 30px filter-icon slot, a
  `h-[30px] rounded-md bg-muted` search input and a 30px "new conversation" button; the
  list scrolls in `min-h-0 flex-1 overflow-auto p-2.5`. The filter icon and search are
  placeholders (the real filter chips live in `ChatList`, below); the Plus button opens the
  new-conversation dialog.
- **Right — the detail pane**, `flex min-w-0 flex-1 flex-col items-center justify-center
  gap-3.5 p-4`. The empty state is centred rather than a card: a `size-[62px] rounded-lg
  bg-primary-soft` box holding a `size-8 text-primary-text` `MessagesSquare`, an
  `text-lg font-bold` "No conversations yet.", a `max-w-sm text-center text-[12.5px]
  leading-[22px]` body, a `size-lg` primary "Start your first conversation" button, and a
  `text-[11.5px] text-subtle-foreground` find-more link. With sessions present the pane
  keeps the icon box and stays quiet — selection is a left-column interaction.
- TopBar: **Cnt** = total count, **Fresh** = online-agentred dot, **FindBtn** =
  follow-from-device.
- **Mobile (boards 20 / 32)** keeps the pre-existing shape — a status-grouped list and a
  centred **card** empty state — never the two-pane layout.

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
  `running` **and not** waiting for input; `unread` = waiting for input — waiting is a live
  overlay on top of running and never also lands in `running`. The unread chip shows an
  amber count (`bg-status-waiting text-status-waiting-foreground`) when unread > 0.
  Filtering applies to the recent section too, so the two never disagree.
- **Keyboard navigation.** The list container is `tabIndex={0}`; `ArrowUp`/`ArrowDown` move
  the `bg-primary-soft/40` selection highlight through recent, group and offline rows,
  `Enter` opens the selection, `Escape` closes the context menu.
- **Right-click menu.** `role="menu"`, `fixed z-50 min-w-[160px] rounded-md border
  border-border bg-popover p-1 shadow-overlay`, items `text-[13px]`. It ships **only
  actions with a real backend**: a session/offline row gets "Open in new tab" (`window.open`)
  and "Unfollow" (`/v1/follows/unfollow`); an invalid row gets "Remove". **Rename and delete
  are deliberately absent** — there is no backend for either, and a fake button that claims
  success is worse than no button.
- **Mobile (board 20).** The same rows regroup by status — waiting → running → interrupted
  → others (`STATUS_GROUP_ORDER`) — with the agent name pinned to the row, a text badge so
  status never relies on colour alone, and a touch target ≥ 44px (`min-h-11`). The follow
  toggle is not on the mobile row; it lives on the detail page's top bar. On desktop it
  sits on group rows only — never in the recent section.

### Decisions

| Decision | What the code does | Why |
| --- | --- | --- |
| Desktop two-line rows vs mobile status grouping | Same sessions, two layouts: desktop shows flat recents + two-line rows grouped by agent; mobile regroups by status (waiting pinned to the top) and pins the agent name to the row | The board's "优化" (`p5Orc`) fixes the two-line row for desktop; a phone keeps one dimension per row, so status becomes the grouping axis |
| Honest empty states | `—` in tiles and data-less cards; a missing source renders the real layout, never a fabricated number | A made-up number reads as a product promise that has to be un-made later |
| Never fake a backend | Only actions with a real endpoint exist: allow/deny/reply on the overview, revoke on devices, unfollow/remove on the list — **no rename, no delete, no fake success** | A button that claims success it cannot deliver is worse than no button |
| Sidebar is its own token | `--sidebar` (light #f4f4f5 = `--secondary`'s light, dark #111316 = `--code-surface`'s dark) | The board draws the nav in `chrome`; splitting it lets the nav and the code surfaces diverge independently |
| Shell data is best-effort | Badge, Meta, Account and the TopBar Fresh/Cnt render only when their source resolves | The shell must not block the page on a number it cannot get |

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
