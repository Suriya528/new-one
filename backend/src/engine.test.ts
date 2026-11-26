import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { KpiEngine, KpiDefinition, KpiMonthlyValues, ReactsToRule, Guardrail, roundHalfUp } from './engine';
import { seedDatabase } from './seed';
import { loadModelFromDb } from './model-loader';

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

function buildEngineFromJson(): KpiEngine {
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

  return new KpiEngine(kpiDefs, actuals, reactsTo, guardrails, raw.months, raw.scenarioRules.order);
}

describe('Profit What-If Simulator — Pure Calculation Engine', () => {
  let engine: KpiEngine;

  beforeAll(() => {
    engine = buildEngineFromJson();
  });

  // ================================================================
  // GOLDEN TEST GATE
  // ================================================================
  it('GOLDEN BASELINE: matches exact baseline FY figures within tight tolerance', () => {
    const res = engine.computeBaseline();
    const fy = res.fyValues;

    expect(Math.abs(fy.total_revenue - 13481.65)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.total_expenses - 11272.17)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.profit_before_tax - 2209.48)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.tax - 552.37)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.net_profit - 1657.11)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.round(fy.closing_subscribers) - 4131)).toBeLessThanOrEqual(1);

    // Extra precision check (< $0.05K)
    expect(fy.total_revenue).toBeCloseTo(13481.65, 1);
    expect(fy.net_profit).toBeCloseTo(1657.11, 1);
    expect(res.guardrails.every((g) => g.passed)).toBe(true);
  });

  it('GOLDEN SCENARIO (marketing -20%, price +8%, salary +5%): matches checkpoint within tolerance', () => {
    const res = engine.computeScenario({
      marketing_spend: -0.20,
      arpu: 0.08,
      ctc_per_head: 0.05,
    });
    const fy = res.fyValues;

    expect(Math.abs(fy.total_revenue - 13356.91)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.total_expenses - 11169.77)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.profit_before_tax - 2187.15)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.tax - 546.79)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(fy.net_profit - 1640.36)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(Math.round(fy.closing_subscribers) - 3500)).toBeLessThanOrEqual(1);

    // Guardrail check: year-end subscribers 3500 < 3900 should fail g_subs!
    const subsGuardrail = res.guardrails.find((g) => g.id === 'g_subs')!;
    expect(subsGuardrail.passed).toBe(false);
    expect(subsGuardrail.headroom).toBeLessThan(0);
  });

  // ================================================================
  // ACCOUNTING IDENTITIES & INVARIANTS
  // ================================================================
  it('enforces accounting identities across baseline and multi-lever scenarios', () => {
    const scenarios: Array<Record<string, number>> = [
      {},
      { arpu: 0.1, marketing_spend: 0.15, billable_heads: 0.2, ctc_per_head: -0.05 },
      { arpu: -0.15, marketing_spend: -0.4, utilization_pct: 0.25 },
      { billable_heads: 0.5, nonbillable_heads: 0.4, rate_per_hour: 0.2 },
    ];

    for (const levers of scenarios) {
      const res = engine.computeScenario(levers);
      const mv = res.monthlyValues;
      const fy = res.fyValues;

      for (let m = 0; m < 12; m++) {
        // Revenue = product + service
        expect(mv.total_revenue[m]).toBeCloseTo(
          mv.product_revenue[m] + mv.service_revenue[m],
          8
        );
        // PBT = revenue - expenses
        expect(mv.profit_before_tax[m]).toBeCloseTo(
          mv.total_revenue[m] - mv.total_expenses[m],
          8
        );
        // Net Profit = PBT - tax
        expect(mv.net_profit[m]).toBeCloseTo(
          mv.profit_before_tax[m] - mv.tax[m],
          8
        );
        // No NaN or negative subscribers
        for (const [kpiId, arr] of Object.entries(mv)) {
          expect(Number.isFinite(arr[m])).toBe(true);
          if (kpiId === 'closing_subscribers' || kpiId === 'new_subscribers' || kpiId === 'churned_subscribers') {
            expect(arr[m]).toBeGreaterThanOrEqual(0);
          }
        }
      }

      // FY identities
      expect(fy.profit_before_tax).toBeCloseTo(fy.total_revenue - fy.total_expenses, 6);
      expect(fy.net_profit).toBeCloseTo(fy.profit_before_tax - fy.tax, 6);
      expect(fy.net_margin_pct).toBeCloseTo((fy.net_profit / fy.total_revenue) * 100, 6);
    }
  });

  // ================================================================
  // INDIVIDUAL LEVER TESTS & RULE BOUNDARIES
  // ================================================================
  it('zero-lever simulation equals baseline exactly', () => {
    const base = engine.computeBaseline();
    const zero = engine.computeScenario({
      arpu: 0,
      marketing_spend: 0,
      billable_heads: 0,
      ctc_per_head: 0,
    });
    expect(zero.fyValues).toEqual(base.fyValues);
    expect(zero.monthlyValues).toEqual(base.monthlyValues);
  });

  it('respects effectiveFromMonth = 7 on ctc_per_head (months 1-6 unchanged, 7-12 scaled)', () => {
    const base = engine.computeBaseline();
    const res = engine.computeScenario({ ctc_per_head: 0.10 });

    for (let m = 0; m < 6; m++) {
      expect(res.monthlyValues.ctc_per_head[m]).toBe(base.monthlyValues.ctc_per_head[m]);
      expect(res.monthlyValues.salaries[m]).toBe(base.monthlyValues.salaries[m]);
    }
    for (let m = 6; m < 12; m++) {
      expect(res.monthlyValues.ctc_per_head[m]).toBeCloseTo(
        base.monthlyValues.ctc_per_head[m] * 1.1,
        6
      );
      expect(res.monthlyValues.salaries[m]).toBeCloseTo(
        base.monthlyValues.salaries[m] * 1.1,
        6
      );
    }
  });

  it('uses prior (Month 0) for Month 1 lag=1 references and does not mutate prior on slider changes', () => {
    const base = engine.computeBaseline();
    const res = engine.computeScenario({ marketing_spend: 0.50 });

    // Month 1 new_subscribers uses prior marketing_spend (88) / prior cac (485) * 1000
    expect(res.monthlyValues.new_subscribers[0]).toBeCloseTo((88 / 485) * 1000, 6);
    expect(res.monthlyValues.new_subscribers[0]).toBe(base.monthlyValues.new_subscribers[0]);

    // Month 2 new_subscribers reflects Month 1 marketing_spend (+50%) and Month 1 reacted CAC
    const m1Mkt = base.monthlyValues.marketing_spend[0] * 1.5;
    const m1Cac = base.monthlyValues.cac[0] * Math.pow(1.5, 0.35);
    expect(res.monthlyValues.new_subscribers[1]).toBeCloseTo((m1Mkt / m1Cac) * 1000, 6);
  });

  it('applies half-up integer rounding on headcounts and step-function rent jump above 64 heads', () => {
    // Base March heads = 37 billable + 27 nonbillable = 64 -> rent $68K (<= 64)
    const base = engine.computeBaseline();
    expect(base.monthlyValues.total_heads[11]).toBe(64);
    expect(base.monthlyValues.rent_utilities[11]).toBe(68);

    // +10% billable_heads: Month 12 billable = roundHalfUp(37 * 1.1 = 40.7) = 41 -> total = 68 (>64 -> $97K)
    const res = engine.computeScenario({ billable_heads: 0.10 });
    expect(res.monthlyValues.billable_heads[11]).toBe(41);
    expect(res.monthlyValues.total_heads[11]).toBe(68);
    expect(res.monthlyValues.rent_utilities[11]).toBe(97);

    // Half-up edge check: 35 * 1.1 = 38.5 -> 39
    expect(roundHalfUp(38.5)).toBe(39);
    expect(roundHalfUp(38.49999999999999)).toBe(39);
    expect(roundHalfUp(38.49)).toBe(38);
  });

  it('clamps utilization_pct at max 100 and churn_pct at floor 0 under extreme sliders', () => {
    const res = engine.computeScenario({
      utilization_pct: 0.80, // 75 * 1.8 = 135 -> clamped to 100
      churn_pct: -0.95,
      arpu: -0.50, // pushes churn even lower via elasticity -> floored >= 0
    });

    for (let m = 0; m < 12; m++) {
      expect(res.monthlyValues.utilization_pct[m]).toBeLessThanOrEqual(100);
      expect(res.monthlyValues.churn_pct[m]).toBeGreaterThanOrEqual(0);
    }
    expect(res.monthlyValues.utilization_pct[11]).toBe(100);

    // Burnout policy guardrail (max 85%) must fail with breachMonth = 1
    const utilGuardrail = res.guardrails.find((g) => g.id === 'g_util')!;
    expect(utilGuardrail.passed).toBe(false);
    expect(utilGuardrail.breachMonth).toBe(1);
    expect(utilGuardrail.headroom).toBe(-15);
  });

  it('each lever alone shifts expected KPIs cleanly', () => {
    const base = engine.computeBaseline();
    const arpuUp = engine.computeScenario({ arpu: 0.05 });
    expect(arpuUp.fyValues.arpu).toBeGreaterThan(base.fyValues.arpu);
    expect(arpuUp.fyValues.churn_pct).toBeGreaterThan(base.fyValues.churn_pct);

    const rateUp = engine.computeScenario({ rate_per_hour: 0.1 });
    expect(rateUp.fyValues.service_revenue).toBeCloseTo(base.fyValues.service_revenue * 1.1, 4);
    expect(rateUp.fyValues.product_revenue).toBe(base.fyValues.product_revenue);

    const nonBillUp = engine.computeScenario({ nonbillable_heads: 0.15 });
    expect(nonBillUp.fyValues.service_revenue).toBe(base.fyValues.service_revenue);
    expect(nonBillUp.fyValues.salaries).toBeGreaterThan(base.fyValues.salaries);
  });

  it('handles negative PBT with YTD tax floor & recovery without producing negative cumulative tax', () => {
    const res = engine.computeScenario({
      arpu: -0.60,
      ctc_per_head: 1.50,
      billable_heads: -0.50,
    });
    let cumTax = 0;
    for (let m = 0; m < 12; m++) {
      cumTax += res.monthlyValues.tax[m];
      expect(cumTax).toBeGreaterThanOrEqual(-1e-9);
    }
    const pbtGuardrail = res.guardrails.find((g) => g.id === 'g_pbt')!;
    expect(pbtGuardrail.passed).toBe(false);
    expect(pbtGuardrail.breachMonth).not.toBeNull();
  });

  it('fails loudly on circular intra-month KPI dependencies while allowing lag>=1 self-refs', () => {
    const cyclicKpis: KpiDefinition[] = [
      {
        id: 'a',
        label: 'A',
        kind: 'formula',
        unit: 'usd_k',
        goodWhen: 'up',
        fyAggregation: 'sum',
        isLever: false,
        isInteger: false,
        effectiveFromMonth: 1,
        priorValue: null,
        formula: { op: 'sum', inputs: [{ kpi: 'b', sign: 1 }] },
      },
      {
        id: 'b',
        label: 'B',
        kind: 'formula',
        unit: 'usd_k',
        goodWhen: 'up',
        fyAggregation: 'sum',
        isLever: false,
        isInteger: false,
        effectiveFromMonth: 1,
        priorValue: null,
        formula: { op: 'sum', inputs: [{ kpi: 'a', sign: 1 }] },
      },
    ];
    expect(() => new KpiEngine(cyclicKpis, {}, [], [])).toThrow(/Circular same-month KPI dependency/);
  });

  it('validates invalid lever inputs cleanly', () => {
    expect(() => engine.computeScenario({ unknown_kpi: 0.1 })).toThrow(/Unknown lever KPI/);
    expect(() => engine.computeScenario({ cac: 0.1 })).toThrow(/not an adjustable lever/);
    expect(() => engine.computeScenario({ arpu: Number.NaN })).toThrow(/finite number/);
    expect(() => engine.computeScenario({ arpu: -1.5 })).toThrow(/cannot be negative/);
  });

  it('produces identical results when seeded twice from scratch (idempotency)', () => {
    const tmpDb = path.join(os.tmpdir(), `philips-sim-test-${Date.now()}.db`);
    try {
      const s1 = seedDatabase(tmpDb);
      const s2 = seedDatabase(tmpDb);
      expect(s1.rowCounts).toEqual(s2.rowCounts);
      expect(s1.checksum).toBe(s2.checksum);

      const loaded = loadModelFromDb(tmpDb);
      const dbRes = loaded.engine.computeScenario({
        marketing_spend: -0.20,
        arpu: 0.08,
        ctc_per_head: 0.05,
      });
      expect(dbRes.fyValues.net_profit).toBeCloseTo(1640.36, 1);
    } finally {
      for (const ext of ['', '-wal', '-shm']) {
        if (fs.existsSync(tmpDb + ext)) fs.unlinkSync(tmpDb + ext);
      }
    }
  });

  it('HOSTILE JUDGE: passes 15 unseen scenarios checking identities and exact JSON guardrails', () => {
    const rawJson = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    const unseenScenarios: Array<Record<string, number>> = [
      { arpu: 0.03 },
      { arpu: -0.10 },
      { marketing_spend: 0.40 },
      { marketing_spend: -0.45 },
      { billable_heads: 0.20, nonbillable_heads: -0.15 },
      { ctc_per_head: 0.30 },
      { ctc_per_head: -0.25 },
      { utilization_pct: 0.12, rate_per_hour: 0.15 },
      { utilization_pct: 0.45 }, // >100 clamp + >85 guardrail breach
      { churn_pct: -0.50, arpu: 0.12 },
      { marketing_spend: 0.15, arpu: 0.05, billable_heads: 0.08, ctc_per_head: 0.06 },
      { marketing_spend: -0.35, arpu: 0.18, ctc_per_head: 0.12, nonbillable_heads: 0.25 },
      { rate_per_hour: -0.40, utilization_pct: -0.30 },
      { billable_heads: -0.30, nonbillable_heads: -0.30 }, // step down rent tier <= 50 heads!
      { arpu: 0.06, marketing_spend: 0.08, churn_pct: -0.10, billable_heads: 0.05, ctc_per_head: 0.03 },
    ];

    for (const levers of unseenScenarios) {
      const res = engine.simulateFull(levers);
      const mv = res.scenario.monthlyValues;
      const fy = res.scenario.fyValues;

      // Exact accounting identities
      expect(fy.total_revenue).toBeCloseTo(fy.product_revenue + fy.service_revenue, 6);
      expect(fy.profit_before_tax).toBeCloseTo(fy.total_revenue - fy.total_expenses, 6);
      expect(fy.net_profit).toBeCloseTo(fy.profit_before_tax - fy.tax, 6);
      expect(fy.net_margin_pct).toBeCloseTo((fy.net_profit / fy.total_revenue) * 100, 6);

      // Step rent verification against JSON step tiers
      for (let m = 0; m < 12; m++) {
        const heads = mv.total_heads[m];
        const expectedRent = heads <= 50 ? 54 : heads <= 64 ? 68 : 97;
        expect(mv.rent_utilities[m]).toBe(expectedRent);
      }

      // Guardrail verification directly against raw JSON definitions
      for (const gJson of rawJson.guardrails) {
        const gRes = res.guardrails.find((g) => g.id === gJson.id)!;
        expect(gRes).toBeDefined();
        if (gJson.scope === 'year') {
          const v = fy[gJson.kpi];
          const ok = (gJson.min === undefined || v >= gJson.min) && (gJson.max === undefined || v <= gJson.max);
          expect(gRes.passed).toBe(ok);
        } else {
          const series = mv[gJson.kpi];
          const ok = series.every(
            (v) => (gJson.min === undefined || v >= gJson.min) && (gJson.max === undefined || v <= gJson.max)
          );
          expect(gRes.passed).toBe(ok);
        }
      }
    }
  });
});
