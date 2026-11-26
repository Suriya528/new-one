/**
 * Pure-TypeScript Deterministic Financial Calculation Engine.
 *
 * Strictly zero DB or HTTP imports.
 * Interprets all KPIs, formulas, lag rules, cross-elasticities, rounding/clamps,
 * FY aggregations, and guardrails generically from definitions passed in.
 */

export type KpiKind = 'input' | 'formula';
export type KpiUnit = 'usd_k' | 'usd' | 'pct' | 'count';
export type GoodWhen = 'up' | 'down' | 'neutral';
export type FyRule = 'sum' | 'mean' | 'last' | 'recompute';
export type FormulaOp = 'ratio' | 'product' | 'sum' | 'step' | 'ytd_tax';

export interface KpiRef {
  kpi: string;
  lag?: number;
}

export interface ConstRef {
  const: number;
}

export interface SignedRef {
  kpi: string;
  lag?: number;
  sign: number;
}

export interface StepDef {
  upTo: number | null;
  value: number;
}

export interface FormulaDefinition {
  op: FormulaOp;
  num?: KpiRef;
  den?: KpiRef;
  scale?: number;
  factors?: Array<KpiRef | ConstRef>;
  inputs?: SignedRef[];
  on?: KpiRef;
  steps?: StepDef[];
  inclusive?: boolean;
  base?: string;
  rate?: number;
}

export interface KpiDefinition {
  id: string;
  sortOrder?: number;
  label: string;
  kind: KpiKind;
  unit: KpiUnit;
  goodWhen: GoodWhen;
  fyAggregation: FyRule;
  isLever: boolean;
  isPrimaryLever?: boolean;
  isInteger: boolean;
  minValue?: number | null;
  maxValue?: number | null;
  effectiveFromMonth: number;
  priorValue: number | null;
  formula: FormulaDefinition | null;
}

export interface ReactsToRule {
  source: string;
  target: string;
  elasticity: number;
}

export interface Guardrail {
  id: string;
  label: string;
  kpiId: string;
  scope: 'year' | 'every_month';
  min: number | null;
  max: number | null;
}

export interface LeverSet {
  [kpiId: string]: number; // fractional change, e.g., 0.08 = +8%, -1.0 = -100%, 5.0 = +500%
}

export interface KpiMonthlyValues {
  [kpiId: string]: number[]; // 12 values (index 0 = month 1)
}

export interface KpiFyValues {
  [kpiId: string]: number;
}

export interface GuardrailResult {
  id: string;
  label: string;
  kpiId: string;
  scope: 'year' | 'every_month';
  passed: boolean;
  actual: number;
  limit: number;
  operator: 'min' | 'max' | 'range';
  headroom: number;
  breachMonth: number | null;
  breachMonthLabel: string | null;
  failedMonths: number[];
}

export interface SimulationWarning {
  code: string;
  title: string;
  detail: string;
}

export interface WaterfallDriver {
  id: string;
  label: string;
  impactUsdK: number;
  category: 'revenue' | 'expense' | 'tax' | 'subtotal';
}

export interface CausalStep {
  title: string;
  detail: string;
  impactDirection: 'positive' | 'negative' | 'neutral';
}

export interface KpiDelta {
  kpiId: string;
  label: string;
  unit: KpiUnit;
  goodWhen: GoodWhen;
  fyRule: FyRule;
  baselineFy: number;
  scenarioFy: number;
  deltaAbs: number;
  deltaPct: number | null;
}

export interface ScenarioComputation {
  monthlyValues: KpiMonthlyValues;
  fyValues: KpiFyValues;
  guardrails: GuardrailResult[];
  warnings: SimulationWarning[];
}

export interface FullSimulationResponse {
  months: string[];
  levers: LeverSet;
  baseline: {
    monthlyValues: KpiMonthlyValues;
    fyValues: KpiFyValues;
    guardrails: GuardrailResult[];
  };
  scenario: {
    monthlyValues: KpiMonthlyValues;
    fyValues: KpiFyValues;
  };
  deltas: Record<string, KpiDelta>;
  guardrails: GuardrailResult[];
  warnings: SimulationWarning[];
  waterfall: WaterfallDriver[];
  explanation: CausalStep[];
}

export class SimulationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationInputError';
  }
}

/**
 * Half-up integer rounding with epsilon tolerance to prevent IEEE-754 drift.
 */
export function roundHalfUp(n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`Cannot round non-finite number: ${n}`);
  }
  const eps = 1e-12;
  if (n >= 0) {
    return Math.floor(n + 0.5 + eps);
  }
  return -Math.floor(-n + 0.5 + eps);
}

function sanitizeFloat(n: number): number {
  if (!Number.isFinite(n)) {
    throw new Error(`Calculation produced non-finite value: ${n}`);
  }
  return Math.abs(n) < 1e-14 ? 0 : n;
}

export class KpiEngine {
  private readonly kpis: Map<string, KpiDefinition>;
  private readonly kpiOrder: string[];
  private readonly inputKpis: string[];
  private readonly formulaKpis: string[];
  private readonly actuals: KpiMonthlyValues;
  private readonly priors: Record<string, number>;
  private readonly reactsTo: ReactsToRule[];
  private readonly guardrailDefs: Guardrail[];
  private readonly months: string[];
  private readonly executionOrder: string[];

  constructor(
    kpiDefs: KpiDefinition[],
    actuals: KpiMonthlyValues,
    reactsTo: ReactsToRule[],
    guardrails: Guardrail[],
    months: string[] = [],
    executionOrder: string[] = [
      'sliders',
      'reactsTo',
      'integer rounding (half up)',
      'max/min clamps (churn floor 0)',
      'formulas, month by month',
    ]
  ) {
    this.kpis = new Map();
    this.inputKpis = [];
    this.formulaKpis = [];
    this.actuals = actuals;
    this.priors = {};
    this.reactsTo = reactsTo;
    this.guardrailDefs = guardrails;
    this.months = months;
    this.executionOrder = executionOrder;

    for (const kpi of kpiDefs) {
      this.kpis.set(kpi.id, kpi);
      if (kpi.priorValue !== null && kpi.priorValue !== undefined) {
        this.priors[kpi.id] = kpi.priorValue;
      }
      if (kpi.kind === 'input') {
        this.inputKpis.push(kpi.id);
      } else {
        this.formulaKpis.push(kpi.id);
      }
    }

    this.kpiOrder = this.buildTopologicalOrder();
  }

  private buildTopologicalOrder(): string[] {
    const order: string[] = [];
    const state = new Map<string, 'visiting' | 'visited'>();

    const visit = (id: string, trail: string[]) => {
      const s = state.get(id);
      if (s === 'visited') return;
      if (s === 'visiting') {
        const cyclePath = [...trail, id].join(' -> ');
        throw new Error(`Circular same-month KPI dependency detected: ${cyclePath}`);
      }

      const kpi = this.kpis.get(id);
      if (!kpi) {
        throw new Error(`Unknown KPI referenced in dependency graph: "${id}"`);
      }

      state.set(id, 'visiting');

      if (kpi.kind === 'formula' && kpi.formula) {
        const deps = this.getSameMonthDeps(kpi.formula);
        for (const dep of deps) {
          visit(dep, [...trail, id]);
        }
      }

      state.set(id, 'visited');
      order.push(id);
    };

    for (const id of this.inputKpis) {
      visit(id, []);
    }
    for (const id of this.formulaKpis) {
      visit(id, []);
    }

    return order;
  }

  private getSameMonthDeps(formula: FormulaDefinition): string[] {
    const deps: string[] = [];
    const addRef = (ref?: KpiRef | ConstRef | SignedRef) => {
      if (!ref) return;
      if ('kpi' in ref && (ref.lag === undefined || ref.lag === 0)) {
        deps.push(ref.kpi);
      }
    };

    if (formula.num) addRef(formula.num);
    if (formula.den) addRef(formula.den);
    if (formula.factors) formula.factors.forEach((f) => addRef(f));
    if (formula.inputs) formula.inputs.forEach((i) => addRef(i));
    if (formula.on) addRef(formula.on);
    if (formula.base) deps.push(formula.base);

    return deps;
  }

  /**
   * Validate an incoming lever dictionary.
   * Allows any finite change >= -1.0 (-100%), rejecting only undefined inputs:
   * - non-object / invalid types / NaN / Infinity
   * - unknown KPIs or non-lever KPIs
   * - fractional changes < -1.0 (which imply negative prices/spend/headcounts)
   */
  validateLevers(levers: LeverSet): void {
    if (!levers || typeof levers !== 'object' || Array.isArray(levers)) {
      throw new SimulationInputError('Levers payload must be a plain object');
    }
    for (const [kpiId, val] of Object.entries(levers)) {
      const kpi = this.kpis.get(kpiId);
      if (!kpi) {
        throw new SimulationInputError(`Unknown lever KPI: "${kpiId}"`);
      }
      if (!kpi.isLever || kpi.kind !== 'input') {
        throw new SimulationInputError(`KPI "${kpiId}" is not an adjustable lever`);
      }
      if (typeof val !== 'number' || !Number.isFinite(val)) {
        throw new SimulationInputError(
          `Invalid value for lever "${kpiId}": must be a finite number`
        );
      }
      if (val < -1.0) {
        throw new SimulationInputError(
          `Lever "${kpiId}" value ${val} (< -1.0 / -100%) is undefined because prices, spend, and headcounts cannot be negative`
        );
      }
    }
  }

  computeBaseline(): ScenarioComputation {
    return this.computeScenario({});
  }

  computeScenario(levers: LeverSet): ScenarioComputation {
    this.validateLevers(levers);

    const monthCount = this.months.length > 0 ? this.months.length : 12;
    const values: KpiMonthlyValues = {};
    const warningMap = new Map<string, SimulationWarning>();

    for (const id of this.inputKpis) {
      if (!this.actuals[id] || this.actuals[id].length !== monthCount) {
        throw new Error(`Missing or incomplete actuals for KPI "${id}"`);
      }
      values[id] = [...this.actuals[id]];
    }

    for (const phase of this.executionOrder) {
      const p = phase.toLowerCase();
      if (p.includes('slider')) {
        this.applySliders(values, levers, monthCount);
      } else if (p.includes('reactsto')) {
        this.applyReactsTo(values, monthCount, warningMap);
      } else if (p.includes('integer')) {
        this.applyIntegerRounding(values, monthCount);
      } else if (p.includes('clamp')) {
        this.applyClamps(values, monthCount, warningMap);
      } else if (p.includes('formula')) {
        this.evaluateFormulas(values, monthCount, warningMap);
      }
    }

    const fyValues = this.computeAllFyValues(values, warningMap);
    this.detectDegenerateOutputs(values, fyValues, warningMap);
    const guardrails = this.checkGuardrails(values, fyValues, monthCount);

    return {
      monthlyValues: values,
      fyValues,
      guardrails,
      warnings: Array.from(warningMap.values()),
    };
  }

  private applySliders(values: KpiMonthlyValues, levers: LeverSet, monthCount: number): void {
    for (const [kpiId, pctChange] of Object.entries(levers)) {
      if (pctChange === 0) continue;
      const kpi = this.kpis.get(kpiId)!;
      const effectiveFrom = kpi.effectiveFromMonth ?? 1;
      for (let m = 0; m < monthCount; m++) {
        const monthNum = m + 1;
        if (monthNum >= effectiveFrom) {
          values[kpiId][m] = sanitizeFloat(this.actuals[kpiId][m] * (1 + pctChange));
        }
      }
    }
  }

  /**
   * Mathematically rigorous reactsTo application:
   *   target_month *= (source_scenario / source_actual) ^ elasticity
   * When source_scenario === 0 (i.e., lever = -100%, ratio = 0):
   *   - elasticity > 0  => limit as r->0+ is 0, so target_month = 0
   *   - elasticity === 0 => 0^0 = 1, target_month unchanged
   *   - elasticity < 0  => limit as r->0+ is +infinity (undefined singularity -> error)
   */
  private applyReactsTo(
    values: KpiMonthlyValues,
    monthCount: number,
    warningMap: Map<string, SimulationWarning>
  ): void {
    for (const rule of this.reactsTo) {
      if (!this.kpis.has(rule.source) || !this.kpis.has(rule.target)) continue;
      for (let m = 0; m < monthCount; m++) {
        const sourceActual = this.actuals[rule.source][m];
        const sourceScenario = values[rule.source][m];
        if (sourceActual === 0) {
          if (sourceScenario !== 0) {
            throw new SimulationInputError(
              `Cross-elasticity undefined: baseline ${rule.source} is 0 in month ${m + 1}`
            );
          }
          continue;
        }
        if (sourceScenario !== sourceActual) {
          const ratio = sourceScenario / sourceActual;
          if (ratio < 0) {
            throw new SimulationInputError(
              `Cross-elasticity undefined for negative ratio (${rule.source} -> ${rule.target}) in month ${m + 1}`
            );
          }
          if (ratio === 0) {
            if (rule.elasticity < 0) {
              throw new SimulationInputError(
                `Cross-elasticity singularity: 0^(${rule.elasticity}) is undefined for ${rule.source} -> ${rule.target} in month ${m + 1}`
              );
            }
            if (rule.elasticity > 0) {
              values[rule.target][m] = 0;
              warningMap.set(`zero_elasticity_${rule.source}_${rule.target}`, {
                code: 'zero_elasticity',
                title: `Degenerate Elasticity Boundary (${rule.source} = 0)`,
                detail: `${rule.source} dropped to 0 (-100%), collapsing ${rule.target} to 0 via 0^${rule.elasticity} = 0.`,
              });
            }
            // elasticity === 0 => factor 1, unchanged
          } else {
            values[rule.target][m] = sanitizeFloat(
              values[rule.target][m] * Math.pow(ratio, rule.elasticity)
            );
          }
        }
      }
    }
  }

  private applyIntegerRounding(values: KpiMonthlyValues, monthCount: number): void {
    for (const id of this.inputKpis) {
      const kpi = this.kpis.get(id)!;
      if (!kpi.isInteger) continue;
      for (let m = 0; m < monthCount; m++) {
        values[id][m] = roundHalfUp(values[id][m]);
      }
    }
  }

  private applyClamps(
    values: KpiMonthlyValues,
    monthCount: number,
    warningMap: Map<string, SimulationWarning>
  ): void {
    for (const id of this.inputKpis) {
      const kpi = this.kpis.get(id)!;
      let clampedLow = false;
      let clampedHigh = false;
      for (let m = 0; m < monthCount; m++) {
        let v = values[id][m];
        if (kpi.minValue !== null && kpi.minValue !== undefined && v < kpi.minValue) {
          v = kpi.minValue;
          clampedLow = true;
        }
        if (kpi.maxValue !== null && kpi.maxValue !== undefined && v > kpi.maxValue) {
          v = kpi.maxValue;
          clampedHigh = true;
        }
        values[id][m] = v;
      }
      if (clampedLow) {
        warningMap.set(`clamp_min_${id}`, {
          code: 'input_clamped_min',
          title: `${kpi.label} Clamped at Floor (${kpi.minValue})`,
          detail: `Scenario adjustment pushed ${kpi.label} below its minimum bound (${kpi.minValue}); values were clamped.`,
        });
      }
      if (clampedHigh) {
        warningMap.set(`clamp_max_${id}`, {
          code: 'input_clamped_max',
          title: `${kpi.label} Clamped at Cap (${kpi.maxValue})`,
          detail: `Scenario adjustment pushed ${kpi.label} above its hard cap (${kpi.maxValue}); values were clamped.`,
        });
      }
    }
  }

  private evaluateFormulas(
    values: KpiMonthlyValues,
    monthCount: number,
    warningMap: Map<string, SimulationWarning>
  ): void {
    const formulaOrder = this.kpiOrder.filter(
      (id) => this.kpis.get(id)!.kind === 'formula'
    );

    for (const id of formulaOrder) {
      values[id] = new Array(monthCount).fill(0);
    }

    for (let m = 0; m < monthCount; m++) {
      for (const id of formulaOrder) {
        const kpi = this.kpis.get(id)!;
        values[id][m] = sanitizeFloat(this.computeFormulaMonth(kpi, values, m, warningMap));
      }
    }
  }

  private getValue(
    kpiId: string,
    values: KpiMonthlyValues,
    monthIndex: number,
    lag: number = 0
  ): number {
    const targetMonth = monthIndex - lag;
    if (targetMonth < 0) {
      if (targetMonth === -1 && this.priors[kpiId] !== undefined) {
        return this.priors[kpiId];
      }
      return this.priors[kpiId] ?? 0;
    }
    return values[kpiId]?.[targetMonth] ?? 0;
  }

  private resolveRef(
    ref: KpiRef | SignedRef,
    values: KpiMonthlyValues,
    monthIndex: number
  ): number {
    return this.getValue(ref.kpi, values, monthIndex, ref.lag ?? 0);
  }

  private computeFormulaMonth(
    kpi: KpiDefinition,
    values: KpiMonthlyValues,
    monthIndex: number,
    warningMap: Map<string, SimulationWarning>
  ): number {
    const f = kpi.formula;
    if (!f) throw new Error(`Missing formula definition for "${kpi.id}"`);

    let result = 0;

    switch (f.op) {
      case 'ratio': {
        const num = this.resolveRef(f.num!, values, monthIndex);
        const den = this.resolveRef(f.den!, values, monthIndex);
        if (den === 0) {
          warningMap.set(`zero_den_${kpi.id}`, {
            code: 'zero_denominator',
            title: `Degenerate Ratio on ${kpi.label}`,
            detail: `Denominator (${f.den!.kpi}) reached 0 (e.g., in Month ${monthIndex + 1}); ${kpi.label} resolves to 0.`,
          });
          result = 0;
        } else {
          result = (num / den) * (f.scale ?? 1);
        }
        break;
      }

      case 'product': {
        let prod = 1;
        for (const factor of f.factors!) {
          if ('const' in factor) {
            prod *= factor.const;
          } else {
            prod *= this.resolveRef(factor, values, monthIndex);
          }
        }
        result = prod * (f.scale ?? 1);
        break;
      }

      case 'sum': {
        let total = 0;
        for (const inp of f.inputs!) {
          total += this.resolveRef(inp, values, monthIndex) * inp.sign;
        }
        result = total;
        break;
      }

      case 'step': {
        const onVal = this.resolveRef(f.on!, values, monthIndex);
        const steps = f.steps!;
        result = steps[steps.length - 1].value;
        for (const step of steps) {
          if (step.upTo === null) {
            result = step.value;
            break;
          }
          const matches = f.inclusive ? onVal <= step.upTo : onVal < step.upTo;
          if (matches) {
            result = step.value;
            break;
          }
        }
        break;
      }

      case 'ytd_tax': {
        const rate = f.rate!;
        const baseId = f.base!;
        let ytdBase = 0;
        for (let i = 0; i <= monthIndex; i++) {
          ytdBase += values[baseId][i];
        }
        let ytdTaxPrior = 0;
        for (let i = 0; i < monthIndex; i++) {
          ytdTaxPrior += values[kpi.id][i];
        }
        const cumTaxDue = Math.max(0, rate * ytdBase);
        result = cumTaxDue - ytdTaxPrior;
        break;
      }

      default:
        throw new Error(`Unsupported formula op "${(f as any).op}" on KPI "${kpi.id}"`);
    }

    if (kpi.isInteger) {
      result = roundHalfUp(result);
    }

    return result;
  }

  private computeAllFyValues(
    values: KpiMonthlyValues,
    warningMap: Map<string, SimulationWarning>
  ): KpiFyValues {
    const fyValues: KpiFyValues = {};
    const recomputes: string[] = [];

    for (const id of this.kpiOrder) {
      const kpi = this.kpis.get(id)!;
      if (kpi.fyAggregation === 'recompute') {
        recomputes.push(id);
      } else {
        fyValues[id] = sanitizeFloat(this.aggregateFy(kpi, values[id]));
      }
    }

    for (const id of recomputes) {
      const kpi = this.kpis.get(id)!;
      fyValues[id] = sanitizeFloat(this.recomputeFyFormula(kpi, fyValues, warningMap));
    }

    return fyValues;
  }

  private aggregateFy(kpi: KpiDefinition, monthly: number[]): number {
    switch (kpi.fyAggregation) {
      case 'sum':
        return monthly.reduce((acc, v) => acc + v, 0);
      case 'last':
        return monthly[monthly.length - 1];
      case 'mean':
        return monthly.reduce((acc, v) => acc + v, 0) / monthly.length;
      default:
        throw new Error(`Unknown fy rule "${kpi.fyAggregation}" on "${kpi.id}"`);
    }
  }

  private recomputeFyFormula(
    kpi: KpiDefinition,
    fyValues: KpiFyValues,
    warningMap: Map<string, SimulationWarning>
  ): number {
    const f = kpi.formula;
    if (!f) throw new Error(`Cannot recompute input KPI "${kpi.id}"`);

    switch (f.op) {
      case 'ratio': {
        const num = fyValues[f.num!.kpi];
        const den = fyValues[f.den!.kpi];
        if (den === 0) {
          warningMap.set(`fy_zero_den_${kpi.id}`, {
            code: 'fy_zero_denominator',
            title: `Degenerate FY Ratio on ${kpi.label}`,
            detail: `FY ${f.den!.kpi} is 0; ${kpi.label} resolves to 0%.`,
          });
          return 0;
        }
        return (num / den) * (f.scale ?? 1);
      }
      case 'product': {
        let prod = 1;
        for (const fac of f.factors!) {
          prod *= 'const' in fac ? fac.const : fyValues[fac.kpi];
        }
        return prod * (f.scale ?? 1);
      }
      case 'sum': {
        return f.inputs!.reduce((acc, inp) => acc + fyValues[inp.kpi] * inp.sign, 0);
      }
      case 'ytd_tax': {
        return Math.max(0, (f.rate ?? 0) * fyValues[f.base!]);
      }
      default:
        throw new Error(`Unsupported recompute op "${f.op}" on "${kpi.id}"`);
    }
  }

  /**
   * Detect economic degeneracies (zero revenue, zero headcount, zero subscribers, etc.).
   */
  private detectDegenerateOutputs(
    monthlyValues: KpiMonthlyValues,
    fyValues: KpiFyValues,
    warningMap: Map<string, SimulationWarning>
  ): void {
    if (fyValues.total_revenue !== undefined && fyValues.total_revenue <= 0) {
      warningMap.set('zero_total_revenue', {
        code: 'zero_total_revenue',
        title: 'Zero Full-Year Revenue (Degenerate Scenario)',
        detail: 'Both product and service revenue collapsed to $0K for the fiscal year.',
      });
    }
    if (monthlyValues.closing_subscribers?.some((v) => v < 0)) {
      warningMap.set('negative_subscribers', {
        code: 'negative_subscribers',
        title: 'Runaway Churn (>100%) — Negative / Oscillating Subscribers',
        detail:
          'Extreme price elasticity pushed monthly churn above 100% (JSON specifies a 0% floor on churn_pct but no upper cap), causing closing subscribers to turn negative or oscillate.',
      });
    } else if (monthlyValues.closing_subscribers?.some((v) => v === 0)) {
      warningMap.set('zero_subscribers', {
        code: 'zero_subscribers',
        title: 'Subscriber Base Depleted to Zero',
        detail: 'Monthly closing subscribers reached 0 during the fiscal year.',
      });
    }
    if (monthlyValues.total_heads?.some((v) => v <= 0)) {
      warningMap.set('zero_heads', {
        code: 'zero_heads',
        title: 'Zero Staff Headcount',
        detail: 'Total headcount reached 0 people in one or more months (fixed office rent still applies).',
      });
    }
  }

  private checkGuardrails(
    monthlyValues: KpiMonthlyValues,
    fyValues: KpiFyValues,
    monthCount: number
  ): GuardrailResult[] {
    return this.guardrailDefs.map((g) => {
      const hasMin = g.min !== null && g.min !== undefined;
      const hasMax = g.max !== null && g.max !== undefined;
      const operator: 'min' | 'max' | 'range' =
        hasMin && hasMax ? 'range' : hasMin ? 'min' : 'max';

      if (g.scope === 'year') {
        const actual = fyValues[g.kpiId];
        let passed = true;
        let limit = 0;
        let headroom = 0;

        if (hasMin && hasMax) {
          passed = actual >= g.min! && actual <= g.max!;
          limit = actual < g.min! ? g.min! : g.max!;
          headroom = Math.min(actual - g.min!, g.max! - actual);
        } else if (hasMin) {
          limit = g.min!;
          passed = actual >= limit;
          headroom = actual - limit;
        } else if (hasMax) {
          limit = g.max!;
          passed = actual <= limit;
          headroom = limit - actual;
        }

        return {
          id: g.id,
          label: g.label,
          kpiId: g.kpiId,
          scope: g.scope,
          passed,
          actual: sanitizeFloat(actual),
          limit,
          operator,
          headroom: sanitizeFloat(headroom),
          breachMonth: passed ? null : monthCount,
          breachMonthLabel: passed ? null : this.months[monthCount - 1] ?? `Month ${monthCount}`,
          failedMonths: passed ? [] : [monthCount],
        };
      } else {
        const monthly = monthlyValues[g.kpiId];
        const failedMonths: number[] = [];
        let worstActual = monthly[0];
        let worstHeadroom = Infinity;
        let limit = hasMin ? g.min! : g.max!;

        for (let m = 0; m < monthCount; m++) {
          const val = monthly[m];
          let h = Infinity;
          if (hasMin && hasMax) {
            h = Math.min(val - g.min!, g.max! - val);
            if (val < g.min! || val > g.max!) {
              failedMonths.push(m + 1);
            }
          } else if (hasMin) {
            h = val - g.min!;
            if (val < g.min!) failedMonths.push(m + 1);
          } else if (hasMax) {
            h = g.max! - val;
            if (val > g.max!) failedMonths.push(m + 1);
          }

          if (h < worstHeadroom) {
            worstHeadroom = h;
            worstActual = val;
            if (hasMin && hasMax) {
              limit = val < g.min! ? g.min! : g.max!;
            }
          }
        }

        const passed = failedMonths.length === 0;
        const firstBreach = failedMonths.length > 0 ? failedMonths[0] : null;

        return {
          id: g.id,
          label: g.label,
          kpiId: g.kpiId,
          scope: g.scope,
          passed,
          actual: sanitizeFloat(worstActual),
          limit,
          operator,
          headroom: sanitizeFloat(worstHeadroom),
          breachMonth: firstBreach,
          breachMonthLabel:
            firstBreach !== null
              ? this.months[firstBreach - 1] ?? `Month ${firstBreach}`
              : null,
          failedMonths,
        };
      }
    });
  }

  simulateFull(levers: LeverSet): FullSimulationResponse {
    const baseline = this.computeBaseline();
    const scenario = this.computeScenario(levers);

    const deltas: Record<string, KpiDelta> = {};
    for (const id of this.kpiOrder) {
      const kpi = this.kpis.get(id)!;
      const b = baseline.fyValues[id];
      const s = scenario.fyValues[id];
      const deltaAbs = sanitizeFloat(s - b);
      const deltaPct = b !== 0 ? sanitizeFloat(((s - b) / Math.abs(b)) * 100) : null;
      deltas[id] = {
        kpiId: id,
        label: kpi.label,
        unit: kpi.unit,
        goodWhen: kpi.goodWhen,
        fyRule: kpi.fyAggregation,
        baselineFy: b,
        scenarioFy: s,
        deltaAbs,
        deltaPct,
      };
    }

    const waterfall = this.buildNetProfitWaterfall(baseline, scenario);
    const explanation = this.buildCausalExplanation(levers, baseline, scenario);

    return {
      months: this.months,
      levers,
      baseline: {
        monthlyValues: baseline.monthlyValues,
        fyValues: baseline.fyValues,
        guardrails: baseline.guardrails,
      },
      scenario: {
        monthlyValues: scenario.monthlyValues,
        fyValues: scenario.fyValues,
      },
      deltas,
      guardrails: scenario.guardrails,
      warnings: scenario.warnings,
      waterfall,
      explanation,
    };
  }

  private buildNetProfitWaterfall(
    baseline: ScenarioComputation,
    scenario: ScenarioComputation
  ): WaterfallDriver[] {
    const d = (id: string) => scenario.fyValues[id] - baseline.fyValues[id];
    return [
      {
        id: 'baseline_net_profit',
        label: 'Baseline Net Profit',
        impactUsdK: baseline.fyValues.net_profit,
        category: 'subtotal',
      },
      {
        id: 'product_revenue',
        label: 'Product Revenue',
        impactUsdK: sanitizeFloat(d('product_revenue')),
        category: 'revenue',
      },
      {
        id: 'service_revenue',
        label: 'Service Revenue',
        impactUsdK: sanitizeFloat(d('service_revenue')),
        category: 'revenue',
      },
      {
        id: 'salaries',
        label: 'Salaries (Loaded)',
        impactUsdK: sanitizeFloat(-d('salaries')),
        category: 'expense',
      },
      {
        id: 'marketing_spend',
        label: 'Marketing Spend',
        impactUsdK: sanitizeFloat(-d('marketing_spend')),
        category: 'expense',
      },
      {
        id: 'rent_utilities',
        label: 'Rent & Utilities',
        impactUsdK: sanitizeFloat(-d('rent_utilities')),
        category: 'expense',
      },
      {
        id: 'hosting',
        label: 'Hosting',
        impactUsdK: sanitizeFloat(-d('hosting')),
        category: 'expense',
      },
      {
        id: 'gateway_fees',
        label: 'Gateway Fees',
        impactUsdK: sanitizeFloat(-d('gateway_fees')),
        category: 'expense',
      },
      {
        id: 'tax',
        label: 'Income Tax (25% YTD)',
        impactUsdK: sanitizeFloat(-d('tax')),
        category: 'tax',
      },
      {
        id: 'scenario_net_profit',
        label: 'Scenario Net Profit',
        impactUsdK: scenario.fyValues.net_profit,
        category: 'subtotal',
      },
    ];
  }

  private buildCausalExplanation(
    levers: LeverSet,
    baseline: ScenarioComputation,
    scenario: ScenarioComputation
  ): CausalStep[] {
    const steps: CausalStep[] = [];
    const active = Object.entries(levers).filter(([, v]) => v !== 0);

    if (active.length === 0) {
      steps.push({
        title: 'Baseline Status Quo',
        detail: `No levers adjusted. FY Net Profit is $${baseline.fyValues.net_profit.toFixed(2)}K (${baseline.fyValues.net_margin_pct.toFixed(2)}% margin) with ${Math.round(baseline.fyValues.closing_subscribers).toLocaleString()} March subscribers.`,
        impactDirection: 'neutral',
      });
      return steps;
    }

    const fmtPct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1).replace(/\.0$/, '')}%`;

    if (levers.marketing_spend) {
      const mDelta = scenario.fyValues.marketing_spend - baseline.fyValues.marketing_spend;
      const cacPct = ((scenario.fyValues.cac / baseline.fyValues.cac) - 1) * 100;
      const newSubDelta = scenario.fyValues.new_subscribers - baseline.fyValues.new_subscribers;
      steps.push({
        title: `Marketing Spend ${fmtPct(levers.marketing_spend)}`,
        detail: `FY marketing changes by ${mDelta >= 0 ? '+' : ''}$${mDelta.toFixed(1)}K. Via CAC elasticity (0.35), average CAC shifts ${cacPct >= 0 ? '+' : ''}${cacPct.toFixed(1)}%. Because acquisition has a 1-month lag (prior month spend/CAC), new subscribers change by ${newSubDelta >= 0 ? '+' : ''}${Math.round(newSubDelta)} from Month 2 onward.`,
        impactDirection: newSubDelta >= 0 ? 'positive' : 'negative',
      });
    }

    if (levers.arpu) {
      const churnPctChange = ((scenario.fyValues.churn_pct / baseline.fyValues.churn_pct) - 1) * 100;
      const prodRevDelta = scenario.fyValues.product_revenue - baseline.fyValues.product_revenue;
      const subDelta = scenario.fyValues.closing_subscribers - baseline.fyValues.closing_subscribers;
      steps.push({
        title: `Subscription Price (ARPU) ${fmtPct(levers.arpu)}`,
        detail: `ARPU triggers churn elasticity (4.0), shifting average monthly churn by ${churnPctChange >= 0 ? '+' : ''}${churnPctChange.toFixed(1)}%. Ending subscribers move by ${subDelta >= 0 ? '+' : ''}${Math.round(subDelta)}, changing Product Revenue by ${prodRevDelta >= 0 ? '+' : ''}$${prodRevDelta.toFixed(1)}K.`,
        impactDirection: prodRevDelta >= 0 ? 'positive' : 'negative',
      });
    }

    if (levers.churn_pct) {
      const churnedDelta = scenario.fyValues.churned_subscribers - baseline.fyValues.churned_subscribers;
      steps.push({
        title: `Monthly Churn Lever ${fmtPct(levers.churn_pct)}`,
        detail: `Direct churn adjustment alters annual churned subscribers by ${churnedDelta >= 0 ? '+' : ''}${Math.round(churnedDelta)} (clamped at 0% floor).`,
        impactDirection: churnedDelta <= 0 ? 'positive' : 'negative',
      });
    }

    if (levers.billable_heads || levers.nonbillable_heads) {
      const headDelta = scenario.fyValues.total_heads - baseline.fyValues.total_heads;
      const rentDelta = scenario.fyValues.rent_utilities - baseline.fyValues.rent_utilities;
      const svcDelta = scenario.fyValues.service_revenue - baseline.fyValues.service_revenue;
      const salDelta = scenario.fyValues.salaries - baseline.fyValues.salaries;
      steps.push({
        title: `Headcount & Office Capacity (${headDelta >= 0 ? '+' : ''}${Math.round(headDelta)} March heads)`,
        detail: `Integer-rounded staffing changes loaded salaries by ${salDelta >= 0 ? '+' : ''}$${salDelta.toFixed(1)}K and service revenue by ${svcDelta >= 0 ? '+' : ''}$${svcDelta.toFixed(1)}K.${rentDelta !== 0 ? ` Crossing a headcount tier triggers a $${rentDelta.toFixed(1)}K shift in step-function Rent & Utilities.` : ' Office rent tier remains unchanged.'}`,
        impactDirection: svcDelta - salDelta - rentDelta >= 0 ? 'positive' : 'negative',
      });
    }

    if (levers.utilization_pct || levers.rate_per_hour) {
      const svcDelta = scenario.fyValues.service_revenue - baseline.fyValues.service_revenue;
      const utilMax = Math.max(...scenario.monthlyValues.utilization_pct);
      steps.push({
        title: `Delivery Utilization & Hourly Rate`,
        detail: `Service revenue changes by ${svcDelta >= 0 ? '+' : ''}$${svcDelta.toFixed(1)}K. Peak monthly utilization is ${utilMax.toFixed(1)}% (policy ceiling 85%, hard cap 100%).`,
        impactDirection: utilMax > 85 ? 'negative' : svcDelta >= 0 ? 'positive' : 'negative',
      });
    }

    if (levers.ctc_per_head) {
      const salDelta = scenario.fyValues.salaries - baseline.fyValues.salaries;
      steps.push({
        title: `Salary Cost per Head ${fmtPct(levers.ctc_per_head)} (Effective Oct / Month 7)`,
        detail: `Applies only to Months 7–12 (Apr–Sep remain unchanged per effectiveFromMonth=7), shifting loaded annual salaries by ${salDelta >= 0 ? '+' : ''}$${salDelta.toFixed(1)}K.`,
        impactDirection: salDelta <= 0 ? 'positive' : 'negative',
      });
    }

    const npDelta = scenario.fyValues.net_profit - baseline.fyValues.net_profit;
    const failed = scenario.guardrails.filter((g) => !g.passed);
    steps.push({
      title: `Bottom-Line Impact: ${npDelta >= 0 ? '+' : ''}$${npDelta.toFixed(2)}K Net Profit`,
      detail:
        failed.length === 0
          ? `FY Net Profit moves to $${scenario.fyValues.net_profit.toFixed(2)}K (${scenario.fyValues.net_margin_pct.toFixed(2)}% margin) and passes all ${scenario.guardrails.length} bank guardrails.`
          : `FY Net Profit moves to $${scenario.fyValues.net_profit.toFixed(2)}K, but BREACHES ${failed.length} bank guardrail(s): ${failed.map((f) => f.label).join('; ')}.`,
      impactDirection: failed.length > 0 ? 'negative' : npDelta >= 0 ? 'positive' : 'negative',
    });

    return steps;
  }

  getKpiDefinitions(): KpiDefinition[] {
    return this.kpiOrder.map((id) => this.kpis.get(id)!);
  }
}
