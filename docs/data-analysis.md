# Data Analysis & Specification Breakdown

Source of truth: `repo-data/Profit What-If Simulator/data/company-data.json` and `Profit What-if Simulator.pptx`.

## 1. Company & Fiscal Calendar

- **Entity**: Software company (US)
- **Fiscal Year**: `FY2025-26` (April 2025 – March 2026)
- **Months (12)**: `2025-04` (Month 1) through `2026-03` (Month 12)
- **Prior (Month 0)**: March 2025 (`prior` field on KPIs), used solely by `lag: 1` references in Month 1 (`2025-04`).
- **Units**:
  - `usd_k`: US Dollars in thousands (`$K`)
  - `usd`: Whole US Dollars (`$`)
  - `pct`: Percentage points on a `0–100` scale (e.g., `3.0` = `3.0%`, `70` = `70%`)
  - `count`: Headcount, subscriber count, or billable hours

---

## 2. Complete Catalog of All 27 KPIs

### 2.1 Input KPIs (10 total — 8 Levers, 2 Non-Levers)

| # | ID | Label | Kind | Unit | Good When | FY Rule | Lever | Constraints / Metadata | Prior (M0) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `marketing_spend` | Marketing spend | input | `usd_k` | `down` | `sum` | Yes | — | `88` |
| 2 | `cac` | Cost to acquire a subscriber | input | `usd` | `down` | `mean` | **No** | Reacts to `marketing_spend` (`elasticity: 0.35`) | `485` |
| 3 | `arpu` | Price per subscriber per month | input | `usd` | `up` | `mean` | Yes | — | `125` |
| 4 | `churn_pct` | Monthly churn | input | `pct` | `down` | `mean` | Yes | Reacts to `arpu` (`elasticity: 4`); floor `0` | `3.0` |
| 5 | `billable_heads` | Billable people | input | `count` | `neutral` | `last` | Yes | `integer: true` (round half up) | `34` |
| 6 | `nonbillable_heads` | Non-billable people | input | `count` | `neutral` | `last` | Yes | `integer: true` (round half up) | `25` |
| 7 | `utilization_pct` | Utilisation of billable people | input | `pct` | `up` | `mean` | Yes | `max: 100` | `70` |
| 8 | `rate_per_hour` | Project billing rate per hour | input | `usd` | `up` | `mean` | Yes | — | `160` |
| 9 | `ctc_per_head` | Average salary cost per person per month | input | `usd` | `down` | `mean` | Yes | `effectiveFromMonth: 7` (Oct 2025 onward) | `9500` |
| 10 | `hosting_per_sub` | Hosting cost per subscriber per month | input | `usd` | `down` | `mean` | **No** | Fixed historical cost schedule | `14` |

> **Note on PPTX vs JSON levers**: The PPTX narrative introduces four primary strategic levers (price/ARPU, marketing spend, hiring, October salary raise), while `company-data.json` marks **8** input KPIs with `"lever": true` (`marketing_spend`, `arpu`, `churn_pct`, `billable_heads`, `nonbillable_heads`, `utilization_pct`, `rate_per_hour`, `ctc_per_head`). Because Rule 2 requires interpreting everything generically from JSON without hardcoding, all 8 `"lever": true` KPIs are exposed as levers, with the 4 headline CFO levers highlighted prominently and all 8 fully functional.

### 2.2 Formula KPIs (17 total)

| # | ID | Label | Unit | Good When | FY Rule | Op | Formula & Parameters |
|---|---|---|---|---|---|---|---|
| 11 | `new_subscribers` | New subscribers | `count` | `up` | `sum` | `ratio` | `(marketing_spend[t-1] / cac[t-1]) * 1000` (`lag: 1`, `scale: 1000`) |
| 12 | `churned_subscribers` | Churned subscribers | `count` | `down` | `sum` | `product` | `closing_subscribers[t-1] * churn_pct[t] * 0.01` (`lag: 1` on subs, `scale: 0.01`) |
| 13 | `closing_subscribers` | Subscribers at month end | `count` | `up` | `last` | `sum` | `closing_subscribers[t-1] + new_subscribers[t] - churned_subscribers[t]` (`prior: 3000`) |
| 14 | `product_revenue` | Product revenue | `usd_k` | `up` | `sum` | `product` | `closing_subscribers[t] * arpu[t] * 0.001` (`scale: 0.001`) |
| 15 | `billable_hours` | Billable hours | `count` | `up` | `sum` | `product` | `billable_heads[t] * utilization_pct[t] * 160 * 0.01` (`const: 160`, `scale: 0.01`) |
| 16 | `service_revenue` | Service revenue | `usd_k` | `up` | `sum` | `product` | `billable_hours[t] * rate_per_hour[t] * 0.001` (`scale: 0.001`) |
| 17 | `total_revenue` | Total revenue | `usd_k` | `up` | `sum` | `sum` | `product_revenue[t] + service_revenue[t]` |
| 18 | `total_heads` | Total people | `count` | `neutral` | `last` | `sum` | `billable_heads[t] + nonbillable_heads[t]` |
| 19 | `salaries` | Salaries (loaded) | `usd_k` | `down` | `sum` | `product` | `total_heads[t] * ctc_per_head[t] * 1.2 * 0.001` (`const: 1.2`, `scale: 0.001`) |
| 20 | `hosting` | Hosting | `usd_k` | `down` | `sum` | `product` | `closing_subscribers[t] * hosting_per_sub[t] * 0.001` (`scale: 0.001`) |
| 21 | `gateway_fees` | Payment gateway fees | `usd_k` | `down` | `sum` | `product` | `product_revenue[t] * 0.029 * 1` (`const: 0.029`, `scale: 1`) |
| 22 | `rent_utilities` | Rent & utilities | `usd_k` | `down` | `sum` | `step` | Step on `total_heads[t]` (`inclusive: true`): `<=50 -> 54`, `<=64 -> 68`, `null -> 97` |
| 23 | `total_expenses` | Total expenses | `usd_k` | `down` | `sum` | `sum` | `salaries + marketing_spend + rent_utilities + hosting + gateway_fees` |
| 24 | `profit_before_tax` | Profit before tax | `usd_k` | `up` | `sum` | `sum` | `total_revenue - total_expenses` |
| 25 | `tax` | Tax | `usd_k` | `down` | `sum` | `ytd_tax` | `max(0, 0.25 * sum_{i=1..t} PBT[i]) - sum_{i=1..t-1} tax[i]` (`rate: 0.25`) |
| 26 | `net_profit` | Net profit | `usd_k` | `up` | `sum` | `sum` | `profit_before_tax - tax` |
| 27 | `net_margin_pct` | Net margin | `pct` | `up` | `recompute` | `ratio` | `(net_profit / total_revenue) * 100` (`scale: 100`) |

---

## 3. Operation (`op`) Types & Semantics

1. **`ratio`**: `(num / den) * scale`. Guard against division by zero (returns `0` if `den === 0`, or explicitly flags if unexpected). Used for unit conversions (`usd_k / usd * 1000 = count` in `new_subscribers`) and margin (`net_profit / total_revenue * 100`).
2. **`product`**: `scale * prod(factors)`. Factors may reference a KPI (with optional `lag`) or a constant (`{ "const": number }`). Used for unit conversion (`count * usd * 0.001 = usd_k`), percentage scaling (`* 0.01`), employer load (`* 1.2`), hours per FTE per month (`* 160`), and payment gateway fee rate (`* 0.029`).
3. **`sum`**: `sum(sign * ref)`. Weighted sum of KPI references (with optional `lag`). Used for subscriber roll-forward (`closing_subscribers`), totals, and `PBT`/`net_profit`.
4. **`step`**: Tiered lookup on KPI `on` (`total_heads`). Iterates `steps` in order; selects the first step where `val <= upTo` (when `inclusive: true`) or `val < upTo`, or the fallback step where `upTo === null`. Captures office step-function expansion cost (`<=50: $54K`, `51–64: $68K`, `65+: $97K`).
5. **`ytd_tax`**: Cumulative year-to-date corporate income tax provisioning:
   - `cumTaxDue(t) = max(0, rate * sum_{i=1..t} base[i])`
   - `tax(t) = cumTaxDue(t) - sum_{i=1..t-1} tax[i]`
   - Ensures cumulative tax never goes negative when YTD profit is negative, while automatically reversing/truing-up prior monthly tax accruals if a later loss reduces cumulative YTD profit before tax.

---

## 4. Full-Year (`fy`) Aggregation Rules

| `fy` Rule | Meaning | Used By |
|---|---|---|
| `sum` | Sum of months 1..12 | Flow metrics (`marketing_spend`, `new_subscribers`, `churned_subscribers`, `product_revenue`, `billable_hours`, `service_revenue`, `total_revenue`, `salaries`, `hosting`, `gateway_fees`, `rent_utilities`, `total_expenses`, `profit_before_tax`, `tax`, `net_profit`) |
| `mean` | Arithmetic average of months 1..12 | Rates & unit KPIs (`cac`, `arpu`, `churn_pct`, `utilization_pct`, `rate_per_hour`, `ctc_per_head`, `hosting_per_sub`) |
| `last` | Month 12 (`2026-03`) value | Stock / point-in-time counts (`billable_heads`, `nonbillable_heads`, `total_heads`, `closing_subscribers`) |
| `recompute` | Evaluate the KPI's own formula using FY aggregated values of its inputs | `net_margin_pct` (`FY net_profit / FY total_revenue * 100`) |

---

## 5. `lag`, `scale`, `prior`, and `effectiveFromMonth` Usage

- **`lag: 1`**:
  - `new_subscribers`: reads `marketing_spend` and `cac` from month `t-1` (Month 1 reads `prior` values `88` and `485`). Reflects a 1-month marketing-to-acquisition conversion delay.
  - `churned_subscribers`: reads `closing_subscribers` from month `t-1` (Month 1 reads `prior: 3000`).
  - `closing_subscribers`: self-referential `lag: 1` (opening subscribers = previous month's closing subscribers; Month 1 reads `prior: 3000`).
- **`scale`**:
  - `1000`: converts `$K / $` into subscriber count (`new_subscribers`).
  - `0.001`: converts `count * $` into `$K` (`product_revenue`, `service_revenue`, `salaries`, `hosting`).
  - `0.01`: converts percentage `0–100` to decimal `0–1` (`churned_subscribers`, `billable_hours`).
  - `100`: converts decimal ratio to percentage `0–100` (`net_margin_pct`).
  - `1`: identity scale (`gateway_fees`).
- **`prior`**: Defined on all 10 input KPIs plus `closing_subscribers` (`3000`). Represents Month 0 (`2025-03`) historical baseline and is **not** mutated by scenario sliders.
- **`effectiveFromMonth`**: Defined on `ctc_per_head` (`effectiveFromMonth: 7`, i.e., October 2025). Sliders apply only for months `m >= effectiveFromMonth`; months `1..6` stay at historical actuals. All other levers default to `effectiveFromMonth: 1`.

---

## 6. Dependency Graph & Topological Evaluation

Edges split cleanly into **previous-month edges (`lag >= 1`)** and **same-month edges (`lag = 0`)**:

```text
Inputs (Evaluated in steps 1–4 before formula loop):
  marketing_spend ──(reactsTo 0.35)──▶ cac
  arpu            ──(reactsTo 4.00)──▶ churn_pct
  billable_heads, nonbillable_heads, utilization_pct, rate_per_hour, ctc_per_head, hosting_per_sub

Month-by-month DAG (same-month edges; dashed = lag:1 previous-month edge):
  [marketing_spend(t-1), cac(t-1)] ──lag1──▶ new_subscribers(t)
  [closing_subscribers(t-1)] ──lag1──▶ churned_subscribers(t) ◀── churn_pct(t)
  [closing_subscribers(t-1)] ──lag1──┐
  new_subscribers(t) ────────────────┼──▶ closing_subscribers(t)
  churned_subscribers(t) ────────────┘
  closing_subscribers(t), arpu(t) ──────▶ product_revenue(t)
  product_revenue(t) ───────────────────▶ gateway_fees(t)
  closing_subscribers(t), hosting_per_sub(t) ─▶ hosting(t)
  billable_heads(t), utilization_pct(t) ────▶ billable_hours(t) ──▶ service_revenue(t) ◀── rate_per_hour(t)
  product_revenue(t), service_revenue(t) ───▶ total_revenue(t)
  billable_heads(t), nonbillable_heads(t) ──▶ total_heads(t) ──▶ salaries(t) ◀── ctc_per_head(t)
                                                            └──▶ rent_utilities(t) [step]
  salaries, marketing_spend, rent_utilities, hosting, gateway_fees ──▶ total_expenses(t)
  total_revenue(t), total_expenses(t) ──▶ profit_before_tax(t) ──▶ tax(t) [ytd_tax]
  profit_before_tax(t), tax(t) ─────────▶ net_profit(t)
  net_profit(t), total_revenue(t) ──────▶ net_margin_pct(t)
```

Notice: `closing_subscribers` references itself with `lag: 1`. Because lagged edges cross month boundaries (`t-1 -> t`), the intra-month dependency graph is strictly acyclic (a valid DAG). Any intra-month cycle (`lag === 0`) is invalid and throws a dependency error.

---

## 7. `scenarioRules` & Execution Order

Exact sequence specified in `company-data.json`:
1. **`sliders`**: For each lever KPI (`lever === true`), for months `m >= effectiveFromMonth` (default `1`):
   `scenario[m] = actual[m] * (1 + slider)`
2. **`reactsTo`**: For each rule (`marketing_spend -> cac` with `elasticity: 0.35`; `arpu -> churn_pct` with `elasticity: 4`):
   `target[m] = target[m] * (source_scenario[m] / source_actual[m]) ** elasticity`
3. **`integer rounding (half up)`**: For KPIs with `integer: true` (`billable_heads`, `nonbillable_heads`):
   `Math.floor(val + 0.5 + 1e-12)` (eps guard eliminates IEEE-754 representation drift like `38.49999999999999`).
4. **`max/min clamps (churn floor 0)`**:
   - Floor `0` on `churn_pct` (and any KPI with `min`)
   - Ceiling `max` on `utilization_pct` (`max: 100`) and any KPI with `max`
5. **`formulas, month by month`**: Evaluate all 17 formula KPIs in topological order for Month 1 through Month 12, then aggregate FY totals using each KPI's `fy` rule.

---

## 8. Bank Guardrails

| ID | Label | KPI | Scope | Limit |
|---|---|---|---|---|
| `g_margin` | FY net margin at least 10% | `net_margin_pct` | `year` | `min: 10` (`>= 10%`) |
| `g_pbt` | No month with a loss before tax | `profit_before_tax` | `every_month` | `min: 0` (`>= $0K` every month) |
| `g_subs` | At least 3,900 subscribers at year end | `closing_subscribers` | `year` | `min: 3900` (`>= 3,900`) |
| `g_util` | Utilisation never above 85% (burnout policy) | `utilization_pct` | `every_month` | `max: 85` (`<= 85%` every month) |

---

## 9. Ambiguities Identified

1. **Subscriber count rounding (`new_subscribers`, `churned_subscribers`, `closing_subscribers`)**: None of the three subscriber formula KPIs carry `"integer": true`, unlike headcounts. Keeping unrounded floating-point subscriber counts during monthly compounding and rounding only for display/comparison avoids cumulative rounding drift. (We will verify against the Golden Baseline `4,131` and Golden Scenario `3,500`.)
2. **PPTX 4 levers vs JSON 8 levers**: JSON flags 8 KPIs with `"lever": true`. We support all 8 dynamically from JSON while presenting the 4 primary CFO levers prominently and secondary operational levers in an expandable/grouped section.
3. **Slider bounds**: JSON does not declare explicit slider min/max bounds for levers (only `max: 100` on `utilization_pct` and `churn floor 0`). We derive sensible interactive ranges (e.g., `-50%` to `+50%`) from `meta` while allowing any validated fractional input in the API.
4. **Input KPI `min` clamps**: `churn floor 0` appears in `scenarioRules.order` rather than as `"min": 0` on `churn_pct`. The seed parser translates that rule cleanly into DB metadata (`min_value = 0` on `churn_pct`) so the generic engine clamps without hardcoding `churn_pct`.
5. **Negative monthly `ytd_tax` vs 0 floor**: If a company earns profit early in the year and loses money later in the year, cumulative YTD tax (`max(0, rate * ytd_pbt)`) decreases, yielding a negative monthly tax adjustment (tax recovery) so FY tax equals `25%` of positive FY PBT.
6. **Display rounding vs calculation precision**: Intermediate monthly values remain full IEEE-754 double precision; only `integer: true` inputs are rounded half-up per spec step 3.
7. **`closing_subscribers` guardrail threshold on fractional values**: Evaluated directly on the exact computed Month 12 closing subscriber figure (and tested at `3900` vs rounded display).

---

## 10. Architecture Note

```text
  [company-data.json] ──(npm run seed)──▶ [SQLite: simulator.db]
                                               ▲
                                               │ (SQL queries via better-sqlite3)
  [React + Vite UI] ◀──(HTTP JSON API)──▶ [Express API Server]
                                               │
                                               ▼
                                      [Pure-TS KpiEngine]
                                (No DB/HTTP imports; DAG + rules)
```

- **Pure Engine (`backend/src/engine.ts`)**: Stateless, deterministic, zero DB/HTTP imports, 100% driven by definitions/rules passed in.
- **Database (`backend/migrations/*.sql` + `backend/src/seed.ts`)**: Normalized SQLite schema storing definitions, parsed dependency edges, monthly actuals, scenario rules, guardrails, saved scenarios, and computed results.
- **API (`backend/src/index.ts`)**: Validates inputs, loads model definitions from SQLite, invokes `KpiEngine`, computes deltas/guardrails/causal narrative, and optionally persists scenarios.
- **Frontend (`frontend/`)**: Strict API consumer (never imports JSON), debounced live simulation, CFO KPI cards, interactive charts (Monthly P&L, Subscriber Trend, Net Profit Waterfall), Guardrail Banner, Causal Explanation panel, Side-by-Side Scenario Comparison (up to 3 scenarios), and 27-KPI Audit Table.
