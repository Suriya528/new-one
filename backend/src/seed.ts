/**
 * Idempotent Database Seed Script
 * Drops & recreates schema via SQL migrations and reloads company-data.json from scratch.
 * Produces deterministic row counts and SHA-256 content checksum on every run.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, runMigrations, DEFAULT_DB_PATH } from './database';

const STANDALONE_DATA_PATH = path.resolve(__dirname, '..', '..', 'data', 'company-data.json');
const REPO_DATA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'repo-data',
  'Profit What-If Simulator',
  'data',
  'company-data.json'
);
export const DATA_PATH = fs.existsSync(STANDALONE_DATA_PATH)
  ? STANDALONE_DATA_PATH
  : REPO_DATA_PATH;

export interface SeedSummary {
  dbPath: string;
  migrationsApplied: string[];
  rowCounts: Record<string, number>;
  checksum: string;
}

const PRIMARY_CFO_LEVERS = new Set([
  'arpu',
  'marketing_spend',
  'billable_heads',
  'ctc_per_head',
]);

export function seedDatabase(dbPath: string = DEFAULT_DB_PATH): SeedSummary {
  if (!fs.existsSync(DATA_PATH)) {
    throw new Error(`Specification file not found at ${DATA_PATH}`);
  }

  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  const data = JSON.parse(raw);

  const db = getDb(dbPath);
  const migrationsApplied = runMigrations(db);

  const insertAll = db.transaction(() => {
    // 1. Company metadata
    db.prepare(
      `INSERT INTO company_meta (id, company, currency_note, fiscal_year, month_index_note)
       VALUES (1, ?, ?, ?, ?)`
    ).run(data.company, data.currencyNote, data.fiscalYear, data.monthIndexNote);

    // 2. Months
    const insertMonth = db.prepare(
      `INSERT INTO months (month_index, month_label) VALUES (?, ?)`
    );
    data.months.forEach((label: string, idx: number) => {
      insertMonth.run(idx + 1, label);
    });

    // Determine any min clamps stated in scenarioRules.order (e.g. "churn floor 0")
    const orderRules: string[] = data.scenarioRules?.order || [];
    const hasChurnFloorZero = orderRules.some((r) =>
      r.toLowerCase().includes('churn floor 0')
    );

    // 3. KPI Definitions & Monthly Actuals
    const insertKpi = db.prepare(`
      INSERT INTO kpi_definitions (
        id, sort_order, label, kind, unit, good_when, fy_rule,
        is_lever, is_primary_lever, is_integer, min_value, max_value,
        effective_from_month, prior_value, op, formula_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertActual = db.prepare(
      `INSERT INTO monthly_actuals (kpi_id, month_index, value) VALUES (?, ?, ?)`
    );

    const insertDep = db.prepare(`
      INSERT INTO kpi_dependencies (
        kpi_id, depends_on_kpi_id, dependency_role, lag, sign, const_value, elasticity, position_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    data.kpis.forEach((kpi: any, idx: number) => {
      let formulaJson: string | null = null;
      if (kpi.kind === 'formula') {
        const f: Record<string, any> = { op: kpi.op };
        if (kpi.num !== undefined) f.num = kpi.num;
        if (kpi.den !== undefined) f.den = kpi.den;
        if (kpi.scale !== undefined) f.scale = kpi.scale;
        if (kpi.factors !== undefined) f.factors = kpi.factors;
        if (kpi.inputs !== undefined) f.inputs = kpi.inputs;
        if (kpi.on !== undefined) f.on = kpi.on;
        if (kpi.steps !== undefined) f.steps = kpi.steps;
        if (kpi.inclusive !== undefined) f.inclusive = kpi.inclusive;
        if (kpi.base !== undefined) f.base = kpi.base;
        if (kpi.rate !== undefined) f.rate = kpi.rate;
        formulaJson = JSON.stringify(f);
      }

      const minValue =
        kpi.min !== undefined
          ? kpi.min
          : hasChurnFloorZero && kpi.id === 'churn_pct'
            ? 0
            : null;

      insertKpi.run(
        kpi.id,
        idx + 1,
        kpi.label,
        kpi.kind,
        kpi.unit,
        kpi.goodWhen,
        kpi.fy,
        kpi.lever ? 1 : 0,
        kpi.lever && PRIMARY_CFO_LEVERS.has(kpi.id) ? 1 : 0,
        kpi.integer ? 1 : 0,
        minValue,
        kpi.max ?? null,
        kpi.effectiveFromMonth ?? 1,
        kpi.prior ?? null,
        kpi.op ?? null,
        formulaJson
      );

      if (Array.isArray(kpi.actuals)) {
        kpi.actuals.forEach((val: number, mIdx: number) => {
          insertActual.run(kpi.id, mIdx + 1, val);
        });
      }
    });

    // 4. Populate KPI dependency edges (formula + reactsTo)
    for (const kpi of data.kpis) {
      if (kpi.kind !== 'formula') continue;
      let pos = 0;
      if (kpi.num) {
        insertDep.run(kpi.id, kpi.num.kpi, 'num', kpi.num.lag ?? 0, 1, null, null, pos++);
      }
      if (kpi.den) {
        insertDep.run(kpi.id, kpi.den.kpi, 'den', kpi.den.lag ?? 0, 1, null, null, pos++);
      }
      if (Array.isArray(kpi.factors)) {
        for (const fac of kpi.factors) {
          if ('const' in fac) {
            insertDep.run(kpi.id, null, 'factor', 0, 1, fac.const, null, pos++);
          } else {
            insertDep.run(kpi.id, fac.kpi, 'factor', fac.lag ?? 0, 1, null, null, pos++);
          }
        }
      }
      if (Array.isArray(kpi.inputs)) {
        for (const inp of kpi.inputs) {
          insertDep.run(kpi.id, inp.kpi, 'input', inp.lag ?? 0, inp.sign, null, null, pos++);
        }
      }
      if (kpi.on) {
        insertDep.run(kpi.id, kpi.on.kpi, 'step_on', kpi.on.lag ?? 0, 1, null, null, pos++);
      }
      if (kpi.base) {
        insertDep.run(kpi.id, kpi.base, 'tax_base', 0, 1, null, null, pos++);
      }
    }

    // 5. Scenario Rules
    const insertRule = db.prepare(`
      INSERT INTO scenario_rules (
        rule_type, rule_key, source_kpi, target_kpi, elasticity, execution_order, description, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertRule.run(
      'sliders',
      'sliders_rule',
      null,
      null,
      null,
      0,
      data.scenarioRules.sliders,
      JSON.stringify({ description: data.scenarioRules.sliders })
    );

    (data.scenarioRules.reactsTo || []).forEach((rt: any, idx: number) => {
      insertRule.run(
        'reacts_to',
        `${rt.source}->${rt.target}`,
        rt.source,
        rt.target,
        rt.elasticity,
        idx + 1,
        data.scenarioRules.reactsToNote || '',
        JSON.stringify(rt)
      );
      insertDep.run(rt.target, rt.source, 'reacts_to', 0, 1, null, rt.elasticity, 99);
    });

    (data.scenarioRules.order || []).forEach((step: string, idx: number) => {
      insertRule.run(
        'order',
        `step_${idx + 1}`,
        null,
        null,
        null,
        idx + 1,
        step,
        JSON.stringify({ step, order: idx + 1 })
      );
    });

    insertRule.run(
      'lag',
      'lag_rule',
      null,
      null,
      null,
      0,
      data.scenarioRules.lag,
      JSON.stringify({ description: data.scenarioRules.lag })
    );

    for (const [k, desc] of Object.entries(data.scenarioRules.fyRule || {})) {
      insertRule.run(
        'fy_rule',
        k,
        null,
        null,
        null,
        0,
        String(desc),
        JSON.stringify({ key: k, description: desc })
      );
    }

    // 6. Guardrails
    const insertGuardrail = db.prepare(`
      INSERT INTO guardrails (id, label, kpi_id, scope, min_value, max_value)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const g of data.guardrails) {
      insertGuardrail.run(g.id, g.label, g.kpi, g.scope, g.min ?? null, g.max ?? null);
    }
  });

  insertAll();

  // Compute deterministic row counts & canonical checksum across seeded tables
  const tables = [
    'company_meta',
    'months',
    'kpi_definitions',
    'kpi_dependencies',
    'monthly_actuals',
    'scenario_rules',
    'guardrails',
    'scenarios',
    'scenario_results',
  ];

  const rowCounts: Record<string, number> = {};
  const hash = crypto.createHash('sha256');

  for (const t of tables) {
    const rows = db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all();
    rowCounts[t] = rows.length;
    hash.update(t + ':' + JSON.stringify(rows) + '\n');
  }

  db.close();

  return {
    dbPath,
    migrationsApplied,
    rowCounts,
    checksum: hash.digest('hex'),
  };
}

if (require.main === module) {
  const summary = seedDatabase();
  console.log('Seed completed successfully.');
  console.log('DB:', summary.dbPath);
  console.log('Migrations:', summary.migrationsApplied.join(', '));
  console.log('Row counts:', JSON.stringify(summary.rowCounts));
  console.log('Deterministic SHA-256 checksum:', summary.checksum);
}
