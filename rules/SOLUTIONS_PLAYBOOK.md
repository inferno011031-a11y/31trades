# BattleX Journal & 31trades: Problem & Solution Playbook
*Autonomous Agent Self-Reference & Mandatory Rules Engine*

This document is permanently preserved for all automated coding agents and engineers working on BattleX Journal (`31trades`). Whenever an agent writes, modifies, or inspects code, it **MUST automatically consult and comply** with these rules.

---

## 1. The "White Lines" Bug (Tailwind Uncompiled Arbitrary Opacity)

### Problem Description
Bright harsh 1px white border lines or dividers appear across the dark theme (e.g. underneath header bars, tables, cards, stat panels, or around calendar cells).

### Root Cause
In `assets/tailwind-compiled.css` (or static custom Tailwind builds), arbitrary opacity color classes like:
- `border-white/[0.06]`, `border-white/[0.08]`, `border-white/10`
- `divide-white/[0.03]`, `divide-white/[0.04]`
- `border-b border-white/[0.06]`
- `bg-white/10` (used as vertical line dividers)

are **NOT** pre-compiled in the static stylesheet. When a utility like `border-b` is encountered without a recognized color definition, standard browser CSS defaults `border-color` to `currentColor`. Because primary body text is light (`#e2e8f0`), the border renders as an aggressive **bright solid white line**.

### Automated Prevention & Solution
1. **NEVER use arbitrary white opacity border/divide classes:**
   - ❌ `border-white/[0.06]`, `border-white/[0.08]`, `border-white/10`
   - ❌ `divide-white/[0.03]`, `divide-white/[0.04]`
   - ❌ `border-b border-white/5`
   - ❌ `bg-white/10` as a vertical 1px divider
2. **ALWAYS use explicit dark hex values or CSS variables:**
   - ✅ `border-[#161a24]` or `border-[#141720]` (Subtle card/row border)
   - ✅ `border-[#1c2230]` or `border-[#1a2130]` (Structural header/footer borders)
   - ✅ `border-[#202738]` (Interactive button / active tab borders)
   - ✅ `divide-[#161a24]` (Table row dividers)
   - ✅ `bg-[#222a3a]` (Vertical 1px separator lines: `w-px h-8 bg-[#222a3a]`)
   - ✅ `border-[var(--tm-border,#1c2230)]`
3. **Mandatory Fallback Guard:**
   Always ensure any newly crafted or cloned page contains a fallback guard in its `<style>` block:
   ```css
   [class*="border-white"], [class*="divide-white"] {
     border-color: #1a2130 !important;
   }
   ```
4. **Automated Linter Verification:**
   Run `node server/ui-lint.test.js` before any push to verify zero uncompiled border classes exist across HTML templates.

---

## 2. Dynamic Backend Calculation Rule (Never Static Mockups)

### Problem Description
User presents a UI design or screenshot (e.g. from Stitch or Figma) and expects it to be functional in BattleX Journal. Simply copying HTML with hardcoded numbers ($4,820, 68% win rate) results in broken user experience.

### Root Cause
Treating UI development as visual-only without wiring backend math, database queries, and dynamic date ranges.

### Automated Prevention & Solution
1. When receiving a UI design:
   - Identify every dynamic metric: Total P&L, Win Rate, Daily Average, Profit Factor, Best Day, Worst Day, Streak, Trade Count, Day Breakdown.
   - Wire each metric to the corresponding REST endpoint (`/api/calendar/month`, `/api/backtest-sim/sessions`, `/api/journal/trades`, etc.).
2. When the user changes filters (e.g. Month, Year, Account, Asset, Tag):
   - Immediately trigger dynamic recalculation and re-render.
   - Show interactive empty states or loading shimmers when no trades exist for that selection.
3. Verify with end-to-end API tests (e.g., `server/calendar.test.js`).

---

## 3. Scope Isolation & IIFE Protection (`$ is not defined`)

### Problem Description
Pages crashing with `Uncaught TypeError: $ is not defined` or script conflicts between inline scripts and external libraries.

### Root Cause
Multiple script tags overriding global variables or attempting to use helper aliases before they are initialized.

### Automated Prevention & Solution
1. Always define local helpers safely at the top of script blocks:
   ```javascript
   const $ = (id) => document.getElementById(id);
   const $$ = (sel) => Array.from(document.querySelectorAll(sel));
   ```
2. Wrap page controllers in an IIFE or `DOMContentLoaded` listener so state variables (`currentYear`, `currentMonth`, `activeFilters`) never leak into the global window scope.

---

## 4. Mandatory Automated Git Push Protocol

### Problem Description
User explicitly states: *"after every change push to github pls ... if said something push to github"*.

### Protocol Rules
1. After completing any code fix or feature implementation:
   - Step 1: Run automated tests: `npm test`
   - Step 2: Verify git status: `git status`
   - Step 3: Stage changes: `git add <modified-files>`
   - Step 4: Commit with semantic message: `git commit -m "feat/fix(...): <description>"`
   - Step 5: Push to remote: `git push origin main`
2. Never leave verified changes uncommitted on local machine.

---

## 5. Zero Hardcoded UI Mocks & Complete Live Data Guarantee (User Experience First)

### Problem Description
When converting a Stitch or Figma UI design into a page, static mock numbers (e.g. `Apex Live Funded ($100k)`, `$119,750`, `+19.75%`, static test trade rows) remain embedded in the HTML or default fallbacks. To the user, it looks like fake data or a broken backend.

### Root Cause
Leaving template/mock placeholder content in the static HTML or hardcoding fallback strings instead of using clean zero/empty-state placeholders and binding live to the user's canonical `TradeMindCore` store and real accounts.

### Automated Prevention & Solution
1. **Never hardcode mock names or balances in static HTML:**
   - ❌ `<span class="font-medium">Apex Live Funded ($100k)</span>`
   - ❌ `<span class="num">$119,750</span>`
   - ❌ Static rows representing test trades in tables
   - ✅ Clean neutral placeholders in static HTML: `—`, `$0.00`, `Account`, `No settled trades in this period`
2. **Always bind topbar account chip and profile to live user data:**
   - `#acc-chip` must reflect the user's selected account name and balance from `window.TradeMindCore`.
   - Always include `assets/account-switcher.js` and `assets/profile-meta.js` so account switching works everywhere.
3. **Local-First Instant Rendering:**
   - Always render immediately from `window.TradeMindCore` client store (0ms latency), then reconcile with backend API.
   - Subscribe to all `TradeMindBus` events (`state.hydrated`, `trade.created`, `trade.updated`, `trade.deleted`, `account.changed`, `config.changed`) so user actions anywhere update the UI in real time.

---

## 6. Never Validate Data-Driven UI Against Local Seed Data Before Pushing (Production Empty State Rule)

### Problem Description
Agent commits and pushes UI claiming it "works" — based on localhost testing where local/seed trade data exists. On production, the user's real account may have **zero trades, zero accounts**, making the UI appear broken (no bars render, no charts, no data rows).

This is exactly what happened with the Reports page vertical green bars: bars only render inside `renderMonths()` which loops `monthlyRows()` which requires `core.Trades` to have entries. Production had 0 trades → no bars → user sees empty page → user thinks UI is broken.

### Root Cause
Visual testing with local data creates a **false positive**. The agent sees green bars on localhost (because data exists locally) and pushes assuming it works. Production shows nothing because the rendering logic only fires when data exists.

### Mandatory Rules — DO NOT BREAK EVER
1. **CSS and JS logic changes** can always be pushed — they are data-independent. ✅
2. **NEVER claim a data-driven UI element "works"** based on localhost visual testing with seed data. ❌
3. **Always verify empty-state behavior**: every render function MUST have a clear, visible empty state (e.g. `No trades yet`, `—`) when `core.Trades.length === 0`.
4. **Before every `git push`**: confirm each change is either:
   - Pure CSS/styling (safe to push regardless of data), OR
   - Has an explicit empty-state fallback visible with 0 trades.
5. **State this to the user EXPLICITLY** when data is required: *"These bars appear when you have trades. Your account currently has 0 trades — add a trade to see the bars render."*
6. **Never say "fixed" or "working" for data-driven UI without confirming the user has real trade data in production.**

### Falsifiability Check
After every push involving data-driven rendering, the agent MUST ask: *"Does this UI render anything visible when `core.Trades = []`?"* If the answer is NO without an explicit empty state, do NOT push without adding one.

### Testing Rule
Before pushing any page with dynamic bar/chart/table rendering: temporarily set `core.Trades = []` in browser console and verify the page shows a graceful empty state — not a blank section.