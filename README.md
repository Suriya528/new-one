# Profit What-If Simulator — Philips CFO Challenge

An interactive, deterministic financial decision-support application built for the Philips 2026 Hackathon. A CFO adjusts strategic business levers and immediately sees full-year P&L impacts, monthly trajectories, bank covenant compliance, net-profit waterfall drivers, and plain-language causal explanations—all computed deterministically from `company-data.json` via SQLite and a pure TypeScript engine.

---

## Architecture

```text
  repo-data/.../company-data.json
                 │
         (npm run seed)  ── SQL Migrations (001_initial_schema.sql)
                 ▼
       [SQLite: simulator.db]
        ├─ kpi_definitions / kpi_dependencies / monthly_actuals
        ├─ scenario_rules / guardrails
        └─ scenarios / scenario_results
                 ▲
                 │ (better-sqlite3 queries)
                 ▼
       [Express REST API :4000] ──▶ [Pure-TS KpiEngine] (zero DB/HTTP imports)
        ├─ GET  /api/meta                (DAG topo-sort, lag, elasticity,
        ├─ GET  /api/kpis                 half-up rounding, clamps, YTD tax,
        ├─ POST /api/simulate             FY rules, guardrails, waterfall)
        └─ CRUD /api/scenarios
                 ▲
                 │ (HTTP JSON via Vite proxy)
                 ▼
     [React + TypeScript UI :5173]
      ├─ Lever Sliders & Presets      ├─ Guardrail Covenant Banner & Panel
      ├─ 6 Executive KPI Cards        ├─ "Why Did This Change?" Causal Trace
      ├─ P&L, Subscribers & Waterfall ├─ Side-by-Side Compare (up to 3)
      └─ 27-KPI Audit Table w/ Formula Hover & 12-Month Drilldown
```

---

## One-Command Setup

Prerequisites: **Node.js >= 20** (`node --version`)

```bash
npm install && npm run seed && npm run dev
```

- **Frontend Dashboard**: http://localhost:5173
- **Backend API**: http://localhost:4000/api/health

---

## Verification, Tests & Showcase SQL Query

| Command | Purpose |
|---|---|
| `npm run seed` | Drops & recreates SQLite schema via SQL migrations and loads `company-data.json` idempotently (prints SHA-256 checksum). |
| `npm test` | Runs Vitest suite (`engine.test.ts`, `api.test.ts`, `hardening.test.ts`): golden gates, per-lever `+10%/-10%`, `-100%/+100%/+500%` extremes, 200-scenario reference cross-check, and API validation tests. |
| `npx --prefix backend tsx tests/reference-model.ts` | Runs the independent naive reference implementation against `KpiEngine` across 200 random lever combinations and prints max differences across revenue, expenses, net profit, and subscribers. |
| `npm run query` | Executes the showcase SQL query ([docs/query.sql](docs/query.sql)) displaying all 27 KPIs with dependency edges, lags, elasticities, FY rules, and guardrails. |
| `npm run verify` | Evaluates all 10 scenarios in [scenarios.json](scenarios.json) (or pass custom JSON: `npm --prefix backend run verify -- path/to/file.json`) and prints a results table. |
| `npm run build` | Type-checks and builds both `backend` (`tsc`) and `frontend` (`tsc -b && vite build`). |

---

## Documentation

- [docs/data-analysis.md](docs/data-analysis.md) — Complete breakdown of all 27 KPIs, `op` types, `fy` rules, DAG, rule execution order, and guardrails.
- [docs/assumptions.md](docs/assumptions.md) — One-page log of specification ambiguities and modeling choices.
- [docs/query.sql](docs/query.sql) — Showcase SQLite query joining KPI definitions, dependency graph, actuals, and bank guardrails.
