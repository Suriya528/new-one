import { useState } from 'react';
import { type SavedScenario, type SimulationResponse } from '../api';
import { formatKpiValue, formatLeverPct, formatSignedDelta, getPolarityClass } from '../utils';
import { Trash2, Play, CheckCircle2, AlertTriangle, PlusCircle } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface Props {
  scenarios: SavedScenario[];
  baselineSim: SimulationResponse;
  onLoadScenario: (levers: Record<string, number>) => void;
  onDeleteScenario: (id: number) => Promise<void>;
  onOpenSaveModal: () => void;
}

const COMPARE_KPIS = [
  { id: 'total_revenue', label: 'Total Revenue', unit: 'usd_k', goodWhen: 'up' },
  { id: 'total_expenses', label: 'Total Expenses', unit: 'usd_k', goodWhen: 'down' },
  { id: 'profit_before_tax', label: 'Profit Before Tax', unit: 'usd_k', goodWhen: 'up' },
  { id: 'tax', label: 'Tax (25% YTD)', unit: 'usd_k', goodWhen: 'down' },
  { id: 'net_profit', label: 'Net Profit', unit: 'usd_k', goodWhen: 'up' },
  { id: 'net_margin_pct', label: 'Net Margin', unit: 'pct', goodWhen: 'up' },
  { id: 'closing_subscribers', label: 'March Subscribers', unit: 'count', goodWhen: 'up' },
] as const;

export function CompareView({
  scenarios,
  baselineSim,
  onLoadScenario,
  onDeleteScenario,
  onOpenSaveModal,
}: Props) {
  const [selectedIds, setSelectedIds] = useState<number[]>(() =>
    scenarios.slice(0, 3).map((s) => s.id)
  );

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return [...prev.slice(1), id];
      return [...prev, id];
    });
  };

  const activeCompared = scenarios.filter((s) => selectedIds.includes(s.id)).slice(0, 3);

  const chartData = [
    {
      name: 'Baseline',
      Revenue: Number(baselineSim.baseline.fyValues.total_revenue.toFixed(2)),
      Expenses: Number(baselineSim.baseline.fyValues.total_expenses.toFixed(2)),
      'Net Profit': Number(baselineSim.baseline.fyValues.net_profit.toFixed(2)),
    },
    ...activeCompared.map((s) => ({
      name: s.name.length > 18 ? s.name.slice(0, 17) + '…' : s.name,
      Revenue: Number((s.summary.total_revenue?.fyScenario ?? 0).toFixed(2)),
      Expenses: Number((s.summary.total_expenses?.fyScenario ?? 0).toFixed(2)),
      'Net Profit': Number((s.summary.net_profit?.fyScenario ?? 0).toFixed(2)),
    })),
  ];

  return (
    <div>
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Saved Scenarios &amp; Side-by-Side Comparison (Up to 3)</div>
            <div className="card-subtitle">
              Select up to 3 saved scenarios to compare against Baseline across KPIs and bank covenants
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={onOpenSaveModal}>
            <PlusCircle size={14} /> Save Current Scenario
          </button>
        </div>

        {scenarios.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '36px 16px', color: '#627d98' }}>
            <p style={{ fontWeight: 600, color: '#102a43', marginBottom: 4 }}>No saved scenarios yet</p>
            <p style={{ fontSize: '0.84rem', marginBottom: 14 }}>
              Adjust levers in the Simulator tab (or load the Golden Checkpoint) and click "Save Current Scenario".
            </p>
            <button className="btn btn-primary btn-sm" onClick={onOpenSaveModal}>
              Save Current Scenario
            </button>
          </div>
        ) : (
          <div className="compare-grid">
            {scenarios.map((sc) => {
              const isSelected = selectedIds.includes(sc.id);
              const netDelta = sc.summary.net_profit?.deltaAbs ?? 0;
              const subs = sc.summary.closing_subscribers?.fyScenario ?? 0;
              const margin = sc.summary.net_margin_pct?.fyScenario ?? 0;
              const leverEntries = Object.entries(sc.levers);
              return (
                <div
                  key={sc.id}
                  className={`scenario-tile ${isSelected ? 'selected' : ''}`}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#0f2537' }}>
                        {sc.name}
                      </div>
                      {sc.description && (
                        <div style={{ fontSize: '0.75rem', color: '#627d98', marginTop: 2 }}>
                          {sc.description}
                        </div>
                      )}
                    </div>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(sc.id)}
                      title="Include in side-by-side comparison (max 3)"
                    />
                  </div>

                  <div className="tag-row">
                    {leverEntries.length === 0 ? (
                      <span className="mini-tag">Baseline (0%)</span>
                    ) : (
                      leverEntries.map(([k, v]) => (
                        <span key={k} className="mini-tag">
                          {k}: {formatLeverPct(v)}
                        </span>
                      ))
                    )}
                  </div>

                  <div style={{ fontSize: '0.79rem', color: '#334e68', display: 'flex', justifyContent: 'space-between' }}>
                    <span>Net Δ: <strong>{formatSignedDelta(netDelta, 'usd_k')}</strong></span>
                    <span>Margin: <strong>{margin.toFixed(2)}%</strong></span>
                    <span>Subs: <strong>{Math.round(subs).toLocaleString()}</strong></span>
                  </div>

                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => onLoadScenario(sc.levers)}
                    >
                      <Play size={12} /> Load into Simulator
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => onDeleteScenario(sc.id)}
                      title="Delete scenario"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {activeCompared.length > 0 && (
        <>
          <div className="card">
            <div className="card-title" style={{ marginBottom: 12 }}>
              Side-by-Side Decision Matrix (Baseline vs Selected Scenarios)
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Baseline</th>
                    {activeCompared.map((sc) => (
                      <th key={sc.id}>{sc.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Adjusted Levers</td>
                    <td style={{ color: '#627d98' }}>All 0%</td>
                    {activeCompared.map((sc) => (
                      <td key={sc.id} style={{ fontSize: '0.75rem' }}>
                        {Object.keys(sc.levers).length === 0
                          ? 'All 0%'
                          : Object.entries(sc.levers)
                              .map(([k, v]) => `${k} ${formatLeverPct(v)}`)
                              .join(', ')}
                      </td>
                    ))}
                  </tr>
                  {COMPARE_KPIS.map((k) => {
                    const baseVal = baselineSim.baseline.fyValues[k.id];
                    return (
                      <tr key={k.id}>
                        <td style={{ fontWeight: 600 }}>{k.label}</td>
                        <td className="num">{formatKpiValue(baseVal, k.unit)}</td>
                        {activeCompared.map((sc) => {
                          const row = sc.summary[k.id];
                          const val = row?.fyScenario ?? baseVal;
                          const delta = row?.deltaAbs ?? 0;
                          const polarity = getPolarityClass(delta, k.goodWhen);
                          return (
                            <td key={sc.id} className="num">
                              <div style={{ fontWeight: 700 }}>{formatKpiValue(val, k.unit)}</div>
                              <div
                                style={{
                                  fontSize: '0.72rem',
                                  color:
                                    polarity === 'neutral'
                                      ? '#627d98'
                                      : polarity === 'good'
                                        ? '#0e7c47'
                                        : '#c5221f',
                                }}
                              >
                                {formatSignedDelta(delta, k.unit)}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ fontWeight: 600 }}>Margin &gt;= 10% &amp; Subs &gt;= 3,900</td>
                    <td>
                      <span className="pill pass">PASS</span>
                    </td>
                    {activeCompared.map((sc) => {
                      const m = sc.summary.net_margin_pct?.fyScenario ?? 0;
                      const subs = sc.summary.closing_subscribers?.fyScenario ?? 0;
                      const ok = m >= 10 && subs >= 3900;
                      return (
                        <td key={sc.id}>
                          {ok ? (
                            <span className="pill pass" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              <CheckCircle2 size={11} /> PASS
                            </span>
                          ) : (
                            <span className="pill fail" style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              <AlertTriangle size={11} /> BREACH
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-title" style={{ marginBottom: 10 }}>
              Baseline vs Scenarios — Revenue, Expenses &amp; Net Profit ($K)
            </div>
            <div className="chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="name" stroke="#627d98" fontSize={11} />
                  <YAxis stroke="#627d98" fontSize={11} tickFormatter={(v: number) => `$${v}K`} />
                  <Tooltip formatter={(v: any) => `$${Number(v).toLocaleString()}K`} />
                  <Legend />
                  <Bar dataKey="Revenue" fill="#0b69ff" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Expenses" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="Net Profit" fill="#0e7c47" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
