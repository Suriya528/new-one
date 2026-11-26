import { useState } from 'react';
import { useModelMetadata, useSimulation, useScenarios } from './hooks';
import { api, type LeverMeta, type OptimizeResponse } from './api';
import {
  formatKpiValue,
  formatSignedDelta,
  formatPctDelta,
  formatLeverPct,
  getPolarityClass,
  monthShortName,
} from './utils';
import { WaterfallChart } from './components/WaterfallChart';
import { AuditTable } from './components/AuditTable';
import { CompareView } from './components/CompareView';
import { JudgeMode } from './components/JudgeMode';
import {
  TrendingUp,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  GitCompare,
  Table2,
  ChevronDown,
  ChevronUp,
  Sparkles,
  AlertCircle,
  AlertTriangle,
  Scale,
  Wand2,
  X,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

const HEADLINE_KPI_IDS = [
  'total_revenue',
  'total_expenses',
  'profit_before_tax',
  'tax',
  'net_profit',
  'closing_subscribers',
] as const;

const GOLDEN_PRESET: Record<string, number> = {
  marketing_spend: -0.20,
  arpu: 0.08,
  ctc_per_head: 0.05,
};

function App() {
  const { meta, kpis, loading, error, reload } = useModelMetadata();
  const [levers, setLevers] = useState<Record<string, number>>({});
  const { data: sim, simulating, simError } = useSimulation(levers, !!meta);
  const { scenarios, saveScenario, deleteScenario } = useScenarios();

  const [activeTab, setActiveTab] = useState<'simulator' | 'compare' | 'audit' | 'judge'>('simulator');
  const [showSecondaryLevers, setShowSecondaryLevers] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [chartMetric, setChartMetric] = useState<'pnl' | 'revenue_expenses'>('pnl');
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeSummary, setOptimizeSummary] = useState<OptimizeResponse | null>(null);

  if (loading) {
    return (
      <div className="center-state">
        <div className="spinner" />
        <div style={{ fontWeight: 600 }}>Loading Financial Model from SQLite...</div>
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className="center-state">
        <AlertCircle size={38} color="#c5221f" />
        <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>Unable to Load Model API</div>
        <div style={{ color: '#627d98', maxWidth: 460 }}>{error || 'Unknown API error'}</div>
        <button className="btn btn-primary" onClick={reload}>
          Retry Connection
        </button>
      </div>
    );
  }

  const primaryLevers = meta.levers.filter((l) => l.isPrimary);
  const secondaryLevers = meta.levers.filter((l) => !l.isPrimary);
  const activeCount = Object.values(levers).filter((v) => Math.abs(v) > 1e-6).length;
  const violatedGuardrails = sim?.guardrails.filter((g) => !g.passed) ?? [];

  const handleLeverChange = (id: string, val: number) => {
    setOptimizeSummary(null);
    setLevers((prev) => {
      const next = { ...prev };
      if (Math.abs(val) < 1e-6) {
        delete next[id];
      } else {
        next[id] = Number(val.toFixed(4));
      }
      return next;
    });
  };

  const resetLevers = () => {
    setOptimizeSummary(null);
    setOptimizeError(null);
    setLevers({});
  };

  const applyGoldenPreset = () => {
    setOptimizeSummary(null);
    setOptimizeError(null);
    setLevers(GOLDEN_PRESET);
  };

  const handleFindBestPlan = async () => {
    setOptimizing(true);
    setOptimizeError(null);
    try {
      const res = await api.optimize();
      setLevers(res.bestLevers);
      setOptimizeSummary(res);
      setActiveTab('simulator');
      if (secondaryLevers.some((l) => Math.abs(res.bestLevers[l.id] ?? 0) > 1e-6)) {
        setShowSecondaryLevers(true);
      }
    } catch (err: any) {
      setOptimizeError(err.message || 'Optimization failed');
    } finally {
      setOptimizing(false);
    }
  };

  const renderLeverCard = (lever: LeverMeta) => {
    const val = levers[lever.id] ?? 0;
    const sliderMin = lever.uiMin ?? -1.0;
    const sliderMax = lever.uiMax ?? 1.0;
    const reactions = meta.reactsTo.filter((r) => r.source === lever.id);
    return (
      <div key={lever.id} className={`lever-card ${val !== 0 ? 'active-lever' : ''}`}>
        <div className="lever-top">
          <div>
            <div className="lever-name">{lever.label}</div>
            <div className="lever-meta">
              Baseline {lever.unit === 'count' ? 'Mar' : 'avg'}:{' '}
              <strong className="num">
                {formatKpiValue(
                  lever.unit === 'count' ? lever.baselineMarch : lever.baselineAverage,
                  lever.unit
                )}
              </strong>
            </div>
          </div>
          <span className={`lever-badge num ${val > 0 ? 'pos' : val < 0 ? 'neg' : 'zero'}`}>
            {formatLeverPct(val)}
          </span>
        </div>

        <input
          type="range"
          className="slider-range"
          aria-label={lever.label}
          min={sliderMin}
          max={sliderMax}
          step={lever.step}
          value={Math.max(sliderMin, Math.min(sliderMax, val))}
          onChange={(e) => handleLeverChange(lever.id, parseFloat(e.target.value))}
        />
        <div className="lever-bounds num">
          <span>{formatLeverPct(sliderMin)}</span>
          <span>0%</span>
          <span>{formatLeverPct(sliderMax)}</span>
        </div>

        <div className="tag-row">
          {lever.effectiveFromMonth > 1 && (
            <span className="mini-tag warn">
              Effective M{lever.effectiveFromMonth} ({lever.effectiveFromLabel})
            </span>
          )}
          {lever.isInteger && <span className="mini-tag">Integer rounded</span>}
          {lever.hardMax !== null && <span className="mini-tag">Max {lever.hardMax}%</span>}
          {reactions.map((r) => (
            <span key={r.target} className="mini-tag warn">
              Reacts: {r.target} (e={r.elasticity})
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-mark">
            <TrendingUp size={20} />
          </div>
          <div>
            <div className="brand-title">Profit What-If Simulator</div>
            <div className="brand-sub">
              {meta.company} · {meta.fiscalYear} · CFO Decision Workbench
            </div>
          </div>
        </div>

        <div className="top-actions">
          <span className="status-pill">
            {simulating ? 'Recalculating...' : activeCount === 0 ? 'Baseline Active' : `${activeCount} Lever(s) Active`}
          </span>
          <button
            className="btn btn-optimize btn-sm"
            onClick={handleFindBestPlan}
            disabled={optimizing}
          >
            <Wand2 size={14} /> {optimizing ? 'Finding best plan...' : 'Find best plan'}
          </button>
          <button className="btn btn-ghost-light btn-sm" onClick={applyGoldenPreset}>
            <Sparkles size={14} /> Checkpoint Preset
          </button>
          <button
            className="btn btn-ghost-light btn-sm"
            onClick={resetLevers}
            disabled={activeCount === 0}
          >
            <RotateCcw size={14} /> Reset
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setSaveError(null);
              setShowSaveModal(true);
            }}
          >
            <Save size={14} /> Save Scenario
          </button>
        </div>
      </header>

      <main className="main-container">
        {(simError || optimizeError) && (
          <div className="covenant-banner">
            <AlertCircle size={20} />
            <div>
              <div className="covenant-banner-title">
                {optimizeError ? 'Optimization Error' : 'Simulation Validation Error'}
              </div>
              <div className="covenant-banner-list">{optimizeError || simError}</div>
            </div>
          </div>
        )}

        {/* Optimized Plan Summary Banner */}
        {optimizeSummary && (
          <div className="optimize-banner" role="status">
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <ShieldCheck size={22} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div className="covenant-banner-title">
                  OPTIMAL PLAN LOADED — {optimizeSummary.stats.evaluations} scenarios evaluated in{' '}
                  {optimizeSummary.stats.elapsedMs.toFixed(0)} ms (
                  {optimizeSummary.stats.allGuardrailsPassed ? 'All 4 Guardrails Passing' : 'No fully feasible plan'})
                </div>
                <div className="covenant-banner-list num">
                  <div>
                    Net Profit vs Baseline:{' '}
                    <strong>
                      {formatKpiValue(optimizeSummary.stats.baselineValue, 'usd_k')} →{' '}
                      {formatKpiValue(optimizeSummary.stats.optimizedValue, 'usd_k')}
                    </strong>{' '}
                    ({formatSignedDelta(optimizeSummary.stats.improvementAbs, 'usd_k')},{' '}
                    {formatPctDelta(optimizeSummary.stats.improvementPct)}) · Revenue:{' '}
                    <strong>
                      {formatSignedDelta(optimizeSummary.simulation.deltas.total_revenue.deltaAbs, 'usd_k')}
                    </strong>{' '}
                    · Expenses:{' '}
                    <strong>
                      {formatSignedDelta(optimizeSummary.simulation.deltas.total_expenses.deltaAbs, 'usd_k')}
                    </strong>{' '}
                    · March Subs:{' '}
                    <strong>
                      {Math.round(optimizeSummary.simulation.scenario.fyValues.closing_subscribers).toLocaleString()}
                    </strong>{' '}
                    ({formatSignedDelta(optimizeSummary.simulation.deltas.closing_subscribers.deltaAbs, 'count')})
                  </div>
                </div>
              </div>
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={() => setOptimizeSummary(null)}
              title="Dismiss optimization summary"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Prominent Red Covenant Violation Banner */}
        {violatedGuardrails.length > 0 && (
          <div className="covenant-banner" role="alert">
            <ShieldAlert size={22} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div className="covenant-banner-title">
                BANK COVENANT VIOLATION — {violatedGuardrails.length} Guardrail(s) Breached
              </div>
              <div className="covenant-banner-list">
                {violatedGuardrails.map((g) => (
                  <div key={g.id}>
                    <strong>{g.label}</strong>: Actual {g.actual.toFixed(2)} vs Limit {g.limit} (Headroom{' '}
                    {g.headroom.toFixed(2)}
                    {g.scope === 'every_month' && g.breachMonthLabel
                      ? `, first breached in ${g.breachMonthLabel}`
                      : ''}
                    )
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Model Degeneracy Warning Banner */}
        {sim && sim.warnings && sim.warnings.length > 0 && (
          <div className="warning-banner" role="status">
            <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div className="covenant-banner-title">
                MODEL BOUNDARY / DEGENERACY WARNING ({sim.warnings.length})
              </div>
              <div className="covenant-banner-list">
                {sim.warnings.map((w) => (
                  <div key={w.code}>
                    <strong>{w.title}:</strong> {w.detail}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'simulator' ? 'active' : ''}`}
            onClick={() => setActiveTab('simulator')}
          >
            <Sliders size={15} /> Decision Simulator
          </button>
          <button
            className={`nav-tab ${activeTab === 'compare' ? 'active' : ''}`}
            onClick={() => setActiveTab('compare')}
          >
            <GitCompare size={15} /> Compare Scenarios ({scenarios.length})
          </button>
          <button
            className={`nav-tab ${activeTab === 'audit' ? 'active' : ''}`}
            onClick={() => setActiveTab('audit')}
          >
            <Table2 size={15} /> 27-KPI Audit Table
          </button>
          <button
            className={`nav-tab ${activeTab === 'judge' ? 'active' : ''}`}
            onClick={() => setActiveTab('judge')}
          >
            <Scale size={15} /> Run Scenario JSON (Judge Mode)
          </button>
        </nav>

        {!sim ? (
          <div className="center-state">
            <div className="spinner" />
            <div>Running initial baseline simulation...</div>
          </div>
        ) : (
          <>
            {/* Executive 6-KPI Strip */}
            <section className="kpi-strip">
              {HEADLINE_KPI_IDS.map((kpiId) => {
                const d = sim.deltas[kpiId];
                const polarity = getPolarityClass(d.deltaAbs, d.goodWhen);
                const isNetProfit = kpiId === 'net_profit';
                return (
                  <div key={kpiId} className="kpi-card">
                    <span className="kpi-card-label">
                      {kpiId === 'closing_subscribers' ? 'March Subscribers' : d.label}
                    </span>
                    <span className="kpi-card-value num">
                      {formatKpiValue(d.scenarioFy, d.unit)}
                    </span>
                    <span className="kpi-card-base num">
                      Baseline: {formatKpiValue(d.baselineFy, d.unit)}
                      {isNetProfit && (
                        <> · Margin: {sim.scenario.fyValues.net_margin_pct.toFixed(2)}%</>
                      )}
                    </span>
                    <span className={`kpi-card-delta num ${polarity}`}>
                      {formatSignedDelta(d.deltaAbs, d.unit)} ({formatPctDelta(d.deltaPct)})
                    </span>
                  </div>
                );
              })}
            </section>

            {activeTab === 'simulator' && (
              <div className="sim-grid">
                {/* Left Column: Lever Sliders */}
                <aside>
                  <div className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">CFO Decision Levers</div>
                        <div className="card-subtitle">
                          Adjust fractional % changes from historical actuals
                        </div>
                      </div>
                    </div>

                    <div className="lever-section-label">Primary Board Levers (4)</div>
                    {primaryLevers.map(renderLeverCard)}

                    <button
                      className="btn btn-outline btn-sm"
                      style={{ width: '100%', justifyContent: 'space-between', marginTop: 6 }}
                      onClick={() => setShowSecondaryLevers((s) => !s)}
                    >
                      <span>Additional Operational Levers ({secondaryLevers.length})</span>
                      {showSecondaryLevers ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </button>

                    {showSecondaryLevers && (
                      <div style={{ marginTop: 10 }}>
                        {secondaryLevers.map(renderLeverCard)}
                      </div>
                    )}
                  </div>
                </aside>

                {/* Right Column: Guardrails, Explanation, Charts */}
                <div>
                  {/* Bank Guardrails Panel */}
                  <div className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">
                          {violatedGuardrails.length === 0 ? (
                            <ShieldCheck size={18} color="#0e7c47" />
                          ) : (
                            <ShieldAlert size={18} color="#c5221f" />
                          )}
                          Bank Guardrails &amp; Policy Covenants
                        </div>
                        <div className="card-subtitle">
                          Evaluated dynamically against exact thresholds from the database specification
                        </div>
                      </div>
                      <span className={`pill ${violatedGuardrails.length === 0 ? 'pass' : 'fail'}`}>
                        {violatedGuardrails.length === 0
                          ? 'ALL 4 PASSING'
                          : `${violatedGuardrails.length} BREACHED`}
                      </span>
                    </div>

                    <div className="guardrail-grid">
                      {sim.guardrails.map((g) => {
                        const unit = kpis.find((k) => k.id === g.kpiId)?.unit ?? 'usd_k';
                        return (
                          <div key={g.id} className={`guardrail-item ${g.passed ? 'pass' : 'fail'}`}>
                            <div className="guardrail-head">
                              <span className="guardrail-title">{g.label}</span>
                              <span className={`pill ${g.passed ? 'pass' : 'fail'}`}>
                                {g.passed ? 'PASS' : 'BREACH'}
                              </span>
                            </div>
                            <div className="guardrail-metrics num">
                              <span>
                                Actual: <strong>{formatKpiValue(g.actual, unit)}</strong>
                              </span>
                              <span>
                                Limit: <strong>{g.operator === 'max' ? '<=' : '>='} {formatKpiValue(g.limit, unit)}</strong>
                              </span>
                              <span>
                                Headroom:{' '}
                                <strong>
                                  {g.headroom >= 0 ? '+' : ''}
                                  {formatKpiValue(g.headroom, unit)}
                                </strong>
                              </span>
                              {!g.passed && g.breachMonthLabel && (
                                <span style={{ color: '#c5221f', fontWeight: 700 }}>
                                  Breach: {g.breachMonthLabel} (M{g.breachMonth})
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Why did this change? */}
                  <div className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">Why Did This Change?</div>
                        <div className="card-subtitle">
                          Deterministic causal trace across lags, elasticities, step costs, and effective dates
                        </div>
                      </div>
                    </div>
                    <div className="causal-list">
                      {sim.explanation.map((step, idx) => (
                        <div key={idx} className={`causal-item ${step.impactDirection}`}>
                          <div className="causal-title">{step.title}</div>
                          <div className="causal-detail">{step.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Charts: Monthly Financial Trend + Waterfall */}
                  <div className="charts-two-col">
                    <div className="card">
                      <div className="card-header">
                        <div>
                          <div className="card-title">Monthly P&amp;L Trajectory</div>
                          <div className="card-subtitle">Baseline (dashed) vs Scenario (solid)</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className={`btn btn-sm ${chartMetric === 'pnl' ? 'btn-primary' : 'btn-outline'}`}
                            onClick={() => setChartMetric('pnl')}
                          >
                            Net Profit
                          </button>
                          <button
                            className={`btn btn-sm ${chartMetric === 'revenue_expenses' ? 'btn-primary' : 'btn-outline'}`}
                            onClick={() => setChartMetric('revenue_expenses')}
                          >
                            Rev vs Exp
                          </button>
                        </div>
                      </div>
                      <div className="chart-box">
                        <ResponsiveContainer width="100%" height="100%">
                          {chartMetric === 'pnl' ? (
                            <LineChart
                              data={sim.monthly.map((m) => ({
                                month: monthShortName(m.month),
                                'Net Profit (Base)': Number(m.baseline.net_profit.toFixed(2)),
                                'Net Profit (Scen)': Number(m.scenario.net_profit.toFixed(2)),
                                'PBT (Scen)': Number(m.scenario.profit_before_tax.toFixed(2)),
                              }))}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                              <XAxis dataKey="month" stroke="#627d98" fontSize={11} />
                              <YAxis stroke="#627d98" fontSize={11} tickFormatter={(v: number) => `$${v}K`} />
                              <Tooltip formatter={(v: any) => `$${Number(v).toFixed(2)}K`} />
                              <Legend />
                              <ReferenceLine y={0} stroke="#c5221f" strokeDasharray="3 3" />
                              <Line type="monotone" dataKey="Net Profit (Base)" stroke="#627d98" strokeDasharray="5 5" dot={false} strokeWidth={2} />
                              <Line type="monotone" dataKey="Net Profit (Scen)" stroke="#0b69ff" strokeWidth={2.5} dot={{ r: 3 }} />
                              <Line type="monotone" dataKey="PBT (Scen)" stroke="#0e7c47" strokeWidth={1.8} dot={false} />
                            </LineChart>
                          ) : (
                            <LineChart
                              data={sim.monthly.map((m) => ({
                                month: monthShortName(m.month),
                                'Revenue (Base)': Number(m.baseline.total_revenue.toFixed(2)),
                                'Revenue (Scen)': Number(m.scenario.total_revenue.toFixed(2)),
                                'Expenses (Base)': Number(m.baseline.total_expenses.toFixed(2)),
                                'Expenses (Scen)': Number(m.scenario.total_expenses.toFixed(2)),
                              }))}
                            >
                              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                              <XAxis dataKey="month" stroke="#627d98" fontSize={11} />
                              <YAxis stroke="#627d98" fontSize={11} tickFormatter={(v: number) => `$${v}K`} />
                              <Tooltip formatter={(v: any) => `$${Number(v).toFixed(2)}K`} />
                              <Legend />
                              <Line type="monotone" dataKey="Revenue (Base)" stroke="#9fb3c8" strokeDasharray="5 5" dot={false} />
                              <Line type="monotone" dataKey="Revenue (Scen)" stroke="#0e7c47" strokeWidth={2.5} dot={false} />
                              <Line type="monotone" dataKey="Expenses (Base)" stroke="#cbd5e1" strokeDasharray="5 5" dot={false} />
                              <Line type="monotone" dataKey="Expenses (Scen)" stroke="#c5221f" strokeWidth={2.5} dot={false} />
                            </LineChart>
                          )}
                        </ResponsiveContainer>
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-header">
                        <div>
                          <div className="card-title">Net Profit Change Waterfall ($K)</div>
                          <div className="card-subtitle">
                            Exact additive bridge from Baseline (${sim.baseline.fyValues.net_profit.toFixed(1)}K) to Scenario (${sim.scenario.fyValues.net_profit.toFixed(1)}K)
                          </div>
                        </div>
                      </div>
                      <WaterfallChart drivers={sim.waterfall} />
                    </div>
                  </div>

                  {/* Subscribers Trend Chart */}
                  <div className="card">
                    <div className="card-header">
                      <div>
                        <div className="card-title">Subscriber Trajectory &amp; Year-End Covenant (3,900 Min)</div>
                        <div className="card-subtitle">
                          Shows 1-month marketing lag and ARPU-churn elasticity impact on subscriber compounding
                        </div>
                      </div>
                    </div>
                    <div className="chart-box">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={sim.monthly.map((m) => ({
                            month: monthShortName(m.month),
                            'Baseline Subscribers': Math.round(m.baseline.closing_subscribers),
                            'Scenario Subscribers': Math.round(m.scenario.closing_subscribers),
                          }))}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis dataKey="month" stroke="#627d98" fontSize={11} />
                          <YAxis stroke="#627d98" fontSize={11} domain={['auto', 'auto']} />
                          <Tooltip formatter={(v: any) => Number(v).toLocaleString()} />
                          <Legend />
                          <ReferenceLine
                            y={3900}
                            stroke="#c5221f"
                            strokeDasharray="4 4"
                            label={{ value: 'Bank Floor: 3,900', fill: '#c5221f', fontSize: 11, position: 'insideTopLeft' }}
                          />
                          <Line type="monotone" dataKey="Baseline Subscribers" stroke="#627d98" strokeDasharray="5 5" dot={false} strokeWidth={2} />
                          <Line type="monotone" dataKey="Scenario Subscribers" stroke="#0b69ff" strokeWidth={2.5} dot={{ r: 3 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'compare' && (
              <CompareView
                scenarios={scenarios}
                baselineSim={sim}
                onLoadScenario={(l) => {
                  setLevers(l);
                  setActiveTab('simulator');
                }}
                onDeleteScenario={deleteScenario}
                onOpenSaveModal={() => {
                  setSaveError(null);
                  setShowSaveModal(true);
                }}
              />
            )}

            {activeTab === 'audit' && <AuditTable kpis={kpis} sim={sim} />}

            {activeTab === 'judge' && (
              <JudgeMode
                kpis={kpis}
                onApplyToSimulator={(l) => {
                  setLevers(l);
                  setActiveTab('simulator');
                }}
              />
            )}
          </>
        )}
      </main>

      {showSaveModal && (
        <SaveScenarioModal
          error={saveError}
          onClose={() => setShowSaveModal(false)}
          onSave={async (name, desc) => {
            try {
              setSaveError(null);
              await saveScenario(name, desc, levers);
              setShowSaveModal(false);
            } catch (err: any) {
              setSaveError(err.message);
            }
          }}
        />
      )}
    </div>
  );
}

function SaveScenarioModal({
  error,
  onClose,
  onSave,
}: {
  error: string | null;
  onClose: () => void;
  onSave: (name: string, desc: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    await onSave(name.trim(), desc.trim());
    setSaving(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="card-title" style={{ marginBottom: 12 }}>
          Save Scenario for Side-by-Side Comparison
        </div>
        {error && (
          <div style={{ color: '#c5221f', background: '#fdecec', padding: 8, borderRadius: 6, fontSize: '0.8rem', marginBottom: 10 }}>
            {error}
          </div>
        )}
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: 4 }}>
            Scenario Name *
          </label>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Board Proposal A (+5% ARPU)"
            autoFocus
          />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, marginBottom: 4 }}>
            Notes / Rationale
          </label>
          <input
            className="input"
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Optional summary for board meeting..."
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-outline" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!name.trim() || saving} onClick={submit}>
            {saving ? 'Saving...' : 'Save Scenario'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default App;
