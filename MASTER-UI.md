# BATTLEX MASTER UI SYSTEM

The Battlex UI is one product. Every page shares one shell, one token set, and one
component vocabulary. **Before building any new UI, read this file and reuse what
exists.** Do not invent a second visual system.

---

## 1. Token layers (single source of truth)

Three layers, all defined once and consumed by every page:

| Layer | File | Purpose |
|---|---|---|
| Primitives | `assets/tokens.json` → `assets/tokens.css` (generated) | raw values: colors, fonts, radii, durations, spacing |
| Semantic | same files, `--tm-*` aliases | `--tm-bg`, `--tm-card`, `--tm-text`, `--tm-muted`, `--tm-dim`, `--tm-accent`, `--tm-green`, `--tm-red`, `--tm-amber`, `--tm-border`, `--tm-border-2` |
| Component | `assets/trademind-theme.css` | `.btn-*`, `.tag-*`, `.modal`, `.drawer`, `.tbl`, glass + hairline tokens |

**Rules**
- Never hardcode hex/rgba colors in page markup — use `text-[var(--tm-*)]`, `bg-[var(--tm-*)]`, `border-[var(--tm-border)]`, or the Tailwind mappings (`text-tm-muted`, `bg-tm-card`, `border-tm-line`, `font-tm-mono`) from `assets/tailwind-config.js`.
- `--hairline` and the `--glass-*` set are canonical in `assets/trademind-theme.css` — do not redefine them per page.
- Semantic colors: green = positive/profit/complete, red = loss/violation/danger, amber = warning, indigo/purple = Battlex accent + active states.

## 2. Typography

- Sans: `Plus Jakarta Sans` (`var(--tm-sans)`). Mono for all trading numbers: `JetBrains Mono` (`var(--tm-mono)`), `font-variant-numeric: tabular-nums`.
- Page title: `text-[24px] font-bold tracking-tight`.
- Page subtitle: `text-[13px] text-[var(--tm-dim)] mt-0.5`.
- Section labels / eyebrow: `label-xs` (11px, uppercase, letter-spaced, muted).
- Metadata: 11–13px, `--tm-muted` / `--tm-dim`. Table headers: `tbl th` (10.5px uppercase).
- KPI values: 28–36px mono. Normal metrics: 18–24px mono.

## 3. Shell

```
┌────────────────────────────────────────────┐
│ GLOBAL TOPBAR (sticky)                      │
├──────────────┬─────────────────────────────┤
│ SIDEBAR      │  PAGE CONTENT (scrolls)     │
└──────────────┴─────────────────────────────┘
```

- Content wrapper: `<main class="flex-1 overflow-y-auto"><div class="max-w-[1440px] mx-auto p-5 lg:p-6 flex flex-col gap-4">`.
- Sidebar: fixed left nav; all 19 nav items in the exact order used by every page (Dashboard · Journal · Review · Improve · Insights · Analytics · AI Mentor · Backtesting · Strategy Lab · Market Replay · Battles · Risk · Discipline · Calendar · Community · Reports · Notifications · Settings · Help). Active page = `nav-item active`.
- Topbar: search (`#global-search`), theme toggle, backend/broker status chips, **Log Trade** (shared `btn-primary` opening the one global modal), account selector (`#acc-chip`). Two secondary `session-chip` pills auto-hide below 1280px.
- Responsive: sidebar collapses to a 64px icon rail at `≤1024px`; the search input hides at `≤640px`. Use these two breakpoints (plus Tailwind `sm/md/lg/xl`) — nothing else.
- Sidebar profile footer: `#profile-name` (account name) + `#profile-meta` (account_type, populated by `assets/profile-meta.js`). Never render fake plan/tier labels.

## 4. Spacing, radius, shadows

- Spacing scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 (Tailwind `p-*`/`gap-*` on this base). Card padding 20–24px, section gap 16–24px, control gap 8–12px.
- Radius: controls 6–10px, cards 12–16px, large containers 16px, pills `rounded-full`.
- Shadows: `shadow-sm`/`shadow-md` on cards; `--modal-shadow` for modals; `--glass-shadow` for glass surfaces. No permanent heavy shadows.

## 5. Components (reuse, don't restyle)

| Component | Class(es) |
|---|---|
| Primary button | `btn-primary` (+ `!py-2 !px-3.5` when compact) |
| Secondary / ghost / danger | `btn-secondary`, `btn-ghost`, `btn-danger` |
| Tabs / filters | `ins-tab`, `seg`, `pill`, `period-chip`, `view-chip` (active = `.active`) |
| Status badges | `tag` + `tag-emerald` / `tag-red` / `tag-amber` / `tag-blue` / `tag-purple` / `tag-gray` |
| Cards / panels | `panel`, `glass` / `glass-strong` (glass only for hero surfaces), KPI = `label-xs` + `kpi-value num` |
| Tables | `tbl-wrap` (must include `overflow-x: auto`) + `table.tbl` |
| Inputs | `search-input`, `field-input`, `finput`, `fselect` (focus ring automatic) |
| Modal | `.modal-overlay` + `.modal` / `modal-panel` (16px radius, blurred backdrop) |
| Drawer | `width: min(560px, 94vw)` right panel, `translateX(100%)` → `.open` |
| Toast | `.toast` |
| Empty / loading / error | explain what's missing + one clear action; skeletons for big surfaces; never raw server errors |
| Icons | Lucide only (`data-lucide`), 16–20px |

## 6. Page header pattern

```html
<div class="flex flex-wrap items-end justify-between gap-4">
  <div>
    <h1 class="text-[24px] font-bold tracking-tight">Page Title</h1>
    <p class="text-[13px] text-[var(--tm-dim)] mt-0.5">Short honest subtitle.</p>
  </div>
  <div class="flex items-center gap-2.5">
    <a class="btn-ghost">Secondary</a>
    <button class="btn-primary">Primary</button>
  </div>
</div>
```

## 7. Hard rules

1. One source of truth per data domain (core engine / ConfigAPI / battle API / practice APIs) — never compute a second formula in the frontend.
2. No fake data, no fake states: no mock traders/battles/scores/AI findings, no fake subscription tiers, no invented metrics.
3. No new fonts, primary colors, gradients, radii, or spacing systems — extend `tokens.json` if a real gap exists, then regenerate `tokens.css`.
4. Trading numbers use mono + tabular numerals; right-align numeric columns.
5. Dark mode is the primary experience; light mode flips only the semantic tokens (`html[data-theme="light"]`).
6. Charts (TradingView dependency) get visual priority; keep the chart surface clean — no decorative cards over it.
7. Every screen answers: what am I looking at → what matters → what changed → what should I do.

## 8. Verification checklist (before shipping a page)

Desktop + tablet + mobile · dark + light · hover/focus/disabled · loading/empty/error ·
no horizontal overflow (content `max-w-[1440px]`, tables in `overflow-x-auto`) ·
no clipped topbar (account selector visible) · all links real routes · real backend data only.
