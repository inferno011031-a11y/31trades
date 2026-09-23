# BattleX Journal & AI Agent Workspace Rules

---

## ⛔ CRITICAL NON-NEGOTIABLE RULES — READ BEFORE EVERY ACTION

### Rule A: Never Validate Data-Driven UI on Localhost Before Pushing
The user's **production account has 0 real trades**. Gemini's localhost may have fake/seed data.

**DO NOT** approve or push any UI change based on how it looks on localhost if it requires trade data to render (bars, charts, tables).

- ✅ **CSS / styling changes** — always safe to push
- ❌ **Data-driven elements** (bars, charts, tables) — MUST verify an empty-state exists (graceful `—` or "No trades yet" message) BEFORE pushing
- 🚫 **NEVER say "it works"** based on localhost visual testing with fake data
- ✅ **Always tell the user**: "This will show when you add trades. With 0 trades, you'll see [empty state]."

> Full rule documented in: `31trades/rules/SOLUTIONS_PLAYBOOK.md` → Rule #6

---

## 🎯 Active Skills & Capabilities

### 1. UI & Design System: shadcn/ui
The official **shadcn/ui** skill is installed in `.agents/skills/shadcn/` and `~/.gemini/config/skills/shadcn/`.

- **Scope**: Manages shadcn components, registries, CLI operations (`npx shadcn@latest`), Tailwind styling rules, form accessibility (`FieldGroup`, `Field`), dialog/drawer accessibility, and component composition patterns.
- **Triggers**: Anytime the user asks to add UI components, run `shadcn` commands, create React/Tailwind layouts, compose dialogs/forms, or customize themes.
- **Key Rules**:
  - Use `className` for layout (gap, flex, grid), not overriding internal semantic colors.
  - No `space-x-*` / `space-y-*` — use `flex` with `gap-*`.
  - Use semantic color tokens (`bg-background`, `text-muted-foreground`, `text-primary`).
  - Always compose Cards with `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, and `CardFooter`.
  - Always provide accessible Titles on `DialogTitle`, `SheetTitle`, and `DrawerTitle`.

---

### 2. SEO & GEO Intelligence Suite: SEO Skills AI + Agentic-SEO
The **SEO Skills AI** suite (27 sub-skills, 18 specialist agents, 130+ scripts) is installed in `.agents/skills/` and `~/.gemini/config/skills/`.

#### Available Activation Commands

| Command | Location | Description |
| :--- | :--- | :--- |
| `/ui add <component>` | `.agents/skills/shadcn/SKILL.md` | Add/compose shadcn/ui components |
| `/ui init` | `.agents/skills/shadcn/SKILL.md` | Initialize shadcn project configuration |
| `/seo audit <url>` | `.agents/skills/seo-audit/SKILL.md` | Full Technical, Content, Schema, GEO, and Backlink audit with 0–100 Health Score. |
| `/seo github <repo_or_url>` | `.agents/skills/agentic-seo/resources/skills/seo-github.md` | **GitHub Repo SEO**: Discoverability, README linter, Topics, Community health, and Traffic archival. |
| `/seo aeo <url>` | `.agents/skills/agentic-seo/resources/skills/seo-aeo.md` | **Answer Engine Optimization**: Featured snippets, PAA (People Also Ask), Knowledge Graph readiness. |
| `/seo article <url>` | `.agents/skills/agentic-seo/resources/skills/seo-article.md` | **Article & Blog SEO**: Content extraction, readability, NLP entity optimization. |
| `/seo links <url>` | `.agents/skills/agentic-seo/resources/skills/seo-links.md` | **Link Profile & Health**: Internal anchor text audit, broken links, link decay detection. |
| `/seo page <url>` | `.agents/skills/agentic-seo/resources/skills/seo-page.md` | Deep single-page on-page SEO diagnostic and remediation plan. |
| `/seo technical <url>` | `.agents/skills/seo-technical/SKILL.md` | Core Web Vitals, Crawl Budget, Canonicalization, Indexing status, Security headers. |
| `/seo content <url>` | `.agents/skills/seo-content/SKILL.md` | E-E-A-T analysis, Information Gain scoring, Topical depth & entity coverage. |
| `/seo schema <url>` | `.agents/skills/seo-schema/SKILL.md` | JSON-LD schema extraction & validation (`Organization`, `Article`, `Product`, `FAQPage`, `BreadcrumbList`). |
| `/seo llms-txt <url>` | `.agents/skills/seo-llms-txt/SKILL.md` | Generate & validate `/llms.txt` and `/llms-full.txt` files for AI crawlers (Perplexity, GPTBot, Claude). |
| `/seo robots-ai <url>` | `.agents/skills/seo-robots-ai/SKILL.md` | AI search bot permissions (`robots.txt`), header tags (`X-Robots-Tag`), and crawler governance. |
| `/seo geo <url>` | `.agents/skills/seo-geo/SKILL.md` | Generative Engine Optimization (Perplexity, ChatGPT Search, Gemini grounding). |
| `/seo doctor` | `.agents/scripts/doctor.py` | Run diagnostic check on SEO environment, Python runtime, and browser tools. |

---

### 3. UI/UX Design Intelligence: UI UX Pro Max
The **UI UX Pro Max** skill (79 UI styles, 192 product palettes & reasoning rules, 74 font pairings, 119 UX guidelines, 25 chart types) is installed in `.agents/skills/ui-ux-pro-max/`.

#### Available Activation Commands

| Command | Location | Description |
| :--- | :--- | :--- |
| `python .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --design-system` | `.agents/skills/ui-ux-pro-max/SKILL.md` | Generate complete product design system (colors, typography, effects, anti-patterns). |
| `python .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain <domain>` | `.agents/skills/ui-ux-pro-max/SKILL.md` | Search specific domain: `style`, `color`, `typography`, `chart`, `ux`, `icons`, `landing`. |
| `python .agents/skills/ui-ux-pro-max/scripts/search.py "<query>" --stack html-tailwind` | `.agents/skills/ui-ux-pro-max/SKILL.md` | Framework-specific UI implementation patterns and anti-patterns. |

---

### 4. Self-Healing & Problem Solutions Playbook
The **Problem & Solution Playbook** is permanently maintained in `31trades/rules/SOLUTIONS_PLAYBOOK.md` and `.agents/knowledge/problem_solutions_playbook.md`.

- **Scope**: Contains known problems, root causes, automatic solutions, and mandatory testing rules (e.g., Uncompiled Tailwind arbitrary border opacity "White Lines" bug, Dynamic Backend Calculation rule, IIFE scope protection, and Git auto-push protocol).
- **Mandatory Agent Check**: Before committing or proposing changes to the user, the agent MUST run `npm test` (which executes `server/ui-lint.test.js`) to guarantee that no uncompiled white border lines or broken backend integrations exist.

---

## ⚡ Execution Protocol
1. For UI/component and design intelligence requests: use `.agents/skills/ui-ux-pro-max/SKILL.md` and `.agents/skills/shadcn/SKILL.md` to enforce composition, accessibility, and high-density fintech ergonomics.
2. For SEO requests: load corresponding skill in `.agents/skills/<skill>/SKILL.md` and execute diagnostics.
3. Automatically consult `31trades/rules/SOLUTIONS_PLAYBOOK.md` and run `npm test` before pushing to GitHub.


