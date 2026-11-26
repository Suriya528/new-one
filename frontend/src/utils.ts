export function formatKpiValue(value: number, unit: string, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';

  switch (unit) {
    case 'usd_k': {
      const d = decimals ?? 2;
      const abs = Math.abs(value).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
      return value < 0 ? `-$${abs}K` : `$${abs}K`;
    }
    case 'usd': {
      const d = decimals ?? 0;
      const abs = Math.abs(value).toLocaleString('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      });
      return value < 0 ? `-$${abs}` : `$${abs}`;
    }
    case 'pct':
      return `${value.toFixed(decimals ?? 2)}%`;
    case 'count':
      return Math.round(value).toLocaleString('en-US');
    default:
      return value.toFixed(2);
  }
}

export function formatSignedDelta(delta: number, unit: string): string {
  if (!Number.isFinite(delta) || Math.abs(delta) < 1e-6) {
    return unit === 'usd_k' ? '$0.00K' : '0';
  }
  const sign = delta > 0 ? '+' : '-';
  const abs = Math.abs(delta);
  switch (unit) {
    case 'usd_k':
      return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}K`;
    case 'usd':
      return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    case 'pct':
      return `${sign}${abs.toFixed(2)}pp`;
    case 'count':
      return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
    default:
      return `${sign}${abs.toFixed(2)}`;
  }
}

export function formatPctDelta(deltaPct: number | null): string {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return '—';
  if (Math.abs(deltaPct) < 0.005) return '0.0%';
  return `${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(2)}%`;
}

export function formatLeverPct(val: number): string {
  const pct = val * 100;
  if (Math.abs(pct) < 0.05) return '0%';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(0)}%`;
}

export function monthShortName(label: string): string {
  const parts = label.split('-');
  if (parts.length !== 2) return label;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const idx = parseInt(parts[1], 10) - 1;
  return `${names[idx] ?? parts[1]} '${parts[0].slice(2)}`;
}

export function getPolarityClass(
  delta: number,
  goodWhen: 'up' | 'down' | 'neutral'
): 'good' | 'bad' | 'neutral' {
  if (Math.abs(delta) < 1e-5 || goodWhen === 'neutral') return 'neutral';
  if (goodWhen === 'up') return delta > 0 ? 'good' : 'bad';
  return delta < 0 ? 'good' : 'bad';
}
