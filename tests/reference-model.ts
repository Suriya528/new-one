/**
 * Independent Naive Reference Implementation (`tests/reference-model.ts`)
 *
 * Written directly from `company-data.json` without importing or reusing ANY code
 * from `backend/src/engine.ts` inside the financial model itself.
 *
 * Used to cross-check `KpiEngine` across 200 random lever combinations covering all 8 levers.
 *
 * Run standalone: npx --prefix backend tsx tests/reference-model.ts
 */
import fs from 'fs';
import path from 'path';
import { KpiEngine, KpiDefinition, KpiMonthlyValues, ReactsToRule, Guardrail } from '../backend/src/engine';

const STANDALONE_DATA = path.resolve(__dirname, '..', 'data', 'company-data.json');
const DATA_PATH = fs.existsSync(STANDALONE_DATA)
  ? STANDALONE_DATA
  : path.resolve(
      __dirname,
      '..',
      'repo-data',
      'Profit What-If Simulator',
      'data',
      'company-data.json'
    );

export interface NaiveResult {
  monthly: Record<string, number[]>;
  fy: Record<string, number>;
}

/**
 * Completely standalone, explicit naive implementation of all 27 KPIs from company-data.json.
 * Zero shared code with KpiEngine.
 */
export function runNaiveReferenceModel(
  rawData: any,
  levers: Record<string, number>
): NaiveResult {
  const byId: Record<string, any> = {};
  for (const k of rawData.kpis) {
    byId[k.id] = k;
  }

  const M = rawData.months.length; // 12
  const monthly: Record<string, number[]> = {};

  // 1. Initialize actuals & apply sliders from effectiveFromMonth onwards
  const inputIds = [
    'marketing_spend',
    'cac',
    'arpu',
    'churn_pct',
    'billable_heads',
    'nonbillable_heads',
    'utilization_pct',
    'rate_per_hour',
    'ctc_per_head',
    'hosting_per_sub',
  ];

  for (const id of inputIds) {
    const def = byId[id];
    const slider = levers[id] ?? 0;
    const eff = def.effectiveFromMonth ?? 1;
    monthly[id] = def.actuals.map((val: number, idx: number) => {
      const mNum = idx + 1;
      return mNum >= eff ? val * (1 + slider) : val;
    });
  }

  // 2. Apply reactsTo cross-elasticities per month
  for (const rule of rawData.scenarioRules.reactsTo) {
    const srcActuals: number[] = byId[rule.source].actuals;
    const srcScen: number[] = monthly[rule.source];
    const tgtScen: number[] = monthly[rule.target];
    for (let m = 0; m < M; m++) {
      const ratio = srcScen[m] / srcActuals[m];
      if (ratio === 0) {
        if (rule.elasticity > 0) tgtScen[m] = 0;
      } else {
        tgtScen[m] = tgtScen[m] * Math.pow(ratio, rule.elasticity);
      }
    }
  }

  // 3. Integer rounding (half up)
  for (const id of ['billable_heads', 'nonbillable_heads']) {
    monthly[id] = monthly[id].map((v) => Math.floor(v + 0.5 + 1e-12));
  }

  // 4. Max / min clamps (churn floor 0, utilization max 100)
  for (let m = 0; m < M; m++) {
    if (monthly.churn_pct[m] < 0) monthly.churn_pct[m] = 0;
    if (monthly.utilization_pct[m] > 100) monthly.utilization_pct[m] = 100;
  }

  // 5. Formula KPIs month by month (1..12)
  const formulaIds = [
    'new_subscribers',
    'churned_subscribers',
    'closing_subscribers',
    'product_revenue',
    'billable_hours',
    'service_revenue',
    'total_revenue',
    'total_heads',
    'salaries',
    'hosting',
    'gateway_fees',
    'rent_utilities',
    'total_expenses',
    'profit_before_tax',
    'tax',
    'net_profit',
    'net_margin_pct',
  ];
  for (const id of formulaIds) {
    monthly[id] = new Array(M).fill(0);
  }

  let ytdPbt = 0;
  let ytdTax = 0;

  for (let m = 0; m < M; m++) {
    // 11. new_subscribers = marketing_spend[t-1] / cac[t-1] * 1000
    const mktLag1 = m === 0 ? byId.marketing_spend.prior : monthly.marketing_spend[m - 1];
    const cacLag1 = m === 0 ? byId.cac.prior : monthly.cac[m - 1];
    monthly.new_subscribers[m] = cacLag1 === 0 ? 0 : (mktLag1 / cacLag1) * 1000;

    // 12. churned_subscribers = closing_subscribers[t-1] * churn_pct[t] * 0.01
    const subLag1 = m === 0 ? byId.closing_subscribers.prior : monthly.closing_subscribers[m - 1];
    monthly.churned_subscribers[m] = subLag1 * monthly.churn_pct[m] * 0.01;

    // 13. closing_subscribers = closing_subscribers[t-1] + new - churned
    monthly.closing_subscribers[m] =
      subLag1 + monthly.new_subscribers[m] - monthly.churned_subscribers[m];

    // 14. product_revenue = closing_subscribers * arpu * 0.001
    monthly.product_revenue[m] = monthly.closing_subscribers[m] * monthly.arpu[m] * 0.001;

    // 15. billable_hours = billable_heads * utilization_pct * 160 * 0.01
    monthly.billable_hours[m] =
      monthly.billable_heads[m] * monthly.utilization_pct[m] * 160 * 0.01;

    // 16. service_revenue = billable_hours * rate_per_hour * 0.001
    monthly.service_revenue[m] =
      monthly.billable_hours[m] * monthly.rate_per_hour[m] * 0.001;

    // 17. total_revenue = product_revenue + service_revenue
    monthly.total_revenue[m] =
      monthly.product_revenue[m] + monthly.service_revenue[m];

    // 18. total_heads = billable_heads + nonbillable_heads
    monthly.total_heads[m] =
      monthly.billable_heads[m] + monthly.nonbillable_heads[m];

    // 19. salaries = total_heads * ctc_per_head * 1.2 * 0.001
    monthly.salaries[m] =
      monthly.total_heads[m] * monthly.ctc_per_head[m] * 1.2 * 0.001;

    // 20. hosting = closing_subscribers * hosting_per_sub * 0.001
    monthly.hosting[m] =
      monthly.closing_subscribers[m] * monthly.hosting_per_sub[m] * 0.001;

    // 21. gateway_fees = product_revenue * 0.029
    monthly.gateway_fees[m] = monthly.product_revenue[m] * 0.029;

    // 22. rent_utilities step function
    const h = monthly.total_heads[m];
    monthly.rent_utilities[m] = h <= 50 ? 54 : h <= 64 ? 68 : 97;

    // 23. total_expenses
    monthly.total_expenses[m] =
      monthly.salaries[m] +
      monthly.marketing_spend[m] +
      monthly.rent_utilities[m] +
      monthly.hosting[m] +
      monthly.gateway_fees[m];

    // 24. profit_before_tax
    monthly.profit_before_tax[m] =
      monthly.total_revenue[m] - monthly.total_expenses[m];

    // 25. tax (ytd_tax 25%)
    ytdPbt += monthly.profit_before_tax[m];
    const cumTaxDue = Math.max(0, 0.25 * ytdPbt);
    monthly.tax[m] = cumTaxDue - ytdTax;
    ytdTax = cumTaxDue;

    // 26. net_profit
    monthly.net_profit[m] = monthly.profit_before_tax[m] - monthly.tax[m];

    // 27. net_margin_pct
    monthly.net_margin_pct[m] =
      monthly.total_revenue[m] === 0
        ? 0
        : (monthly.net_profit[m] / monthly.total_revenue[m]) * 100;
  }

  // 6. FY Aggregations
  const fy: Record<string, number> = {};
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const mean = (arr: number[]) => sum(arr) / arr.length;

  for (const k of rawData.kpis) {
    if (k.fy === 'sum') fy[k.id] = sum(monthly[k.id]);
    else if (k.fy === 'mean') fy[k.id] = mean(monthly[k.id]);
    else if (k.fy === 'last') fy[k.id] = monthly[k.id][M - 1];
  }
  fy.net_margin_pct =
    fy.total_revenue === 0 ? 0 : (fy.net_profit / fy.total_revenue) * 100;

  return { monthly, fy };
}

function createDeterministicRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CrossCheckReport {
  scenariosTested: number;
  maxDiffNetProfit: number;
  maxDiffRevenue: number;
  maxDiffExpenses: number;
  maxDiffSubscribers: number;
  maxDiffAnyKpi: number;
}

export function runCrossCheck(count: number = 200): CrossCheckReport {
  const rawData = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  const orderRules: string[] = rawData.scenarioRules?.order || [];
  const hasChurnFloorZero = orderRules.some((r) => r.toLowerCase().includes('churn floor 0'));
  const kpiDefs: KpiDefinition[] = rawData.kpis.map((k: any, idx: number) => ({
    id: k.id,
    sortOrder: idx + 1,
    label: k.label,
    kind: k.kind,
    unit: k.unit,
    goodWhen: k.goodWhen,
    fyAggregation: k.fy,
    isLever: !!k.lever,
    isInteger: !!k.integer,
    minValue: k.min ?? (hasChurnFloorZero && k.id === 'churn_pct' ? 0 : null),
    maxValue: k.max ?? null,
    effectiveFromMonth: k.effectiveFromMonth ?? 1,
    priorValue: k.prior ?? null,
    formula: k.kind === 'formula' ? k : null,
  }));
  const actuals: KpiMonthlyValues = {};
  for (const k of rawData.kpis) {
    if (k.actuals) actuals[k.id] = k.actuals;
  }
  const reactsTo: ReactsToRule[] = rawData.scenarioRules.reactsTo;
  const guardrails: Guardrail[] = rawData.guardrails.map((g: any) => ({
    id: g.id,
    label: g.label,
    kpiId: g.kpi,
    scope: g.scope,
    min: g.min ?? null,
    max: g.max ?? null,
  }));

  const engine = new KpiEngine(
    kpiDefs,
    actuals,
    reactsTo,
    guardrails,
    rawData.months,
    rawData.scenarioRules.order
  );

  const leverIds = [
    'marketing_spend',
    'arpu',
    'churn_pct',
    'billable_heads',
    'nonbillable_heads',
    'utilization_pct',
    'rate_per_hour',
    'ctc_per_head',
  ];

  const rng = createDeterministicRng(20260401);

  let maxDiffNetProfit = 0;
  let maxDiffRevenue = 0;
  let maxDiffExpenses = 0;
  let maxDiffSubscribers = 0;
  let maxDiffAnyKpi = 0;

  for (let i = 0; i < count; i++) {
    const levers: Record<string, number> = {};

    // Ensure at least one lever active and cover all 8 levers across 200 random scenarios
    for (const id of leverIds) {
      if (rng() < 0.72) {
        const r = rng();
        let val: number;
        if (r < 0.04) val = -1.0; // occasional -100% boundary
        else if (r < 0.84) val = Math.round((rng() * 1.4 - 0.6) * 100) / 100; // -0.60 to +0.80
        else val = Math.round((rng() * 6.0 - 1.0) * 100) / 100; // -1.0 to +5.0
        levers[id] = val;
      }
    }
    if (Object.keys(levers).length === 0) {
      const pick = leverIds[Math.floor(rng() * leverIds.length)];
      levers[pick] = Math.round((rng() * 1.0 - 0.5) * 100) / 100;
    }

    const engineRes = engine.computeScenario(levers);
    const naiveRes = runNaiveReferenceModel(rawData, levers);

    maxDiffNetProfit = Math.max(
      maxDiffNetProfit,
      Math.abs(engineRes.fyValues.net_profit - naiveRes.fy.net_profit)
    );
    maxDiffRevenue = Math.max(
      maxDiffRevenue,
      Math.abs(engineRes.fyValues.total_revenue - naiveRes.fy.total_revenue)
    );
    maxDiffExpenses = Math.max(
      maxDiffExpenses,
      Math.abs(engineRes.fyValues.total_expenses - naiveRes.fy.total_expenses)
    );
    maxDiffSubscribers = Math.max(
      maxDiffSubscribers,
      Math.abs(engineRes.fyValues.closing_subscribers - naiveRes.fy.closing_subscribers)
    );

    for (const k of rawData.kpis) {
      const diff = Math.abs(engineRes.fyValues[k.id] - naiveRes.fy[k.id]);
      maxDiffAnyKpi = Math.max(maxDiffAnyKpi, diff);
      if (diff > 0.1) {
        throw new Error(
          `Cross-check divergence on scenario #${i} KPI "${k.id}": engine=${engineRes.fyValues[k.id]}, naive=${naiveRes.fy[k.id]}, diff=${diff}, levers=${JSON.stringify(levers)}`
        );
      }
    }
  }

  return {
    scenariosTested: count,
    maxDiffNetProfit,
    maxDiffRevenue,
    maxDiffExpenses,
    maxDiffSubscribers,
    maxDiffAnyKpi,
  };
}

if (require.main === module) {
  const report = runCrossCheck(200);
  console.log('\nIndependent Cross-Check Report (200 Random Lever Combinations):');
  console.table([
    {
      'Scenarios Tested': report.scenariosTested,
      'Max Diff Revenue ($K)': report.maxDiffRevenue.toExponential(3),
      'Max Diff Expenses ($K)': report.maxDiffExpenses.toExponential(3),
      'Max Diff Net Profit ($K)': report.maxDiffNetProfit.toExponential(3),
      'Max Diff Subscribers': report.maxDiffSubscribers.toExponential(3),
      'Max Diff Any of 27 KPIs': report.maxDiffAnyKpi.toExponential(3),
    },
  ]);
}
