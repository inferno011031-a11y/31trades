# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** 31Trades
**Generated:** 2026-08-15 18:08:11
**Category:** Financial Dashboard
**Design Dials:** Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

| Role | Hex | CSS Variable |
|------|-----|--------------|
| Background | `#0a0c10` | `--tm-bg` |
| Elevated bg | `#0d1016` | `--tm-bg-elev` |
| Card | `#121620` | `--tm-card` |
| Card nested | `#161b26` | `--tm-card-2` |
| Hover | `#181e2c` | `--tm-hover` |
| Border | `rgba(255,255,255,0.06)` | `--tm-border` |
| Border strong | `rgba(255,255,255,0.10)` | `--tm-border-2` |
| Text | `#f1f5f9` | `--tm-text` |
| Muted | `#94a3b8` | `--tm-muted` |
| Dim | `#64748b` | `--tm-dim` |
| Accent | `#818cf8` / `#6366f1` | `--tm-accent` / `--tm-accent-2` |
| Positive | `#34d399` | `--tm-green` |
| Negative | `#f87171` | `--tm-red` |
| Warning | `#fbbf24` | `--tm-amber` |
| Info | `#60a5fa` | `--tm-blue` |

**Color Notes:** Layered obsidian surfaces (dark OLED), indigo accent + emerald positive, ultra-thin translucent borders. Defined in `assets/trademind-theme.css` — the single source of truth loaded last on every page.

### Typography

- **Body Font:** Plus Jakarta Sans (`--tm-sans`)
- **Numbers Font:** JetBrains Mono (`--tm-mono`) — ALL financial numbers, P&L figures, pip/point counts, account metrics use monospaced tabular numerals for crisp vertical alignment
- **Mood:** dark, cinematic, technical, precision, clean, premium, developer, professional, high-end utility
- **Weight scale:** 300–700; labels muted (`--tm-muted`), primary data white (`--tm-text`)

### Spacing Variables

*Density: 8/10 — Dense / Dashboard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `2px` / `0.125rem` | Tight gaps |
| `--space-sm` | `4px` / `0.25rem` | Icon gaps, inline spacing |
| `--space-md` | `8px` / `0.5rem` | Standard padding |
| `--space-lg` | `12px` / `0.75rem` | Section padding |
| `--space-xl` | `16px` / `1rem` | Large gaps |
| `--space-2xl` | `24px` / `1.5rem` | Section margins |
| `--space-3xl` | `32px` / `2rem` | Hero padding |

### Shadow Depths

| Level | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle lift |
| `--shadow-md` | `0 4px 6px rgba(0,0,0,0.1)` | Cards, buttons |
| `--shadow-lg` | `0 10px 15px rgba(0,0,0,0.1)` | Modals, dropdowns |
| `--shadow-xl` | `0 20px 25px rgba(0,0,0,0.15)` | Hero images, featured cards |

---

## Component Specs

### Buttons (theme: `assets/trademind-theme.css`)

```css
.btn-primary {
  background: linear-gradient(135deg, var(--tm-accent-2), #4f46e5);
  color: #fff;
  border: 1px solid rgba(129, 140, 248, 0.35);
  box-shadow: 0 0 22px rgba(99, 102, 241, 0.30), inset 0 1px 0 rgba(255,255,255,0.15);
  transition: box-shadow 0.2s ease, transform 0.15s ease, filter 0.15s ease;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
.btn-secondary { background: var(--tm-card-2); color: var(--tm-text); border: 1px solid var(--tm-border-2); }
.btn-ghost    { background: rgba(255,255,255,0.03); color: var(--tm-muted); border: 1px solid var(--tm-border); }
.btn-danger   { background: rgba(248,113,113,0.10); color: var(--tm-red); border: 1px solid rgba(248,113,113,0.25); }
```

### Cards / Panels

```css
.panel, .metric-mini, .fcard, .glass-card, .opt-card, .cal-cell, .cal-day {
  background: var(--tm-card);
  border: 1px solid var(--tm-border);
  border-radius: 12–16px;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.panel:hover, .cal-day:hover { background: var(--tm-hover); border-color: var(--tm-border-2); }
.cal-day:hover { transform: translateY(-1px); }  /* no layout shift */
```

### Inputs

```css
input, select, textarea, .search-input, .field-input, .finput, .fselect {
  background: var(--tm-bg);
  border: 1px solid var(--tm-border-2);
  color: var(--tm-text);
  border-radius: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
input:focus, select:focus, textarea:focus {
  border-color: rgba(129, 140, 248, 0.55);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
  outline: none;
}
```

### Modals / Drawers

```css
.modal-overlay {
  background: rgba(0, 0, 0, 0.70);
  backdrop-filter: blur(6px);
}
.modal, .modal-box {
  background: var(--tm-card);
  border: 1px solid var(--tm-border-2);
  border-radius: 16px;
  box-shadow: 0 24px 60px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
}
.drawer { background: var(--tm-bg-elev); border-left: 1px solid var(--tm-border-2); }
```

---

## Style Guidelines

**Style:** Dark Mode (OLED)

**Keywords:** Dark theme, low light, high contrast, deep black, midnight blue, eye-friendly, OLED, night mode, power efficient

**Best For:** Night-mode apps, coding platforms, entertainment, eye-strain prevention, OLED devices, low-light

**Key Effects:** Minimal glow (text-shadow: 0 0 10px), dark-to-light transitions, low white emission, high readability, visible focus

### Page Pattern

**Pattern Name:** Real-Time / Operations Landing

- **Conversion Strategy:** For ops/security/iot products. Demo or sandbox link. Trust signals.
- **CTA Placement:** Primary CTA in nav + After metrics
- **Section Order:** 1. Hero (product + live preview or status), 2. Key metrics/indicators, 3. How it works, 4. CTA (Start trial / Contact)

---

## Anti-Patterns (Do NOT Use)

- ❌ Light mode default
- ❌ Slow rendering

### Additional Forbidden Patterns

- ❌ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ❌ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ❌ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ❌ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ❌ **Instant state changes** — Always use transitions (150-300ms)
- ❌ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Light mode: text contrast 4.5:1 minimum
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
