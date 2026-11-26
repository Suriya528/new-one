import { useState, useRef } from 'react';
import {
  api,
  type KpiDefinition,
  type SimulationResponse,
} from '../api';
import { getPolarityClass } from '../utils';
import {
  Play,
  Upload,
  Copy,
  Check,
  AlertCircle,
  AlertTriangle,
  ShieldCheck,
  ShieldAlert,
  Sliders,
} from 'lucide-react';

interface Props {
  kpis: KpiDefinition[];
  onApplyToSimulator: (levers: Record<string, number>) => void;
}

const SAMPLE_SNIPPETS: Array<{ label: string; json: string }> = [
  {
    label: 'Golden Checkpoint',
    json: JSON.stringify({ marketing_spend: -0.2, arpu: 0.08, ctc_per_head: 0.05 }, null, 2),
  },
  {
    label: '-100% Marketing (0^0.35)',
    json: JSON.stringify({ marketing_spend: -1.0 }, null, 2),
  },
  {
    label: '+500% Marketing Stress',
    json: JSON.stringify({ marketing_spend: 5.0 }, null, 2),
  },
  {
    label: 'Zero Revenue Degenerate',
    json: JSON.stringify({ arpu: -1.0, rate_per_hour: -1.0 }, null, 2),
  },
  {
    label: 'Baseline {}',
    json: JSON.stringify({}, null, 2),
  },
];

export function JudgeMode({ kpis, onApplyToSimulator }: Props) {
  const [jsonText, setJsonText] = useState(SAMPLE_SNIPPETS[0].json);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResponse | null>(null);
  const [copied, setCopied] = useState<'csv' | 'json' | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const parseLeversFromInput = (raw: string): Record<string, number> => {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        'JSON must be an object mapping lever KPI IDs (e.g. {"arpu": 0.08}) or {"levers": {...}}.'
      );
    }
    if ('levers' in parsed && parsed.levers && typeof parsed.levers === 'object') {
      return parsed.levers as Record<string, number>;
    }
    return parsed as Record<string, number>;
  };

  const runJson = async (overrideText?: string) => {
    const src = overrideText ?? jsonText;
    setError(null);
    let levers: Record<string, number>;
    try {
      levers = parseLeversFromInput(src);
    } catch (e: any) {
      setError(`JSON Parse Error: ${e.message}`);
      return;
    }

    setRunning(true);
    try {
      const sim = await api.simulate(levers);
      setResult(sim);
    } catch (e: any) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const handleFileUpload = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || '');
      setJsonText(text);
      runJson(text);
    };
    reader.readAsText(file);
  };

  const copyCsv = async () => {
    if (!result) return;
    const header = 'sort_order,kpi_id,label,kind,unit,fy_rule,baseline_fy,scenario_fy,delta';
    const rows = kpis.map((k) => {
      const d = result.deltas[k.id];
      return `${k.sortOrder},${k.id},"${k.label}",${k.kind},${k.unit},${k.fyAggregation},${d.baselineFy.toFixed(2)},${d.scenarioFy.toFixed(2)},${d.deltaAbs.toFixed(2)}`;
    });
    await navigator.clipboard.writeText([header, ...rows].join('\n'));
    setCopied('csv');
    setTimeout(() => setCopied(null), 1800);
  };

  const copyJson = async () => {
    if (!result) return;
    const out: Record<string, { baseline: number; scenario: number; delta: number }> = {};
    for (const k of kpis) {
      const d = result.deltas[k.id];
      out[k.id] = {
        baseline: Number(d.baselineFy.toFixed(2)),
        scenario: Number(d.scenarioFy.toFixed(2)),
        delta: Number(d.deltaAbs.toFixed(2)),
      };
    }
    await navigator.clipboard.writeText(JSON.stringify(out, null, 2));
    setCopied('json');
    setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="sim-grid">
      {/* Left: JSON Input & Upload */}
      <aside>
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Run Scenario JSON (Judge Mode)</div>
              <div className="card-subtitle">
                Paste or upload a levers JSON object to evaluate all 27 FY KPIs via the backend API
              </div>
            </div>
          </div>

          <div className="tag-row" style={{ marginBottom: 10 }}>
            {SAMPLE_SNIPPETS.map((s) => (
              <button
                key={s.label}
                className="btn btn-outline btn-sm"
                onClick={() => {
                  setJsonText(s.json);
                  runJson(s.json);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          <textarea
            className="input num"
            aria-label="Scenario JSON Input"
            rows={11}
            style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8rem', resize: 'vertical' }}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            placeholder='{"marketing_spend": -0.2, "arpu": 0.08, "ctc_per_head": 0.05}'
          />

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => handleFileUpload(e.target.files?.[0])}
          />

          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={() => runJson()}
              disabled={running}
            >
              <Play size={14} /> {running ? 'Running...' : 'Run Scenario JSON'}
            </button>
            <button
              className="btn btn-outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={14} /> Upload .json
            </button>
            {result && (
              <button
                className="btn btn-outline"
                onClick={() => onApplyToSimulator(result.levers)}
              >
                <Sliders size={14} /> Load in Sliders
              </button>
            )}
          </div>

          {error && (
            <div
              className="covenant-banner"
              style={{ marginTop: 14, marginBottom: 0, padding: '10px 12px' }}
              role="alert"
            >
              <AlertCircle size={18} style={{ flexShrink: 0 }} />
              <div style={{ fontSize: '0.82rem' }}>{error}</div>
            </div>
          )}
        </div>
      </aside>

      {/* Right: All 27 FY KPIs strictly formatted to 2 decimals */}
      <div>
        {!result ? (
          <div className="card" style={{ textAlign: 'center', padding: '48px 20px', color: '#627d98' }}>
            <div style={{ fontWeight: 700, color: '#0f2537', marginBottom: 6 }}>
              Ready for Unseen Judge Scenarios
            </div>
            <p style={{ fontSize: '0.85rem', marginBottom: 14 }}>
              Paste any lever JSON or pick a preset on the left and click <strong>Run Scenario JSON</strong> to inspect all 27 FY KPI values with 2-decimal precision.
            </p>
            <button className="btn btn-primary btn-sm" onClick={() => runJson()}>
              <Play size={14} /> Run Current JSON
            </button>
          </div>
        ) : (
          <>
            {result.warnings.length > 0 && (
              <div className="warning-banner">
                <AlertTriangle size={20} style={{ flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div className="covenant-banner-title">
                    Degenerate / Boundary Condition Detected ({result.warnings.length})
                  </div>
                  <div className="covenant-banner-list">
                    {result.warnings.map((w) => (
                      <div key={w.code}>
                        <strong>{w.title}:</strong> {w.detail}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-header" style={{ flexWrap: 'wrap' }}>
                <div>
                  <div className="card-title">
                    All 27 FY KPIs — Exact 2-Decimal Output
                  </div>
                  <div className="card-subtitle">
                    Guardrails:{' '}
                    {result.guardrails.every((g) => g.passed) ? (
                      <span style={{ color: '#0e7c47', fontWeight: 700 }}>
                        <ShieldCheck size={13} style={{ verticalAlign: 'middle' }} /> ALL 4 PASSING
                      </span>
                    ) : (
                      <span style={{ color: '#c5221f', fontWeight: 700 }}>
                        <ShieldAlert size={13} style={{ verticalAlign: 'middle' }} />{' '}
                        {result.guardrails
                          .filter((g) => !g.passed)
                          .map((g) => `${g.id} (${g.actual.toFixed(2)} vs ${g.limit})`)
                          .join(', ')}
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-outline btn-sm" onClick={copyCsv}>
                    {copied === 'csv' ? <Check size={14} /> : <Copy size={14} />}
                    {copied === 'csv' ? 'Copied CSV' : 'Copy CSV (2dp)'}
                  </button>
                  <button className="btn btn-outline btn-sm" onClick={copyJson}>
                    {copied === 'json' ? <Check size={14} /> : <Copy size={14} />}
                    {copied === 'json' ? 'Copied JSON' : 'Copy JSON (2dp)'}
                  </button>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th style={{ textAlign: 'left' }}>KPI ID &amp; Label</th>
                      <th>Unit</th>
                      <th>FY Rule</th>
                      <th>Baseline FY (2dp)</th>
                      <th>Scenario FY (2dp)</th>
                      <th>Delta (2dp)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kpis.map((kpi) => {
                      const d = result.deltas[kpi.id];
                      const pol = getPolarityClass(d.deltaAbs, kpi.goodWhen);
                      return (
                        <tr key={kpi.id}>
                          <td className="num" style={{ color: '#627d98' }}>{kpi.sortOrder}</td>
                          <td style={{ textAlign: 'left' }}>
                            <div style={{ fontWeight: 600 }}>{kpi.label}</div>
                            <code style={{ fontSize: '0.72rem', color: '#627d98' }}>{kpi.id}</code>
                          </td>
                          <td><code>{kpi.unit}</code></td>
                          <td><code>{kpi.fyAggregation}</code></td>
                          <td className="num">{d.baselineFy.toFixed(2)}</td>
                          <td className="num" style={{ fontWeight: 700 }}>{d.scenarioFy.toFixed(2)}</td>
                          <td
                            className={`num ${
                              pol === 'good' ? 'delta-good' : pol === 'bad' ? 'delta-bad' : ''
                            }`}
                          >
                            {d.deltaAbs > 0 ? '+' : ''}{d.deltaAbs.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
