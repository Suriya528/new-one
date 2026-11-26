/**
 * Pure-TypeScript Multi-Lever Optimizer
 *
 * Reuses KpiEngine generically with zero hardcoded lever names, KPI values, or guardrail limits.
 * Searches the UI slider bounds using:
 *   1) 1D per-lever grid sweeps
 *   2) Seeded multi-lever exploration + best single-lever combinations
 *   3) Multi-start adaptive coordinate ascent + pairwise refinement
 *
 * Enforces all guardrails and stays strictly within a sub-2s runtime budget.
 */
import { KpiEngine, LeverSet, FullSimulationResponse, SimulationInputError } from './engine';

export interface LeverBound {
  min: number;
  max: number;
}

export interface OptimizeOptions {
  bounds?: Record<string, LeverBound>;
  defaultBound?: LeverBound;
  step?: number;
  maxTimeMs?: number;
  targetKpi?: string;
}

export interface OptimizeResult {
  feasible: boolean;
  bestLevers: LeverSet;
  simulation: FullSimulationResponse;
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
}

function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantize(val: number, step: number, min: number, max: number): number {
  const clamped = Math.max(min, Math.min(max, val));
  const snapped = Math.round(clamped / step) * step;
  const bounded = Math.max(min, Math.min(max, snapped));
  return Math.abs(bounded) < 1e-9 ? 0 : Number(bounded.toFixed(4));
}

function cleanLevers(levers: LeverSet): LeverSet {
  const out: LeverSet = {};
  for (const [k, v] of Object.entries(levers)) {
    if (Math.abs(v) >= 1e-9) {
      out[k] = Number(v.toFixed(4));
    }
  }
  return out;
}

export function optimizeLevers(
  engine: KpiEngine,
  options: OptimizeOptions = {}
): OptimizeResult {
  const startTime = performance.now();
  const step = options.step ?? 0.01;
  const defaultBound = options.defaultBound ?? { min: -1.0, max: 1.0 };
  const maxTimeMs = options.maxTimeMs ?? 1200; // Well below 2,000 ms hard ceiling
  const targetKpi = options.targetKpi ?? 'net_profit';

  if (step <= 0 || !Number.isFinite(step)) {
    throw new SimulationInputError('Optimizer step must be a positive finite number.');
  }

  const allKpis = engine.getKpiDefinitions();
  const leverDefs = allKpis.filter((k) => k.isLever && k.kind === 'input');
  if (leverDefs.length === 0) {
    throw new Error('No adjustable levers found in model definitions.');
  }
  if (!allKpis.some((k) => k.id === targetKpi)) {
    throw new SimulationInputError(`Unknown target KPI "${targetKpi}".`);
  }

  const leverIds = leverDefs.map((k) => k.id);
  const bounds: Record<string, LeverBound> = {};
  for (const id of leverIds) {
    const custom = options.bounds?.[id];
    const b = custom ?? defaultBound;
    if (
      typeof b.min !== 'number' ||
      typeof b.max !== 'number' ||
      !Number.isFinite(b.min) ||
      !Number.isFinite(b.max) ||
      b.min < -1.0 ||
      b.min > b.max
    ) {
      throw new SimulationInputError(
        `Invalid bounds for lever "${id}": min=${b.min}, max=${b.max} (requires -1.0 <= min <= max)`
      );
    }
    bounds[id] = b;
  }

  if (options.bounds) {
    for (const k of Object.keys(options.bounds)) {
      if (!bounds[k]) {
        throw new SimulationInputError(`Unknown or non-lever KPI in bounds: "${k}"`);
      }
    }
  }

  interface EvalRecord {
    levers: LeverSet;
    passed: boolean;
    value: number;
    penalty: number;
    l1Norm: number;
  }

  const cache = new Map<string, EvalRecord>();
  let evaluations = 0;

  const keyOf = (lev: LeverSet) =>
    leverIds.map((id) => (lev[id] ?? 0).toFixed(4)).join('|');

  const evaluate = (raw: LeverSet): EvalRecord => {
    const snapped: LeverSet = {};
    let l1Norm = 0;
    for (const id of leverIds) {
      const q = quantize(raw[id] ?? 0, step, bounds[id].min, bounds[id].max);
      if (q !== 0) {
        snapped[id] = q;
        l1Norm += Math.abs(q);
      }
    }
    const key = keyOf(snapped);
    const hit = cache.get(key);
    if (hit) return hit;

    evaluations++;
    const res = engine.computeScenario(snapped);
    const passed = res.guardrails.every((g) => g.passed);
    let penalty = 0;
    for (const g of res.guardrails) {
      if (!g.passed) {
        const scale = Math.max(1, Math.abs(g.limit));
        penalty += Math.abs(g.headroom) / scale;
      }
    }
    const rec: EvalRecord = {
      levers: snapped,
      passed,
      value: res.fyValues[targetKpi],
      penalty,
      l1Norm,
    };
    cache.set(key, rec);
    return rec;
  };

  const isBetter = (a: EvalRecord, b: EvalRecord): boolean => {
    if (a.passed !== b.passed) return a.passed;
    if (a.passed) {
      if (Math.abs(a.value - b.value) > 1e-9) return a.value > b.value;
      return a.l1Norm < b.l1Norm - 1e-9; // tie-break: smaller change
    }
    if (Math.abs(a.penalty - b.penalty) > 1e-9) return a.penalty < b.penalty;
    return a.value > b.value;
  };

  const baselineEval = evaluate({});
  let best = baselineEval;

  // Stage 1: Coarse 1D sweep across every lever independently
  const perLeverBest: Record<string, EvalRecord> = {};
  for (const id of leverIds) {
    perLeverBest[id] = baselineEval;
    const { min, max } = bounds[id];
    const gridSteps = 20;
    for (let s = 0; s <= gridSteps; s++) {
      const v = min + ((max - min) * s) / gridSteps;
      const cand = evaluate({ [id]: v });
      if (isBetter(cand, perLeverBest[id])) perLeverBest[id] = cand;
      if (isBetter(cand, best)) best = cand;
    }
  }

  // Build diverse seed pool for multi-start refinement
  const seeds: EvalRecord[] = [baselineEval, best];

  // Combine best 1D values across all levers as a greedy composite seed
  const composite: LeverSet = {};
  for (const id of leverIds) {
    const val = perLeverBest[id].levers[id] ?? 0;
    if (val !== 0) composite[id] = val;
  }
  const compEval = evaluate(composite);
  if (isBetter(compEval, best)) best = compEval;
  seeds.push(compEval);

  // Add top individual lever seeds
  for (const id of leverIds) {
    if (perLeverBest[id].passed && (perLeverBest[id].levers[id] ?? 0) !== 0) {
      seeds.push(perLeverBest[id]);
    }
  }

  // Stage 2: Seeded random multi-lever search inside bounds (capped by time budget)
  const rng = createRng(20260521);
  const topSamples: EvalRecord[] = [];
  for (let i = 0; i < 320; i++) {
    if (performance.now() - startTime > maxTimeMs * 0.4) break;
    const sample: LeverSet = {};
    for (const id of leverIds) {
      if (rng() < 0.75) {
        const { min, max } = bounds[id];
        sample[id] = min + rng() * (max - min);
      }
    }
    const cand = evaluate(sample);
    if (isBetter(cand, best)) best = cand;
    if (cand.passed) topSamples.push(cand);
  }

  topSamples.sort((a, b) => b.value - a.value);
  for (const ts of topSamples.slice(0, 4)) {
    seeds.push(ts);
  }

  // Deduplicate starting seeds
  const uniqueSeeds = Array.from(
    new Map(seeds.map((s) => [keyOf(s.levers), s])).values()
  ).slice(0, 8);

  // Stage 3: Multi-start adaptive coordinate ascent
  const stepSchedule = [0.2, 0.1, 0.05, 0.02, 0.01];

  const refine = (startRec: EvalRecord, timeLimit: number): EvalRecord => {
    let curr = startRec;
    for (const delta of stepSchedule) {
      if (delta < step - 1e-9) continue;
      let improved = true;
      let pass = 0;
      while (improved && pass < 20) {
        if (performance.now() - startTime > timeLimit) return curr;
        improved = false;
        pass++;
        for (const id of leverIds) {
          const curVal = curr.levers[id] ?? 0;
          for (const dir of [1, -1]) {
            const nextVal = curVal + dir * delta;
            if (nextVal < bounds[id].min - 1e-9 || nextVal > bounds[id].max + 1e-9) {
              continue;
            }
            const cand = evaluate({ ...curr.levers, [id]: nextVal });
            if (isBetter(cand, curr)) {
              curr = cand;
              improved = true;
              break;
            }
          }
        }
      }
    }
    return curr;
  };

  for (const seed of uniqueSeeds) {
    if (performance.now() - startTime > maxTimeMs * 0.85) break;
    const refined = refine(seed, startTime + maxTimeMs * 0.85);
    if (isBetter(refined, best)) best = refined;
  }

  // Pairwise polish (+/- step, +/- 2*step) on the best solution to cross step thresholds (e.g. headcount rent tiers)
  let pairImproved = true;
  let pairRounds = 0;
  while (pairImproved && pairRounds < 4 && performance.now() - startTime < maxTimeMs) {
    pairImproved = false;
    pairRounds++;
    for (let i = 0; i < leverIds.length; i++) {
      for (let j = i + 1; j < leverIds.length; j++) {
        if (performance.now() - startTime > maxTimeMs) break;
        const idA = leverIds[i];
        const idB = leverIds[j];
        const valA = best.levers[idA] ?? 0;
        const valB = best.levers[idB] ?? 0;
        for (const dA of [-step, step]) {
          for (const dB of [-step, step]) {
            const cand = evaluate({
              ...best.levers,
              [idA]: valA + dA,
              [idB]: valB + dB,
            });
            if (isBetter(cand, best)) {
              best = cand;
              pairImproved = true;
            }
          }
        }
      }
    }
  }

  // Final single-coordinate fine polish at exact `step`
  best = refine(best, startTime + maxTimeMs);

  const finalLevers = cleanLevers(best.levers);
  const simulation = engine.simulateFull(finalLevers);
  const elapsedMs = Number((performance.now() - startTime).toFixed(2));
  const baselineVal = simulation.baseline.fyValues[targetKpi];
  const optVal = simulation.scenario.fyValues[targetKpi];
  const improvementAbs = optVal - baselineVal;
  const improvementPct =
    baselineVal !== 0 ? (improvementAbs / Math.abs(baselineVal)) * 100 : null;

  return {
    feasible: best.passed,
    bestLevers: finalLevers,
    simulation,
    stats: {
      evaluations,
      elapsedMs,
      baselineValue: baselineVal,
      optimizedValue: optVal,
      improvementAbs,
      improvementPct,
      allGuardrailsPassed: best.passed,
      targetKpi,
    },
  };
}
