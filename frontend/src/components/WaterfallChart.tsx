import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { type WaterfallDriver } from '../api';

interface Props {
  drivers: WaterfallDriver[];
}

interface WaterfallDatum {
  label: string;
  range: [number, number];
  rawImpact: number;
  runningEnd: number;
  fill: string;
  isSubtotal: boolean;
}

export function WaterfallChart({ drivers }: Props) {
  let running = 0;

  const data: WaterfallDatum[] = drivers.map((d) => {
    if (d.category === 'subtotal') {
      if (d.id === 'baseline_net_profit') {
        running = d.impactUsdK;
      }
      const val = d.impactUsdK;
      return {
        label: d.label.replace(' Net Profit', ''),
        range: [Math.min(0, val), Math.max(0, val)],
        rawImpact: val,
        runningEnd: val,
        fill: d.id === 'baseline_net_profit' ? '#334e68' : '#0b69ff',
        isSubtotal: true,
      };
    }

    const start = running;
    const end = running + d.impactUsdK;
    running = end;

    return {
      label: d.label.replace(' (Loaded)', '').replace(' (25% YTD)', ''),
      range: [Math.min(start, end), Math.max(start, end)],
      rawImpact: d.impactUsdK,
      runningEnd: end,
      fill: Math.abs(d.impactUsdK) < 0.005 ? '#9fb3c8' : d.impactUsdK >= 0 ? '#0e7c47' : '#c5221f',
      isSubtotal: false,
    };
  });

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 12, right: 14, left: 4, bottom: 28 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="label"
            stroke="#627d98"
            fontSize={11}
            angle={-25}
            textAnchor="end"
            interval={0}
            height={52}
          />
          <YAxis stroke="#627d98" fontSize={11} tickFormatter={(v: number) => `$${v}K`} />
          <ReferenceLine y={0} stroke="#bcccdc" />
          <Tooltip
            content={({ active, payload }: { active?: boolean; payload?: readonly { payload?: unknown }[] }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]?.payload as WaterfallDatum | undefined;
              if (!row) return null;
              return (
                <div
                  style={{
                    background: '#0f2537',
                    color: '#fff',
                    padding: '8px 11px',
                    borderRadius: 7,
                    fontSize: '0.78rem',
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 2 }}>{row.label}</div>
                  <div>
                    {row.isSubtotal ? 'Net Profit: ' : 'Profit Impact: '}
                    <strong>
                      {!row.isSubtotal && row.rawImpact > 0 ? '+' : ''}${row.rawImpact.toFixed(2)}K
                    </strong>
                  </div>
                  {!row.isSubtotal && (
                    <div style={{ color: '#cbd5e1', fontSize: '0.72rem', marginTop: 2 }}>
                      Running Subtotal: ${row.runningEnd.toFixed(2)}K
                    </div>
                  )}
                </div>
              );
            }}
          />
          <Bar dataKey="range" minPointSize={2} radius={[3, 3, 3, 3]} isAnimationActive={false}>
            {data.map((entry, idx) => (
              <Cell key={idx} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
