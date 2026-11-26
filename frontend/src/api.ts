const API_BASE = '/api';

export interface LeverMeta {
  id: string;
  label: string;
  unit: 'usd_k' | 'usd' | 'pct' | 'count';
  goodWhen: 'up' | 'down' | 'neutral';
  isPrimary: boolean;
  isInteger: boolean;
  effectiveFromMonth: number;
  effectiveFromLabel: string | null;
  baselineAverage: number;
  baselineMarch: number;
  min: number;
  max: number;
  uiMin?: number;
  uiMax?: number;
  step: number;
  defaultValue: number;
  hardMin: number | null;
  hardMax: number | null;
}

export interface ReactsToRule {
  source: string;
  target: string;
  elasticity: number;
}

export interface GuardrailMeta {
  id: string;
  label: string;
  kpiId: string;
  scope: 'year' | 'every_month';
  min: number | null;
  max: number | null;
}

export interface MetaResponse {
  company: string;
  fiscalYear: string;
  currencyNote: string;
  monthIndexNote: string;
  months: string[];
  levers: LeverMeta[];
  reactsTo: ReactsToRule[];
  guardrails: GuardrailMeta[];
  executionOrder: string[];
}

export interface KpiDefinition {
  id: string;
  sortOrder: number;
  label: string;
  kind: 'input' | 'formula';
  unit: 'usd_k' | 'usd' | 'pct' | 'count';
  goodWhen: 'up' | 'down' | 'neutral';
  fyAggregation: 'sum' | 'mean' | 'last' | 'recompute';
  isLever: boolean;
  isPrimaryLever?: boolean;
  isInteger: boolean;
  effectiveFromMonth: number;
  formulaText: string;
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

export interface KpiDelta {
  kpiId: string;
  label: string;
  unit: 'usd_k' | 'usd' | 'pct' | 'count';
  goodWhen: 'up' | 'down' | 'neutral';
  fyRule: string;
  baselineFy: number;
  scenarioFy: number;
  deltaAbs: number;
  deltaPct: number | null;
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

export interface MonthlyPoint {
  monthIndex: number;
  month: string;
  baseline: Record<string, number>;
  scenario: Record<string, number>;
}

export interface SimulationWarning {
  code: string;
  title: string;
  detail: string;
}

export interface SimulationResponse {
  months: string[];
  levers: Record<string, number>;
  baseline: {
    monthlyValues: Record<string, number[]>;
    fyValues: Record<string, number>;
    guardrails: GuardrailResult[];
  };
  scenario: {
    monthlyValues: Record<string, number[]>;
    fyValues: Record<string, number>;
  };
  monthly: MonthlyPoint[];
  deltas: Record<string, KpiDelta>;
  guardrails: GuardrailResult[];
  warnings: SimulationWarning[];
  waterfall: WaterfallDriver[];
  explanation: CausalStep[];
}

export interface SavedScenario {
  id: number;
  name: string;
  description: string;
  levers: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  summary: Record<
    string,
    {
      fyActual: number;
      fyScenario: number;
      deltaAbs: number;
      deltaPct: number | null;
    }
  >;
}

export interface OptimizeResponse {
  feasible: boolean;
  bestLevers: Record<string, number>;
  stats: {
    evaluations: number;
    elapsedMs: number;
    baselineValue: number;
    optimizedValue: number;
    improvementAbs: number;
    improvementPct: number | null;
    allGuardrailsPassed: boolean;
    targetKpi: string;
  };
  simulation: SimulationResponse;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  getMeta: () => fetchJson<MetaResponse>(`${API_BASE}/meta`),
  getKpis: () => fetchJson<KpiDefinition[]>(`${API_BASE}/kpis`),
  simulate: (levers: Record<string, number>) =>
    fetchJson<SimulationResponse>(`${API_BASE}/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levers }),
    }),
  optimize: (body: Record<string, unknown> = {}) =>
    fetchJson<OptimizeResponse>(`${API_BASE}/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  getScenarios: () => fetchJson<SavedScenario[]>(`${API_BASE}/scenarios`),
  createScenario: (name: string, description: string, levers: Record<string, number>) =>
    fetchJson<{ id: number; name: string; description: string; levers: Record<string, number> }>(
      `${API_BASE}/scenarios`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, levers }),
      }
    ),
  deleteScenario: (id: number) =>
    fetchJson<{ deleted: boolean }>(`${API_BASE}/scenarios/${id}`, { method: 'DELETE' }),
};
