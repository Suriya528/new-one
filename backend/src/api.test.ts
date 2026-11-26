import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import { seedDatabase } from './seed';
import { createApp } from './index';

describe('REST API Integration Tests', () => {
  const tmpDb = path.join(os.tmpdir(), `philips-api-test-${Date.now()}.db`);
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

  it('GET /api/meta returns company, months, 8 levers, reactsTo, and 4 guardrails', async () => {
    const res = await fetch(`${baseUrl}/api/meta`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.fiscalYear).toBe('FY2025-26');
    expect(data.months).toHaveLength(12);
    expect(data.levers).toHaveLength(8);
    expect(data.guardrails).toHaveLength(4);
    expect(data.reactsTo).toHaveLength(2);
  });

  it('GET /api/kpis returns all 27 KPIs with formulaText', async () => {
    const res = await fetch(`${baseUrl}/api/kpis`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any[];
    expect(data).toHaveLength(27);
    expect(data.every((k: any) => typeof k.formulaText === 'string' && k.formulaText.length > 0)).toBe(true);
  });

  it('POST /api/simulate computes Golden Scenario accurately and returns waterfall + explanation', async () => {
    const res = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        levers: { marketing_spend: -0.20, arpu: 0.08, ctc_per_head: 0.05 },
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.scenario.fyValues.total_revenue).toBeCloseTo(13356.91, 1);
    expect(data.scenario.fyValues.net_profit).toBeCloseTo(1640.36, 1);
    expect(Math.round(data.scenario.fyValues.closing_subscribers)).toBe(3500);
    expect(data.monthly).toHaveLength(12);
    expect(data.waterfall.length).toBe(10);
    expect(data.explanation.length).toBeGreaterThan(0);

    // Sum of waterfall deltas equals net profit change
    const driverSum = data.waterfall
      .filter((w: any) => w.category !== 'subtotal')
      .reduce((acc: number, w: any) => acc + w.impactUsdK, 0);
    expect(driverSum).toBeCloseTo(data.deltas.net_profit.deltaAbs, 6);
  });

  it('POST /api/simulate rejects invalid levers with HTTP 400', async () => {
    const bad1 = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levers: { invalid_kpi: 0.1 } }),
    });
    expect(bad1.status).toBe(400);

    const bad2 = await fetch(`${baseUrl}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ levers: { arpu: 'not-a-number' } }),
    });
    expect(bad2.status).toBe(400);
  });

  it('POST/GET/DELETE /api/scenarios persists scenario and scenario_results cleanly', async () => {
    const createRes = await fetch(`${baseUrl}/api/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Checkpoint Scenario',
        description: 'Marketing -20%, Price +8%, Salary +5%',
        levers: { marketing_spend: -0.20, arpu: 0.08, ctc_per_head: 0.05 },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as any;

    const listRes = await fetch(`${baseUrl}/api/scenarios`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as any[];
    expect(list).toHaveLength(1);
    expect(list[0].summary.net_profit.fyScenario).toBeCloseTo(1640.36, 1);

    const delRes = await fetch(`${baseUrl}/api/scenarios/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
  });
});
