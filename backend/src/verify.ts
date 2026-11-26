/**
 * CLI Verification Runner (`npm run verify`)
 * Reads scenarios.json (or a custom path passed via argv[2]), runs every scenario
 * against the SQLite-backed KpiEngine, verifies accounting identities, and prints
 * a clear executive verification table.
 */
import fs from 'fs';
import path from 'path';
import { loadModelFromDb } from './model-loader';
import { LeverSet } from './engine';

interface ScenarioSpec {
  name: string;
  levers: LeverSet;
}

function main() {
  const argPath = process.argv[2];
  const scenariosPath = argPath
    ? path.resolve(process.cwd(), argPath)
    : path.resolve(__dirname, '..', '..', 'scenarios.json');

  if (!fs.existsSync(scenariosPath)) {
    console.error(`Scenarios file not found: ${scenariosPath}`);
    process.exit(1);
  }

  const scenarios: ScenarioSpec[] = JSON.parse(fs.readFileSync(scenariosPath, 'utf-8'));
  const model = loadModelFromDb();

  const rows = scenarios.map((sc) => {
    const res = model.engine.simulateFull(sc.levers || {});
    const fy = res.scenario.fyValues;

    // Verify exact accounting identities on every scenario
    const pbtDiff = Math.abs(fy.profit_before_tax - (fy.total_revenue - fy.total_expenses));
    const netDiff = Math.abs(fy.net_profit - (fy.profit_before_tax - fy.tax));
    if (pbtDiff > 1e-4 || netDiff > 1e-4) {
      throw new Error(`Accounting identity failed on scenario "${sc.name}"`);
    }

    const failed = res.guardrails.filter((g) => !g.passed).map((g) => g.id);

    return {
      Scenario: sc.name,
      'Rev ($K)': Number(fy.total_revenue.toFixed(2)),
      'Exp ($K)': Number(fy.total_expenses.toFixed(2)),
      'PBT ($K)': Number(fy.profit_before_tax.toFixed(2)),
      'Tax ($K)': Number(fy.tax.toFixed(2)),
      'Net ($K)': Number(fy.net_profit.toFixed(2)),
      'Margin (%)': Number(fy.net_margin_pct.toFixed(2)),
      'Mar Subs': Math.round(fy.closing_subscribers),
      'Net Δ ($K)': Number(res.deltas.net_profit.deltaAbs.toFixed(2)),
      Guardrails: failed.length === 0 ? 'ALL PASS' : `FAIL: ${failed.join(', ')}`,
    };
  });

  console.log(`\nVerified ${rows.length} scenarios from ${scenariosPath}:\n`);
  console.table(rows);
}

main();
