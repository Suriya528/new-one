import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import { seedDatabase } from './seed';
import { loadModelFromDb } from './model-loader';
import { createApp } from './index';
import { optimizeLevers } from './optimizer';

describe('Optimizer — Pure Function & POST /api/optimize', () => {
  const tmpDb = path.join(os.tmpdir(), `philips-opt-test-${Date.now()}.db`);
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
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

  it('maximizes net_profit within UI slider bounds [-1, +1] while passing all 4 guardrails in < 2s', () => {
    const model = loadModelFromDb(tmpDb);
    const result = optimizeLevers(model.engine);

    expect(result.feasible).toBe(true);
    expect(result.stats.allGuardrailsPassed).toBe(true);
    expect(result.simulation.guardrails.every((g) => g.passed)).toBe(true);
    expect(result.stats.optimizedValue).toBeGreaterThanOrEqual(result.stats.baselineValue);
    expect(result.stats.elapsedMs).toBeLessThan(2000);

    // Every lever must stay within UI slider bounds [-1.0, 1.0] and 0.01 step
    for (const val of Object.values(result.bestLevers)) {
      expect(val).toBeGreaterThanOrEqual(-1.0);
      expect(val).toBeLessThanOrEqual(1.0);
      expect(Math.abs(val * 100 - Math.round(val * 100))).toBeLessThan(1e-6);
    }
  });

  it('supports optimizing only custom bounded levers (e.g., 4 primary CFO levers)', () => {
    const model = loadModelFromDb(tmpDb);
    const result = optimizeLevers(model.engine, {
      bounds: {
        arpu: { min: -0.5, max: 0.5 },
        marketing_spend: { min: -0.5, max: 0.5 },
        billable_heads: { min: -0.5, max: 0.5 },
        ctc_per_head: { min: -0.5, max: 0.5 },
        churn_pct: { min: 0, max: 0 },
        nonbillable_heads: { min: 0, max: 0 },
        utilization_pct: { min: 0, max: 0 },
        rate_per_hour: { min: 0, max: 0 },
      },
    });

    expect(result.feasible).toBe(true);
    expect(result.simulation.guardrails.every((g) => g.passed)).toBe(true);
    expect(result.stats.optimizedValue).toBeGreaterThan(result.stats.baselineValue);
    expect(result.stats.elapsedMs).toBeLessThan(2000);
    expect(result.bestLevers.churn_pct).toBeUndefined();
    expect(result.bestLevers.utilization_pct).toBeUndefined();
  });

  it('POST /api/optimize returns valid bestLevers, simulation, and stats under 2s', async () => {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}/api/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const roundTripMs = performance.now() - t0;

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.feasible).toBe(true);
    expect(body.stats.allGuardrailsPassed).toBe(true);
    expect(body.simulation.guardrails.every((g: any) => g.passed)).toBe(true);
    expect(body.stats.optimizedValue).toBeGreaterThanOrEqual(body.stats.baselineValue);
    expect(body.simulation.monthly).toHaveLength(12);
    expect(body.stats.elapsedMs).toBeLessThan(2000);
    expect(roundTripMs).toBeLessThan(2000);
  });

  it('POST /api/optimize rejects invalid custom bounds with HTTP 400', async () => {
    const res = await fetch(`${baseUrl}/api/optimize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bounds: { arpu: { min: 0.5, max: 0.1 } },
      }),
    });
    expect(res.status).toBe(400);
  });
});
