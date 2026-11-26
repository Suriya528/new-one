# Profit What-If Simulator — Requirements Mapping

## Source Documents
- `repo-data/Profit What-If Simulator/README.md` — Build instructions & submission checklist
- `repo-data/Profit What-If Simulator/data/company-data.json` — Full KPI specification (27 KPIs, 12 months actuals, scenario rules, guardrails)
- `repo-data/Profit What-If Simulator/Profit What-if Simulator.pptx` — Business context & checkpoint scenario

---

## Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Frontend | React + TypeScript + Vite | Required by spec |
| Backend | Node.js + Express + TypeScript | Simplest compliant backend; same language as frontend |
| Database | SQLite (via better-sqlite3) | Zero-config, file-based, seed script can run from scratch |
| State Mgmt | React Context + hooks | Lightweight for this scope |
| Charts | Recharts | React-native charting library |

---

## 27 KPIs — Complete Catalog

### Input KPIs (10) — Levers users can adjust via sliders

| # | ID | Label | Unit | FY Agg | Lever | Good When | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `marketing_spend` | Marketing spend | usd_k | sum | ✅ | down | |
| 2 | `cac` | Cost to acquire a subscriber | usd | mean | ❌ | down | Reacts to marketing_spend (elasticity 0.35) |
| 3 | `arpu` | Price per subscriber per month | usd | mean | ✅ | up | |
| 4 | `churn_pct` | Monthly churn | pct | mean | ✅ | down | Reacts to arpu (elasticity 4), floor 0 |
| 5 | `billable_heads` | Billable people | count | last | ✅ | neutral | Integer only |
| 6 | `nonbillable_heads` | Non-billable people | count | last | ✅ | neutral | Integer only |
| 7 | `utilization_pct` | Utilisation of billable people | pct | mean | ✅ | up | Max 100 |
| 8 | `rate_per_hour` | Project billing rate per hour | usd | mean | ✅ | up | |
| 9 | `ctc_per_head` | Average salary cost per person/month | usd | mean | ✅ | up | effectiveFromMonth: 7 |
| 10 | `hosting_per_sub` | Hosting cost per subscriber/month | usd | mean | ❌ | down | |

### Formula KPIs (17) — Computed deterministically

| # | ID | Label | Unit | FY Agg | Op | Formula |
|---|---|---|---|---|---|---|
| 11 | `new_subscribers` | New subscribers | count | sum | ratio | marketing_spend[lag1] / cac[lag1] × 1000 |
| 12 | `churned_subscribers` | Churned subscribers | count | sum | product | closing_subscribers[lag1] × churn_pct × 0.01 |
| 13 | `closing_subscribers` | Subscribers at month end | count | last | sum | closing_subscribers[lag1] + new_subscribers − churned_subscribers (prior=3000) |
| 14 | `product_revenue` | Product revenue | usd_k | sum | product | closing_subscribers × arpu × 0.001 |
| 15 | `billable_hours` | Billable hours | count | sum | product | billable_heads × utilization_pct × 160 × 0.01 |
| 16 | `service_revenue` | Service revenue | usd_k | sum | product | billable_hours × rate_per_hour × 0.001 |
| 17 | `total_revenue` | Total revenue | usd_k | sum | sum | product_revenue + service_revenue |
| 18 | `total_heads` | Total people | count | last | sum | billable_heads + nonbillable_heads |
| 19 | `salaries` | Salaries (loaded) | usd_k | sum | product | total_heads × ctc_per_head × 1.2 × 0.001 |
| 20 | `hosting` | Hosting | usd_k | sum | product | closing_subscribers × hosting_per_sub × 0.001 |
| 21 | `gateway_fees` | Payment gateway fees | usd_k | sum | product | product_revenue × 0.029 |
| 22 | `rent_utilities` | Rent & utilities | usd_k | sum | step | Based on total_heads: ≤50→54, ≤64→68, >64→97 |
| 23 | `total_expenses` | Total expenses | usd_k | sum | sum | salaries + marketing_spend + rent_utilities + hosting + gateway_fees |
| 24 | `profit_before_tax` | Profit before tax | usd_k | sum | sum | total_revenue − total_expenses |
| 25 | `tax` | Tax | usd_k | sum | ytd_tax | 25% of cumulative PBT (incremental method) |
| 26 | `net_profit` | Net profit | usd_k | sum | sum | profit_before_tax − tax |
| 27 | `net_margin_pct` | Net margin | pct | recompute | ratio | net_profit / total_revenue × 100 |

---

## Scenario Rules (from company-data.json)

### Slider Mechanics
- A slider represents a fractional change (e.g., 0.05 = +5%)
- Applied to every month of an input KPI from `effectiveFromMonth` (default 1) onwards
- `scenario_month = actual_month × (1 + slider_value)`

### ReactsTo (Cross-elasticity)
1. `marketing_spend → cac` (elasticity 0.35): `cac_scenario = cac_actual × (marketing_spend_scenario / marketing_spend_actual) ^ 0.35`
2. `arpu → churn_pct` (elasticity 4): `churn_scenario = churn_actual × (arpu_scenario / arpu_actual) ^ 4`

### Computation Order
1. Apply sliders to input KPIs
2. Apply reactsTo cross-elasticities
3. Integer rounding (half up) for integer KPIs
4. Apply max/min clamps (churn floor 0, utilization max 100)
5. Compute formulas month by month (month 1 through 12)

### Lag References
- `lag: n` means read the same KPI from n months earlier
- Month 0 reads the `prior` value

### FY Aggregation Rules
- `sum`: Add all 12 months
- `last`: Value of month 12
- `mean`: Simple average of 12 months
- `recompute`: Apply the formula to the FY totals (e.g., net_margin_pct)

---

## Board Guardrails (4)

| ID | Label | KPI | Scope | Constraint |
|---|---|---|---|---|
| `g_margin` | FY net margin at least 10% | net_margin_pct | year | min: 10 |
| `g_pbt` | No month with a loss before tax | profit_before_tax | every_month | min: 0 |
| `g_subs` | At least 3,900 subscribers at year end | closing_subscribers | year | min: 3900 |
| `g_util` | Utilisation never above 85% | utilization_pct | every_month | max: 85 |

---

## Must-Have Features

| # | Feature | Implementation |
|---|---|---|
| 1 | Load company-data.json into database via seed script | SQLite seed script |
| 2 | API layer — React reads data only through API | Express REST API |
| 3 | Do NOT import JSON into React code | ✅ All data via API |
| 4 | Show loading and error states | React loading/error UI |
| 5 | Scenario creation with slider adjustments | Slider UI + scenario engine |
| 6 | Scenario editing | Edit existing scenarios |
| 7 | Scenario comparison (actual vs scenario) | Side-by-side KPI comparison |
| 8 | Scenario reset | Reset to actuals |
| 9 | All 27 KPIs computed correctly | Deterministic engine |
| 10 | Financial guardrails validation | Real-time guardrail checks |
| 11 | Checkpoint scenario verification (±$1K tolerance) | Engine accuracy tests |

---

## Submission Checklist

- [ ] React app + backend code
- [ ] Seed script (re-runnable from scratch)
- [ ] `HOW_TO_RUN.md` — exact commands
- [ ] `ASSUMPTIONS.md` — documented ambiguities
- [ ] No node_modules, build folders, or passwords
