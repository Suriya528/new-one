import { useState, useMemo } from 'react';
import { type KpiDefinition, type SimulationResponse } from '../api';
import {
  formatKpiValue,
  formatSignedDelta,
  formatPctDelta,
  getPolarityClass,
  monthShortName,
} from '../utils';
import { Info, Search, X } from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface Props {
  kpis: KpiDefinition[];
  sim: SimulationResponse;
}

export function AuditTable({ kpis, sim }: Props) {
  const [filter, setFilter] = useState<'all' | 'input' | 'formula' | 'changed'>('all');
  const [search, setSearch] = useState('');
  const [drillKpiId, setDrillKpiId] = useState<string | null>(null);
  const [exactTwoDecimals, setExactTwoDecimals] = useState(false);

  const filtered = useMemo(() => {
    return kpis.filter((k) => {
      if (filter === 'input' && k.kind !== 'input') return false;
      if (filter === 'formula' && k.kind !== 'formula') return false;
      if (filter === 'changed') {
        const d = sim.deltas[k.id]?.deltaAbs ?? 0;
        if (Math.abs(d) < 1e-4) return false;
      }
      if (search.trim()) {
        const q = search.toLowerCase();
        return (
          k.label.toLowerCase().includes(q) ||
          k.id.toLowerCase().includes(q) ||
          k.formulaText.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [kpis, sim.deltas, filter, search]);

  const drillKpi = drillKpiId ? kpis.find((k) => k.id === drillKpiId) ?? null : null;

  return (
    <div>
      <div className="card">
        <div className="card-header" style={{ flexWrap: 'wrap' }}>
          <div>
            <div className="card-title">Full 27-KPI Financial Audit Table</div>
            <div className="card-subtitle">
              Hover any KPI for its formula definition · Click any row for 12-month drilldown
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ position: 'relative', width: 210 }}>
              <Search
                size={14}
                style={{ position: 'absolute', left: 10, top: 10, color: '#627d98' }}
              />
              <input
                className="input"
                style={{ paddingLeft: 30, paddingTop: 6, paddingBottom: 6 }}
                placeholder="Filter KPIs or formulas..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {(['all', 'input', 'formula', 'changed'] as const).map((f) => (
              <button
                key={f}
                className={`btn btn-sm ${filter === f ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all'
                  ? 'All (27)'
                  : f === 'input'
                    ? 'Inputs'
                    : f === 'formula'
                      ? 'Formulas'
                      : 'Changed Only'}
              </button>
            ))}
            <button
              className={`btn btn-sm ${exactTwoDecimals ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setExactTwoDecimals((v) => !v)}
              title="Toggle raw 2-decimal precision on all 27 KPIs"
            >
              2dp Exact
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th style={{ textAlign: 'left' }}>KPI &amp; Formula Hover</th>
                <th>Kind</th>
                <th>Unit</th>
                <th>FY Rule</th>
                <th>Baseline FY</th>
                <th>Scenario FY</th>
                <th>Delta</th>
                <th>Delta %</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ textAlign: 'center', padding: 28, color: '#627d98' }}>
                    No KPIs match the active filter.
                  </td>
                </tr>
              ) : (
                filtered.map((kpi) => {
                  const d = sim.deltas[kpi.id];
                  const polarity = getPolarityClass(d.deltaAbs, kpi.goodWhen);
                  return (
                    <tr
                      key={kpi.id}
                      title={`${kpi.label} (${kpi.id})\nDefinition: ${kpi.formulaText}\nFY Aggregation: ${kpi.fyAggregation}`}
                      onClick={() => setDrillKpiId(kpi.id)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="num" style={{ color: '#627d98', width: 38 }}>
                        {kpi.sortOrder}
                      </td>
                      <td style={{ textAlign: 'left', maxWidth: 280, whiteSpace: 'normal' }}>
                        <div className="formula-hint">
                          <span style={{ fontWeight: 600 }}>{kpi.label}</span>
                          {kpi.isLever && <span className="mini-tag">Lever</span>}
                          <span
                            title={kpi.formulaText}
                            style={{ color: '#627d98', display: 'inline-flex', alignItems: 'center' }}
                          >
                            <Info size={13} />
                          </span>
                        </div>
                        <div style={{ fontSize: '0.71rem', color: '#627d98', marginTop: 2, wordBreak: 'break-word' }}>
                          <code>{kpi.formulaText}</code>
                        </div>
                      </td>
                      <td style={{ textTransform: 'capitalize', color: '#627d98' }}>{kpi.kind}</td>
                      <td>
                        <code>{kpi.unit}</code>
                      </td>
                      <td>
                        <code>{kpi.fyAggregation}</code>
                      </td>
                      <td className="num">{exactTwoDecimals ? d.baselineFy.toFixed(2) : formatKpiValue(d.baselineFy, kpi.unit)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {exactTwoDecimals ? d.scenarioFy.toFixed(2) : formatKpiValue(d.scenarioFy, kpi.unit)}
                      </td>
                      <td
                        className={`num ${
                          polarity === 'good'
                            ? 'delta-good'
                            : polarity === 'bad'
                              ? 'delta-bad'
                              : ''
                        }`}
                      >
                        {exactTwoDecimals ? `${d.deltaAbs > 0 ? '+' : ''}${d.deltaAbs.toFixed(2)}` : formatSignedDelta(d.deltaAbs, kpi.unit)}
                      </td>
                      <td
                        className={`num ${
                          polarity === 'good'
                            ? 'delta-good'
                            : polarity === 'bad'
                              ? 'delta-bad'
                              : ''
                        }`}
                      >
                        {formatPctDelta(d.deltaPct)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {drillKpi && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">
                Monthly Drilldown: {drillKpi.label} ({drillKpi.unit})
              </div>
              <div className="card-subtitle">
                Formula: <code>{drillKpi.formulaText}</code> · FY Rule: <code>{drillKpi.fyAggregation}</code>
              </div>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => setDrillKpiId(null)}>
              <X size={14} /> Close
            </button>
          </div>

          <div className="charts-two-col">
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={sim.monthly.map((m) => ({
                    month: monthShortName(m.month),
                    Baseline: m.baseline[drillKpi.id],
                    Scenario: m.scenario[drillKpi.id],
                  }))}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" stroke="#627d98" fontSize={11} />
                  <YAxis stroke="#627d98" fontSize={11} />
                  <Tooltip
                    formatter={(v: any) => formatKpiValue(Number(v), drillKpi.unit)}
                  />
                  <Legend />
                  <Line type="monotone" dataKey="Baseline" stroke="#627d98" strokeDasharray="5 5" dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="Scenario" stroke="#0b69ff" strokeWidth={2.5} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="table-wrap" style={{ maxHeight: 290, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Baseline</th>
                    <th>Scenario</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {sim.monthly.map((m) => {
                    const b = m.baseline[drillKpi.id];
                    const s = m.scenario[drillKpi.id];
                    const diff = s - b;
                    const pol = getPolarityClass(diff, drillKpi.goodWhen);
                    return (
                      <tr key={m.month}>
                        <td>{monthShortName(m.month)}</td>
                        <td className="num">{formatKpiValue(b, drillKpi.unit)}</td>
                        <td className="num" style={{ fontWeight: 600 }}>
                          {formatKpiValue(s, drillKpi.unit)}
                        </td>
                        <td className={`num ${pol === 'good' ? 'delta-good' : pol === 'bad' ? 'delta-bad' : ''}`}>
                          {formatSignedDelta(diff, drillKpi.unit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
