import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import {
  KpiEngine,
  KpiDefinition,
  KpiMonthlyValues,
  ReactsToRule,
  Guardrail,
} from './engine';
import { seedDatabase } from './seed';
import { createApp } from './index';
import { runCrossCheck } from '../../tests/reference-model';

const STANDALONE_DATA = path.resolve(__dirname, '..', '..', 'data', 'company-data.json');
const DATA_PATH = fs.existsSync(STANDALONE_DATA)
  ? STANDALONE_DATA
  : path.resolve(
      __dirname,
      '..',
      '..',
      'repo-data',
      'Profit What-If Simulator',
      'data',
      'company-data.json'
    );

const ALL_LEVERS = [
  'marketing_spend',
  'arpu',
  'churn_pct',
  'billable_heads',
  'nonbillable_heads',
  'utilization_pct',
  'rate_per_hour',
  'ctc_per_head',
] as const;

function buildEngine(): { engine: KpiEngine; kpis: KpiDefinition[] } {
  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  const orderRules: string[] = raw.scenarioRules?.order || [];
  const hasChurnFloorZero = orderRules.some((r) => r.toLowerCase().includes('churn floor 0'));

  const kpiDefs: KpiDefinition[] = raw.kpis.map((k: any, idx: number) => ({
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
  for (const k of raw.kpis) {
    if (k.actuals) actuals[k.id] = k.actuals;
  }

  const reactsTo: ReactsToRule[] = raw.scenarioRules.reactsTo;
  const guardrails: Guardrail[] = raw.guardrails.map((g: any) => ({
    id: g.id,
    label: g.label,
    kpiId: g.kpi,
    scope: g.scope,
    min: g.min ?? null,
    max: g.max ?? null,
  }));

  return {
    engine: new KpiEngine(
      kpiDefs,
      actuals,
      reactsTo,
      guardrails,
      raw.months,
      raw.scenarioRules.order
    ),
    kpis: kpiDefs,
  };
}

describe('Hardening Suite — Extreme Levers, Per-Lever Sanity & Cross-Check', () => {
  let engine: KpiEngine;
  let kpis: KpiDefinition[];
  const tmpDb = path.join(os.tmpdir(), `philips-hardening-${Date.now()}.db`);
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    ({ engine, kpis } = buildEngine());
    seedDatabase(tmpDb);
    const app = createApp(tmpDb);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(tmpDb + ext)) fs.unlinkSync(tmpDb + ext);
    }
  });

  // =========================================================================
  // 1. EXTREME LEVERS: -100%, +100%, +500% ON EVERY LEVER + 0^ELASTICITY
  // =========================================================================
  it('computes -100% (-1.0), +100% (+1.0), and +500% (+5.0) cleanly on EVERY lever via engine and API (no HTTP 400)', async () => {
    for (const lever of ALL_LEVERS) {
      for (const extreme of [-1.0, 1.0, 5.0]) {
        const res = await fetch(`${baseUrl}/api/simulate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ levers: { [lever]: extreme } }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as any;

        // Every monthly and FY value across all 27 KPIs must be finite
        for (const k of kpis) {
          expect(Number.isFinite(body.scenario.fyValues[k.id])).toBe(true);
          for (let m = 0; m < 12; m++) {
            expect(Number.isFinite(body.scenario.monthlyValues[k.id][m])).toBe(true);
          }
        }

        // Exact accounting identities even at extremes (relative to float magnitude)
        const fy = body.scenario.fyValues;
        const pbtExpected = fy.total_revenue - fy.total_expenses;
        const netExpected = fy.profit_before_tax - fy.tax;
        expect(Math.abs(fy.profit_before_tax - pbtExpected)).toBeLessThanOrEqual(
          Math.max(1e-5, Math.abs(fy.total_revenue) * 1e-12)
        );
        expect(Math.abs(fy.net_profit - netExpected)).toBeLessThanOrEqual(
          Math.max(1e-5, Math.abs(fy.profit_before_tax) * 1e-12)
        );
      }
    }
  });

  it('handles 0^elasticity mathematically at -100% marketing_spend and -100% arpu and flags degenerate warnings', () => {
    // Marketing -100% -> marketing_spend=0 -> cac = 0^0.35 = 0 -> M1 uses prior (88/485*1000), M2..12 new_subscribers = 0
    const mktZero = engine.simulateFull({ marketing_spend: -1.0 });
    expect(mktZero.scenario.fyValues.marketing_spend).toBe(0);
    expect(mktZero.scenario.fyValues.cac).toBe(0);
    expect(mktZero.scenario.monthlyValues.new_subscribers[0]).toBeCloseTo((88 / 485) * 1000, 6);
    for (let m = 1; m < 12; m++) {
      expect(mktZero.scenario.monthlyValues.new_subscribers[m]).toBe(0);
    }
    expect(mktZero.warnings.some((w) => w.code === 'zero_elasticity')).toBe(true);
    expect(mktZero.warnings.some((w) => w.code === 'zero_denominator')).toBe(true);

    // ARPU -100% -> arpu=0 -> churn_pct = 0^4 = 0 -> product_revenue = 0
    const arpuZero = engine.simulateFull({ arpu: -1.0 });
    expect(arpuZero.scenario.fyValues.arpu).toBe(0);
    expect(arpuZero.scenario.fyValues.churn_pct).toBe(0);
    expect(arpuZero.scenario.fyValues.product_revenue).toBe(0);
    expect(arpuZero.warnings.some((w) => w.code === 'zero_elasticity')).toBe(true);

    // Combined zero revenue (-100% ARPU and -100% billing rate) -> degenerate net_margin_pct warning
    const zeroRev = engine.simulateFull({ arpu: -1.0, rate_per_hour: -1.0 });
    expect(zeroRev.scenario.fyValues.total_revenue).toBe(0);
    expect(zeroRev.scenario.fyValues.net_margin_pct).toBe(0);
    expect(zeroRev.warnings.some((w) => w.code === 'zero_total_revenue')).toBe(true);
  });

  it('rejects only truly undefined inputs (< -100%, NaN, non-lever, unknown KPI)', async () => {
    const invalidPayloads = [
      { levers: { marketing_spend: -1.01 } },
      { levers: { arpu: -1.5 } },
      { levers: { arpu: 'invalid' } },
      { levers: { cac: 0.1 } },
      { levers: { nonexistent_kpi: 0.1 } },
    ];
    for (const payload of invalidPayloads) {
      const res = await fetch(`${baseUrl}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(400);
    }
  });

  // =========================================================================
  // 2. INDEPENDENT CROSS-CHECK (200 RANDOM SCENARIOS AGAINST NAIVE MODEL)
  // =========================================================================
  it('cross-checks KpiEngine against independent naive reference model across 200 random combinations (< $0.1K diff)', () => {
    const report = runCrossCheck(200);
    expect(report.scenariosTested).toBe(200);
    expect(report.maxDiffRevenue).toBeLessThan(0.1);
    expect(report.maxDiffExpenses).toBeLessThan(0.1);
    expect(report.maxDiffNetProfit).toBeLessThan(0.1);
    expect(report.maxDiffSubscribers).toBeLessThan(0.1);
    expect(report.maxDiffAnyKpi).toBeLessThan(0.1);
  });

  // =========================================================================
  // 3. PER-LEVER SANITY TESTS (+10% AND -10% ON EVERY ONE OF THE 8 LEVERS)
  // =========================================================================
  it('verifies directional impact of each of the 8 levers alone (+10% & -10%) and effectiveFromMonth boundaries', () => {
    const base = engine.computeBaseline();

    const checkEffectiveBefore = (leverId: string, pct: number) => {
      const def = kpis.find((k) => k.id === leverId)!;
      const res = engine.computeScenario({ [leverId]: pct });
      // For any month strictly before effectiveFromMonth, ALL 27 KPIs must be identical to baseline
      for (let m = 0; m < def.effectiveFromMonth - 1; m++) {
        for (const k of kpis) {
          expect(res.monthlyValues[k.id][m]).toBe(base.monthlyValues[k.id][m]);
        }
      }
      return res.fyValues;
    };

    // 1. marketing_spend: +10% raises subs (1.1^0.65 > 1), revenue, and expenses; PBT falls in Year 1 because CAC-adjusted spend > Year-1 ARPU gain
    const mktUp = checkEffectiveBefore('marketing_spend', 0.10);
    expect(mktUp.closing_subscribers).toBeGreaterThan(base.fyValues.closing_subscribers);
    expect(mktUp.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(mktUp.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(mktUp.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    const mktDown = checkEffectiveBefore('marketing_spend', -0.10);
    expect(mktDown.closing_subscribers).toBeLessThan(base.fyValues.closing_subscribers);
    expect(mktDown.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(mktDown.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(mktDown.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    // 2. arpu: +10% raises churn steeply (1.1^4 = 1.464x) -> drops subscribers & sub-linked expenses, while +10% ARPU lifts total revenue & PBT
    const arpuUp = checkEffectiveBefore('arpu', 0.10);
    expect(arpuUp.closing_subscribers).toBeLessThan(base.fyValues.closing_subscribers);
    expect(arpuUp.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(arpuUp.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(arpuUp.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    const arpuDown = checkEffectiveBefore('arpu', -0.10);
    expect(arpuDown.closing_subscribers).toBeGreaterThan(base.fyValues.closing_subscribers);
    expect(arpuDown.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(arpuDown.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(arpuDown.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    // 3. churn_pct: +10% drops subs -> lowers revenue, slightly lowers sub-linked expenses, drops PBT
    const churnUp = checkEffectiveBefore('churn_pct', 0.10);
    expect(churnUp.closing_subscribers).toBeLessThan(base.fyValues.closing_subscribers);
    expect(churnUp.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(churnUp.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(churnUp.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    const churnDown = checkEffectiveBefore('churn_pct', -0.10);
    expect(churnDown.closing_subscribers).toBeGreaterThan(base.fyValues.closing_subscribers);
    expect(churnDown.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(churnDown.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(churnDown.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    // 4. billable_heads: +10% raises service revenue, salary & rent (>64 tier) expenses, and PBT; leaves subs unchanged
    const bhUp = checkEffectiveBefore('billable_heads', 0.10);
    expect(bhUp.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(bhUp.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(bhUp.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(bhUp.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    const bhDown = checkEffectiveBefore('billable_heads', -0.10);
    expect(bhDown.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(bhDown.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(bhDown.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(bhDown.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    // 5. nonbillable_heads: revenue & subs unchanged; expenses up -> PBT down (and vice versa)
    const nbhUp = checkEffectiveBefore('nonbillable_heads', 0.10);
    expect(nbhUp.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(nbhUp.total_revenue).toBe(base.fyValues.total_revenue);
    expect(nbhUp.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(nbhUp.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    const nbhDown = checkEffectiveBefore('nonbillable_heads', -0.10);
    expect(nbhDown.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(nbhDown.total_revenue).toBe(base.fyValues.total_revenue);
    expect(nbhDown.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(nbhDown.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    // 6. utilization_pct: +10% raises service revenue & PBT, leaves expenses & subs identical
    const utilUp = checkEffectiveBefore('utilization_pct', 0.10);
    expect(utilUp.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(utilUp.total_expenses).toBe(base.fyValues.total_expenses);
    expect(utilUp.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(utilUp.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    const utilDown = checkEffectiveBefore('utilization_pct', -0.10);
    expect(utilDown.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(utilDown.total_expenses).toBe(base.fyValues.total_expenses);
    expect(utilDown.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(utilDown.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    // 7. rate_per_hour: +10% raises service revenue & PBT, leaves expenses & subs identical
    const rateUp = checkEffectiveBefore('rate_per_hour', 0.10);
    expect(rateUp.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(rateUp.total_expenses).toBe(base.fyValues.total_expenses);
    expect(rateUp.total_revenue).toBeGreaterThan(base.fyValues.total_revenue);
    expect(rateUp.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);

    const rateDown = checkEffectiveBefore('rate_per_hour', -0.10);
    expect(rateDown.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(rateDown.total_expenses).toBe(base.fyValues.total_expenses);
    expect(rateDown.total_revenue).toBeLessThan(base.fyValues.total_revenue);
    expect(rateDown.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    // 8. ctc_per_head (effectiveFromMonth = 7): M1-M6 IDENTICAL to baseline; revenue & subs unchanged; expenses up -> PBT down
    const ctcUp = checkEffectiveBefore('ctc_per_head', 0.10);
    expect(ctcUp.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(ctcUp.total_revenue).toBe(base.fyValues.total_revenue);
    expect(ctcUp.total_expenses).toBeGreaterThan(base.fyValues.total_expenses);
    expect(ctcUp.profit_before_tax).toBeLessThan(base.fyValues.profit_before_tax);

    const ctcDown = checkEffectiveBefore('ctc_per_head', -0.10);
    expect(ctcDown.closing_subscribers).toBe(base.fyValues.closing_subscribers);
    expect(ctcDown.total_revenue).toBe(base.fyValues.total_revenue);
    expect(ctcDown.total_expenses).toBeLessThan(base.fyValues.total_expenses);
    expect(ctcDown.profit_before_tax).toBeGreaterThan(base.fyValues.profit_before_tax);
  });
});
