/**
 * Express REST API for Profit What-If Simulator
 * Reads definitions, actuals, rules, and guardrails exclusively from SQLite.
 * Delegates all deterministic math to KpiEngine.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import { getDb, DEFAULT_DB_PATH } from './database';
import { loadModelFromDb } from './model-loader';
import { FormulaDefinition, FullSimulationResponse, KpiDefinition, LeverSet, SimulationInputError } from './engine';
import { optimizeLevers, type OptimizeOptions } from './optimizer';

export const UI_SLIDER_BOUNDS = { min: -1.0, max: 1.0, step: 0.01 };

function buildMonthlySeries(
  months: string[],
  kpiDefs: KpiDefinition[],
  sim: FullSimulationResponse
) {
  return months.map((mLabel, idx) => {
    const baselineMonth: Record<string, number> = {};
    const scenarioMonth: Record<string, number> = {};
    for (const k of kpiDefs) {
      baselineMonth[k.id] = sim.baseline.monthlyValues[k.id][idx];
      scenarioMonth[k.id] = sim.scenario.monthlyValues[k.id][idx];
    }
    return {
      monthIndex: idx + 1,
      month: mLabel,
      baseline: baselineMonth,
      scenario: scenarioMonth,
    };
  });
}

export function formatFormulaDescription(kpi: KpiDefinition): string {
  if (kpi.kind === 'input') {
    const notes: string[] = ['Historical monthly input'];
    if (kpi.effectiveFromMonth > 1) notes.push(`lever effective from Month ${kpi.effectiveFromMonth}`);
    if (kpi.isInteger) notes.push('rounded half-up to integer');
    if (kpi.minValue !== null && kpi.minValue !== undefined) notes.push(`min ${kpi.minValue}`);
    if (kpi.maxValue !== null && kpi.maxValue !== undefined) notes.push(`max ${kpi.maxValue}`);
    return notes.join(' · ');
  }

  const f: FormulaDefinition | null = kpi.formula;
  if (!f) return '';
  const fmtRef = (r: { kpi: string; lag?: number }) =>
    r.lag ? `${r.kpi}[t-${r.lag}]` : `${r.kpi}[t]`;

  switch (f.op) {
    case 'ratio': {
      const scaleStr = f.scale && f.scale !== 1 ? ` * ${f.scale}` : '';
      return `(${fmtRef(f.num!)} / ${fmtRef(f.den!)})${scaleStr}`;
    }
    case 'product': {
      const parts = (f.factors || []).map((fac) =>
        'const' in fac ? String(fac.const) : fmtRef(fac)
      );
      const scaleStr = f.scale && f.scale !== 1 ? ` * ${f.scale}` : '';
      return `${parts.join(' * ')}${scaleStr}`;
    }
    case 'sum': {
      return (f.inputs || [])
        .map((inp, idx) => {
          const ref = fmtRef(inp);
          if (idx === 0) return inp.sign < 0 ? `-${ref}` : ref;
          return inp.sign < 0 ? ` - ${ref}` : ` + ${ref}`;
        })
        .join('');
    }
    case 'step': {
      const tiers = (f.steps || [])
        .map((s) => (s.upTo === null ? `else -> ${s.value}` : `<=${s.upTo} -> ${s.value}`))
        .join('; ');
      return `step(${fmtRef(f.on!)}; ${tiers})`;
    }
    case 'ytd_tax': {
      return `max(0, ${(f.rate! * 100).toFixed(0)}% * YTD(${f.base!})) - prior_YTD_tax`;
    }
    default:
      return f.op;
  }
}

export function createApp(dbPath: string = DEFAULT_DB_PATH) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    try {
      const model = loadModelFromDb(dbPath);
      res.json({ status: 'ok', kpiCount: model.kpiDefs.length, fiscalYear: model.company.fiscalYear });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/meta
   * Returns company metadata, calendar months, lever configs & bounds from JSON/DB,
   * cross-elasticities, execution order, and bank guardrails.
   */
  app.get('/api/meta', (_req: Request, res: Response) => {
    try {
      const model = loadModelFromDb(dbPath);
      const levers = model.kpiDefs
        .filter((k) => k.isLever)
        .map((k) => {
          const avgActual =
            model.actuals[k.id].reduce((a, b) => a + b, 0) / model.actuals[k.id].length;
          return {
            id: k.id,
            label: k.label,
            unit: k.unit,
            goodWhen: k.goodWhen,
            isPrimary: !!k.isPrimaryLever,
            isInteger: k.isInteger,
            effectiveFromMonth: k.effectiveFromMonth,
            effectiveFromLabel: model.months[k.effectiveFromMonth - 1] ?? null,
            baselineAverage: avgActual,
            baselineMarch: model.actuals[k.id][model.actuals[k.id].length - 1],
            min: -1.0,
            max: k.maxValue !== null && k.maxValue !== undefined ? 1.0 : 5.0,
            uiMin: UI_SLIDER_BOUNDS.min,
            uiMax: UI_SLIDER_BOUNDS.max,
            step: UI_SLIDER_BOUNDS.step,
            defaultValue: 0,
            hardMin: k.minValue ?? 0,
            hardMax: k.maxValue ?? null,
          };
        });

      res.json({
        company: model.company.company,
        fiscalYear: model.company.fiscalYear,
        currencyNote: model.company.currencyNote,
        monthIndexNote: model.company.monthIndexNote,
        months: model.months,
        levers,
        reactsTo: model.reactsTo,
        guardrails: model.guardrails,
        executionOrder: model.executionOrder,
        rulesMeta: model.rulesMeta,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/kpis
   * Returns all 27 KPI definitions with computed formula descriptions for the audit table.
   */
  app.get('/api/kpis', (_req: Request, res: Response) => {
    try {
      const model = loadModelFromDb(dbPath);
      const enriched = model.kpiDefs.map((k) => ({
        ...k,
        formulaText: formatFormulaDescription(k),
      }));
      res.json(enriched);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/simulate
   * Body: { levers: Record<string, number> } (also accepts { sliders } alias)
   */
  app.post('/api/simulate', (req: Request, res: Response) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object with a "levers" map.' });
      }

      const rawLevers = body.levers ?? body.sliders;
      if (rawLevers === undefined || rawLevers === null || typeof rawLevers !== 'object' || Array.isArray(rawLevers)) {
        return res.status(400).json({ error: '"levers" must be an object mapping lever KPI IDs to fractional changes.' });
      }

      const levers: LeverSet = rawLevers;
      const model = loadModelFromDb(dbPath);

      let sim;
      try {
        sim = model.engine.simulateFull(levers);
      } catch (simErr: any) {
        if (simErr instanceof SimulationInputError) {
          return res.status(400).json({ error: simErr.message });
        }
        throw simErr;
      }

      const monthly = buildMonthlySeries(model.months, model.kpiDefs, sim);

      res.json({
        ...sim,
        monthly,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/optimize
   * Searches the lever space within UI slider bounds to maximize net_profit
   * while passing all guardrails.
   */
  app.post('/api/optimize', (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'Request body must be a JSON object.' });
      }

      const model = loadModelFromDb(dbPath);
      const opts: OptimizeOptions = {
        defaultBound: { min: UI_SLIDER_BOUNDS.min, max: UI_SLIDER_BOUNDS.max },
        step: typeof body.step === 'number' ? body.step : UI_SLIDER_BOUNDS.step,
        bounds: body.bounds,
        targetKpi: typeof body.targetKpi === 'string' ? body.targetKpi : 'net_profit',
      };

      let result;
      try {
        result = optimizeLevers(model.engine, opts);
      } catch (optErr: any) {
        if (optErr instanceof SimulationInputError) {
          return res.status(400).json({ error: optErr.message });
        }
        throw optErr;
      }

      const monthly = buildMonthlySeries(model.months, model.kpiDefs, result.simulation);

      res.json({
        feasible: result.feasible,
        bestLevers: result.bestLevers,
        stats: result.stats,
        simulation: {
          ...result.simulation,
          monthly,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/scenarios
   * Lists saved scenarios (up to compare mode / persistent list) with summary KPIs.
   */
  app.get('/api/scenarios', (_req: Request, res: Response) => {
    try {
      const db = getDb(dbPath);
      const rows = db
        .prepare('SELECT id, name, description, levers_json, created_at, updated_at FROM scenarios ORDER BY updated_at DESC, id DESC')
        .all() as any[];

      const result = rows.map((s) => {
        const kpiResults = db
          .prepare('SELECT kpi_id, fy_actual, fy_scenario, delta_abs, delta_pct, guardrail_passed FROM scenario_results WHERE scenario_id = ?')
          .all(s.id) as any[];
        const summary: Record<string, any> = {};
        for (const kr of kpiResults) {
          summary[kr.kpi_id] = {
            fyActual: kr.fy_actual,
            fyScenario: kr.fy_scenario,
            deltaAbs: kr.delta_abs,
            deltaPct: kr.delta_pct,
          };
        }
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          levers: JSON.parse(s.levers_json),
          createdAt: s.created_at,
          updatedAt: s.updated_at,
          summary,
        };
      });
      db.close();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/scenarios
   * Saves a named scenario and persists its deterministic 27-KPI results in scenario_results.
   */
  app.post('/api/scenarios', (req: Request, res: Response) => {
    try {
      const { name, description = '', levers } = req.body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Scenario "name" is required.' });
      }
      if (!levers || typeof levers !== 'object' || Array.isArray(levers)) {
        return res.status(400).json({ error: 'Scenario "levers" object is required.' });
      }

      const model = loadModelFromDb(dbPath);
      let sim;
      try {
        sim = model.engine.simulateFull(levers);
      } catch (simErr: any) {
        if (simErr instanceof SimulationInputError) {
          return res.status(400).json({ error: simErr.message });
        }
        throw simErr;
      }
      const allPassed = sim.guardrails.every((g) => g.passed) ? 1 : 0;

      const db = getDb(dbPath);
      try {
        const cleanLevers: LeverSet = {};
        for (const [k, v] of Object.entries(levers)) {
          if (typeof v === 'number' && v !== 0) cleanLevers[k] = v;
        }

        const tx = db.transaction(() => {
          const info = db
            .prepare(
              `INSERT INTO scenarios (name, description, levers_json) VALUES (?, ?, ?)`
            )
            .run(name.trim(), String(description).trim(), JSON.stringify(cleanLevers));

          const scenarioId = Number(info.lastInsertRowid);
          const insertRes = db.prepare(`
            INSERT INTO scenario_results (
              scenario_id, kpi_id, fy_actual, fy_scenario, delta_abs, delta_pct, monthly_scenario_json, guardrail_passed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const kpi of model.kpiDefs) {
            const d = sim.deltas[kpi.id];
            insertRes.run(
              scenarioId,
              kpi.id,
              d.baselineFy,
              d.scenarioFy,
              d.deltaAbs,
              d.deltaPct,
              JSON.stringify(sim.scenario.monthlyValues[kpi.id]),
              allPassed
            );
          }
          return scenarioId;
        });

        const scenarioId = tx();
        res.status(201).json({
          id: scenarioId,
          name: name.trim(),
          description: String(description).trim(),
          levers: cleanLevers,
          guardrailsPassed: allPassed === 1,
        });
      } catch (dbErr: any) {
        if (String(dbErr.message).includes('UNIQUE constraint failed')) {
          return res.status(409).json({ error: `A scenario named "${name.trim()}" already exists.` });
        }
        throw dbErr;
      } finally {
        db.close();
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/scenarios/:id
   */
  app.delete('/api/scenarios/:id', (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid scenario ID.' });
      }
      const db = getDb(dbPath);
      const info = db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
      db.close();
      if (info.changes === 0) {
        return res.status(404).json({ error: 'Scenario not found.' });
      }
      res.json({ deleted: true, id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

if (require.main === module) {
  const PORT = Number(process.env.PORT || 4000);
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`Profit What-If Simulator API listening on http://localhost:${PORT}`);
  });
}
