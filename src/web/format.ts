const nf = (digits: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits });
const nf0 = nf(0);
const nf1 = nf(1);

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${(value < 10 && unit > 0 ? nf1 : nf0).format(value)} ${units[unit]}`;
}

export const formatKb = (kb: number | null | undefined) =>
  kb === null || kb === undefined ? '—' : formatBytes(kb * 1024);

export function formatRate(bps: number | null | undefined): string {
  return bps === null || bps === undefined ? '—' : `${formatBytes(bps)}/s`;
}

export const formatPct = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${nf0.format(value)}%`;

export const formatNumber = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined ? '—' : nf(digits).format(value);

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${nf0.format(ms)} ms` : `${nf1.format(ms / 1000)} s`;
}

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}

export const formatClock = (t: number) =>
  new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
