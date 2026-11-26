/**
 * Loads model definitions, actuals, scenario rules, and guardrails from SQLite
 * and instantiates a pure KpiEngine.
 */
import { getDb, DEFAULT_DB_PATH } from './database';
import {
  KpiEngine,
  KpiDefinition,
  KpiMonthlyValues,
  ReactsToRule,
  Guardrail,
} from './engine';

export interface LoadedModel {
  company: {
    company: string;
    currencyNote: string;
    fiscalYear: string;
    monthIndexNote: string;
  };
  months: string[];
  kpiDefs: KpiDefinition[];
  actuals: KpiMonthlyValues;
  reactsTo: ReactsToRule[];
  guardrails: Guardrail[];
  executionOrder: string[];
  rulesMeta: {
    slidersDescription: string;
    lagDescription: string;
    reactsToNote: string;
    fyRules: Record<string, string>;
  };
  engine: KpiEngine;
}

export function loadModelFromDb(dbPath: string = DEFAULT_DB_PATH): LoadedModel {
  const db = getDb(dbPath);

  const comp = db
    .prepare('SELECT company, currency_note, fiscal_year, month_index_note FROM company_meta WHERE id = 1')
    .get() as any;

  if (!comp) {
    db.close();
    throw new Error('Database is empty. Run "npm run seed" first.');
  }

  const months = (
    db.prepare('SELECT month_label FROM months ORDER BY month_index').all() as any[]
  ).map((r) => r.month_label);

  const kpiRows = db
    .prepare('SELECT * FROM kpi_definitions ORDER BY sort_order')
    .all() as any[];

  const kpiDefs: KpiDefinition[] = kpiRows.map((row) => ({
    id: row.id,
    sortOrder: row.sort_order,
    label: row.label,
    kind: row.kind,
    unit: row.unit,
    goodWhen: row.good_when,
    fyAggregation: row.fy_rule,
    isLever: row.is_lever === 1,
    isPrimaryLever: row.is_primary_lever === 1,
    isInteger: row.is_integer === 1,
    minValue: row.min_value,
    maxValue: row.max_value,
    effectiveFromMonth: row.effective_from_month,
    priorValue: row.prior_value,
    formula: row.formula_json ? JSON.parse(row.formula_json) : null,
  }));

  const actualRows = db
    .prepare('SELECT kpi_id, month_index, value FROM monthly_actuals ORDER BY kpi_id, month_index')
    .all() as any[];

  const actuals: KpiMonthlyValues = {};
  for (const row of actualRows) {
    if (!actuals[row.kpi_id]) actuals[row.kpi_id] = [];
    actuals[row.kpi_id][row.month_index - 1] = row.value;
  }

  const ruleRows = db
    .prepare('SELECT * FROM scenario_rules ORDER BY rule_type, execution_order')
    .all() as any[];

  const reactsTo: ReactsToRule[] = [];
  const executionOrder: string[] = [];
  const fyRules: Record<string, string> = {};
  let slidersDescription = '';
  let lagDescription = '';
  let reactsToNote = '';

  for (const r of ruleRows) {
    if (r.rule_type === 'reacts_to') {
      reactsTo.push({
        source: r.source_kpi,
        target: r.target_kpi,
        elasticity: r.elasticity,
      });
      if (!reactsToNote && r.description) reactsToNote = r.description;
    } else if (r.rule_type === 'order') {
      executionOrder.push(r.description);
    } else if (r.rule_type === 'sliders') {
      slidersDescription = r.description;
    } else if (r.rule_type === 'lag') {
      lagDescription = r.description;
    } else if (r.rule_type === 'fy_rule') {
      fyRules[r.rule_key] = r.description;
    }
  }

  const guardrailRows = db.prepare('SELECT * FROM guardrails ORDER BY id').all() as any[];
  const guardrails: Guardrail[] = guardrailRows.map((g) => ({
    id: g.id,
    label: g.label,
    kpiId: g.kpi_id,
    scope: g.scope,
    min: g.min_value,
    max: g.max_value,
  }));

  db.close();

  const engine = new KpiEngine(
    kpiDefs,
    actuals,
    reactsTo,
    guardrails,
    months,
    executionOrder
  );

  return {
    company: {
      company: comp.company,
      currencyNote: comp.currency_note,
      fiscalYear: comp.fiscal_year,
      monthIndexNote: comp.month_index_note,
    },
    months,
    kpiDefs,
    actuals,
    reactsTo,
    guardrails,
    executionOrder,
    rulesMeta: {
      slidersDescription,
      lagDescription,
      reactsToNote,
      fyRules,
    },
    engine,
  };
}
