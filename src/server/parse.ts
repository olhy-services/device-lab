import { z } from 'zod';

import { type LogLevel, LogLevelSchema } from '../shared/schema';

/**
 * Leitores das saídas de texto do Android (`/proc`, `dumpsys`, `logcat`, `pm`).
 * Funções puras para poderem ser testadas sem aparelho.
 */

const int = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

const num = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

export interface CpuTimes {
  total: number;
  idle: number;
}

/** Primeira linha do `/proc/stat`: `cpu  user nice system idle iowait irq softirq steal ...`. */
export function parseCpuStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((v) => !Number.isFinite(v))) return null;
  // guest/guest_nice já estão contados em user/nice.
  const total = values.slice(0, 8).reduce((sum, v) => sum + v, 0);
  const idle = (values[3] ?? 0) + (values[4] ?? 0);
  return { total, idle };
}

export function cpuPercent(prev: CpuTimes | null, next: CpuTimes | null): number | null {
  if (!prev || !next) return null;
  const total = next.total - prev.total;
  if (total <= 0) return null;
  return clampPct((100 * (total - (next.idle - prev.idle))) / total);
}

const clampPct = (value: number) => Math.min(100, Math.max(0, value));

/** `/proc/meminfo` em kB. */
export function parseMeminfo(text: string) {
  const field = (name: string) => int(new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)?.[1]);
  const totalKb = field('MemTotal');
  const availableKb = field('MemAvailable');
  if (totalKb === null || availableKb === null) return null;
  const swapTotalKb = field('SwapTotal') ?? 0;
  return { totalKb, availableKb, swapTotalKb, swapUsedKb: swapTotalKb - (field('SwapFree') ?? swapTotalKb) };
}

/** Soma de bytes recebidos/enviados de todas as interfaces, menos a de loopback. */
export function parseNetDev(text: string): { rx: number; tx: number } | null {
  let rx = 0;
  let tx = 0;
  let seen = false;
  for (const line of text.split('\n')) {
    const match = /^\s*([^:\s]+):\s*(.*)$/.exec(line);
    if (!match?.[1] || match[2] === undefined || match[1] === 'lo') continue;
    const fields = match[2].trim().split(/\s+/).map(Number);
    const rxBytes = fields[0];
    const txBytes = fields[8];
    if (rxBytes === undefined || txBytes === undefined || !Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    rx += rxBytes;
    tx += txBytes;
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

const BATTERY_HEALTH: Record<number, string> = {
  2: 'Boa',
  3: 'Superaquecida',
  4: 'Morta',
  5: 'Sobretensão',
  6: 'Falha',
  7: 'Fria',
};

export function parseBattery(text: string, currentNowText = '') {
  const field = (name: string) => int(new RegExp(`^\\s*${name}:\\s*(-?\\d+)`, 'm').exec(text)?.[1]);
  const flag = (name: string) => new RegExp(`^\\s*${name}:\\s*true`, 'm').test(text);
  const level = field('level');
  const temp = field('temperature');
  const voltage = field('voltage');
  const status = field('status');
  const health = field('health');
  if (level === null || temp === null) return null;
  const microAmps = int(currentNowText.trim());
  const source = flag('AC powered') ? 'Tomada' : flag('USB powered') ? 'USB' : flag('Wireless powered') ? 'Sem fio' : null;
  return {
    level,
    tempC: temp / 10,
    // BatteryManager.BATTERY_STATUS_CHARGING = 2, FULL = 5 (ainda na tomada).
    charging: status === 2 || status === 5,
    voltageMv: voltage ?? 0,
    // Alguns aparelhos já informam em mA; acima de 20 A só pode ser µA.
    currentMa: microAmps === null ? null : Math.abs(microAmps) > 20_000 ? Math.abs(microAmps) / 1000 : Math.abs(microAmps),
    health: health === null ? null : (BATTERY_HEALTH[health] ?? null),
    source,
    technology: /^\s*technology:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
  };
}

/** `mCurrentFocus=Window{4f1 u0 com.app/com.app.MainActivity}`. */
export function parseFocus(text: string): { pkg: string; activity: string } | null {
  const match = /\bu\d+\s+([A-Za-z][\w.]*)\/([\w.$]+)/.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const activity = match[2].startsWith('.') ? `${match[1]}${match[2]}` : match[2];
  return { pkg: match[1], activity };
}

/** `/proc/<pid>/stat`: tempo de CPU (utime + stime) em ticks. */
export function parseProcStat(text: string): number | null {
  const end = text.lastIndexOf(')');
  if (end < 0) return null;
  // Depois do nome do processo, os campos começam no 3º (state).
  const rest = text.slice(end + 2).trim().split(/\s+/);
  const utime = int(rest[11]);
  const stime = int(rest[12]);
  if (utime === null || stime === null) return null;
  return utime + stime;
}

export function parseVmRss(text: string): number | null {
  return int(/^VmRSS:\s+(\d+)\s*kB/m.exec(text)?.[1]);
}

export interface GfxStats {
  frames: number;
  janky: number;
  p90Ms: number | null;
}

/** `dumpsys gfxinfo <pkg>`: totais desde o último `reset`. */
export function parseGfxinfo(text: string): GfxStats | null {
  const frames = int(/Total frames rendered:\s*(\d+)/.exec(text)?.[1]);
  if (frames === null) return null;
  return {
    frames,
    janky: int(/Janky frames:\s*(\d+)/.exec(text)?.[1]) ?? 0,
    p90Ms: num(/90th percentile:\s*([\d.]+)\s*ms/.exec(text)?.[1]),
  };
}

/** `wm size` / `wm density`: o valor sobrescrito (Override) vale mais que o físico. */
export function parseWm(sizeText: string, densityText: string) {
  const size =
    /Override size:\s*(\d+)x(\d+)/.exec(sizeText) ?? /Physical size:\s*(\d+)x(\d+)/.exec(sizeText);
  const density = /Override density:\s*(\d+)/.exec(densityText) ?? /Physical density:\s*(\d+)/.exec(densityText);
  return {
    width: int(size?.[1]) ?? 0,
    height: int(size?.[2]) ?? 0,
    density: int(density?.[1]) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Logcat (`-v threadtime`)

export interface ParsedLog {
  time: string;
  pid: number;
  tid: number;
  level: LogLevel;
  tag: string;
  message: string;
}

const LOG_RE = /^(\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*:\s?(.*)$/;

export function parseLogLine(line: string): ParsedLog | null {
  const match = LOG_RE.exec(line);
  if (!match) return null;
  const [, time, pid, tid, level, tag, message] = match;
  const parsedLevel = LogLevelSchema.safeParse(level);
  if (!time || !parsedLevel.success || tag === undefined || message === undefined) return null;
  return {
    time: time.replace(/\s+/, ' '),
    pid: int(pid) ?? 0,
    tid: int(tid) ?? 0,
    level: parsedLevel.data,
    tag,
    message,
  };
}

// ---------------------------------------------------------------------------
// Pacotes e armazenamento

export function parsePackageList(text: string): { pkg: string; versionCode: number | null }[] {
  const out: { pkg: string; versionCode: number | null }[] = [];
  for (const line of text.split('\n')) {
    const match = /^package:(\S+)(?:\s+versionCode:(\d+))?/.exec(line.trim());
    if (match?.[1]) out.push({ pkg: match[1], versionCode: int(match[2]) });
  }
  return out;
}

const StringArray = z.array(z.string());
const NumberArray = z.array(z.number());

function jsonArray<T>(schema: z.ZodType<T>, text: string, label: string): T | null {
  const raw = new RegExp(`^${label}:\\s*(\\[.*\\])\\s*$`, 'm').exec(text)?.[1];
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface PackageSizes {
  app: number;
  data: number;
  cache: number;
}

/** Tamanhos por app, calculados pelo sistema e publicados no `dumpsys diskstats`. */
export function parseDiskstatsPackages(text: string): Map<string, PackageSizes> {
  const names = jsonArray(StringArray, text, 'Package Names');
  const apps = jsonArray(NumberArray, text, 'App Sizes');
  const data = jsonArray(NumberArray, text, 'App Data Sizes');
  const cache = jsonArray(NumberArray, text, 'Cache Sizes');
  const out = new Map<string, PackageSizes>();
  if (!names) return out;
  names.forEach((name, i) => {
    out.set(name, { app: apps?.[i] ?? 0, data: data?.[i] ?? 0, cache: cache?.[i] ?? 0 });
  });
  return out;
}

const BREAKDOWN: readonly { key: string; label: string; field: string }[] = [
  { key: 'apps', label: 'Apps', field: 'App Size' },
  { key: 'appData', label: 'Dados de apps', field: 'App Data Size' },
  { key: 'cache', label: 'Cache de apps', field: 'App Cache Size' },
  { key: 'photos', label: 'Fotos', field: 'Photos Size' },
  { key: 'videos', label: 'Vídeos', field: 'Videos Size' },
  { key: 'audio', label: 'Áudio', field: 'Audio Size' },
  { key: 'downloads', label: 'Downloads', field: 'Downloads Size' },
  { key: 'other', label: 'Outros', field: 'Other Size' },
];

export function parseDiskstats(text: string) {
  const dataFree = /Data-Free:\s*(\d+)K\s*\/\s*(\d+)K total/.exec(text);
  const breakdown = BREAKDOWN.flatMap(({ key, label, field }) => {
    const bytes = int(new RegExp(`^${field}:\\s*(\\d+)`, 'm').exec(text)?.[1]);
    return bytes === null || bytes <= 0 ? [] : [{ key, label, bytes }];
  });
  return {
    freeBytes: (int(dataFree?.[1]) ?? 0) * 1024,
    totalBytes: (int(dataFree?.[2]) ?? 0) * 1024,
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Processos (`top -b -n 2 -d 1 -o PID,PPID,USER,%CPU,RES,S,NAME`)

export interface TopProcess {
  pid: number;
  ppid: number;
  user: string;
  /** Como o top mostra: 100% = um núcleo inteiro. */
  cpu: number;
  rssKb: number;
  state: string;
  name: string;
}

const SIZE_UNIT: Record<string, number> = { K: 1, M: 1024, G: 1024 * 1024, T: 1024 * 1024 * 1024 };

/** `144M`, `7.3M`, `512K`, `1.2G` ou bytes puros → kB. */
export function parseSizeKb(value: string): number {
  const match = /^([\d.]+)([KMGT])?$/i.exec(value.trim());
  if (!match?.[1]) return 0;
  const n = Number.parseFloat(match[1]);
  const unit = match[2]?.toUpperCase();
  return unit ? n * (SIZE_UNIT[unit] ?? 1) : n / 1024;
}

/** Usa o último quadro do top (o primeiro não tem intervalo para medir CPU). */
export function parseTop(text: string): { cores: number; processes: TopProcess[] } {
  const frames = text.split(/^Tasks:/m);
  const frame = frames.at(-1) ?? '';
  const cores = Math.max(1, Math.round((int(/(\d+)%cpu/.exec(frame)?.[1]) ?? 100) / 100));
  const processes: TopProcess[] = [];
  for (const line of frame.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\S+)\s+(\S)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, user, cpu, res, state, name] = match;
    if (!pid || !ppid || !user || !cpu || !res || !state || !name) continue;
    processes.push({
      pid: Number(pid),
      ppid: Number(ppid),
      user,
      cpu: Number(cpu),
      rssKb: parseSizeKb(res),
      state,
      name,
    });
  }
  return { cores, processes };
}

// ---------------------------------------------------------------------------
// Sockets (`/proc/net/tcp`, `tcp6`, `udp`, `udp6`)

const TCP_STATES: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};

/** Cada palavra de 32 bits vem em little-endian (ordem do kernel no ARM/x86). */
function hexIp(hex: string): string {
  const words = hex.match(/.{8}/g) ?? [];
  const bytes = words.flatMap((w) => [6, 4, 2, 0].map((i) => Number.parseInt(w.slice(i, i + 2), 16)));
  if (bytes.length === 4) return bytes.join('.');
  // IPv4 mapeado em IPv6 (::ffff:a.b.c.d) vira IPv4.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255) return bytes.slice(12).join('.');
  if (bytes.every((b) => b === 0)) return '::';
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  // Comprime a maior sequência de grupos zerados (RFC 5952).
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  const parts = groups.map((g) => g.toString(16));
  if (best.len < 2) return parts.join(':');
  return `${parts.slice(0, best.start).join(':')}::${parts.slice(best.start + best.len).join(':')}`;
}

export interface ProcSocket {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  state: string;
  uid: number;
}

export function parseProcNet(text: string, udp: boolean): ProcSocket[] {
  const out: ProcSocket[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const [, local, remote, st, , , , uid] = cols;
    if (!local || !remote || !st || uid === undefined || !/^\d+:$/.test(cols[0] ?? '')) continue;
    const [lip, lport] = local.split(':');
    const [rip, rport] = remote.split(':');
    if (!lip || !lport || !rip || !rport) continue;
    out.push({
      localIp: hexIp(lip),
      localPort: Number.parseInt(lport, 16),
      remoteIp: hexIp(rip),
      remotePort: Number.parseInt(rport, 16),
      state: udp ? (st === '07' ? 'UNCONN' : 'ESTABLISHED') : (TCP_STATES[st.toUpperCase()] ?? st),
      uid: Number(uid),
    });
  }
  return out;
}

/** `pm list packages -U` → UID para pacote(s). Apps com UID compartilhado juntam os nomes. */
export function parseUidPackages(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const match = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const uid = Number(match[2]);
    const current = out.get(uid);
    out.set(uid, current ? `${current}, ${match[1]}` : match[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pastas: linhas `link<TAB>tamanho|mtime|modo|tipo<TAB>nome`

export interface ParsedEntry {
  name: string;
  link: boolean;
  sizeBytes: number;
  modifiedAt: number;
  mode: string;
  kind: 'dir' | 'file' | 'other';
}

export function parseListing(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const line of text.split('\n')) {
    const [link, stat, ...nameParts] = line.split('\t');
    const name = nameParts.join('\t');
    if (!stat || !name || name === '.' || name === '..') continue;
    const [size, mtime, mode, type] = stat.split('|');
    out.push({
      name,
      link: link === '1',
      sizeBytes: int(size) ?? 0,
      modifiedAt: (int(mtime) ?? 0) * 1000,
      mode: mode ?? '',
      kind: type === 'directory' ? 'dir' : type?.startsWith('regular') ? 'file' : 'other',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Núcleos e temperaturas

/** Linhas `cpuN` do `/proc/stat`, na ordem do núcleo. */
export function parseCoreStats(text: string): Map<number, CpuTimes> {
  const out = new Map<number, CpuTimes>();
  for (const line of text.split('\n')) {
    const match = /^cpu(\d+)\s/.exec(line);
    if (!match?.[1]) continue;
    const times = parseCpuStat(`cpu ${line.slice(match[0].length)}`);
    if (times) out.set(Number(match[1]), times);
  }
  return out;
}

/** `grep . /sys/devices/system/cpu/cpu*\/cpufreq/scaling_cur_freq` → núcleo para MHz. */
export function parseCoreFreqs(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const match = /cpu(\d+)\/cpufreq\/\w+:(\d+)/.exec(line);
    if (match?.[1] && match[2]) out.set(Number(match[1]), Number(match[2]) / 1000);
  }
  return out;
}

const THERMAL_NAMES: Record<string, string> = {
  CPU: 'CPU',
  GPU: 'GPU',
  BATTERY: 'Bateria',
  SKIN: 'Superfície',
  NPU: 'NPU',
  POWER_AMPLIFIER: 'Rádio (amplificador)',
  USB_PORT: 'Porta USB',
  DISPLAY: 'Tela',
  MODEM: 'Modem',
  SOC: 'Processador (SoC)',
  WIFI: 'Wi-Fi',
  SPEAKER: 'Alto-falante',
  CAMERA: 'Câmera',
  FLASHLIGHT: 'Lanterna',
};

/** `dumpsys thermalservice`: só o bloco "Current temperatures from HAL", sem leituras inválidas. */
export function parseThermal(text: string): { name: string; c: number }[] {
  const start = text.indexOf('Current temperatures from HAL:');
  if (start < 0) return [];
  const rest = text.slice(start);
  const end = rest.indexOf('Current cooling');
  const block = end < 0 ? rest : rest.slice(0, end);
  const out: { name: string; c: number }[] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(/mValue=(-?[\d.]+),\s*mType=-?\d+,\s*mName=([^,}]+)/g)) {
    const c = num(match[1]);
    const raw = match[2]?.trim();
    if (c === null || !raw || c < -40 || c > 150 || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ name: THERMAL_NAMES[raw] ?? raw, c });
  }
  return out;
}
