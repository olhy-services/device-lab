import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { HttpExchange, LogLine, MetricsSample, ServerEvent } from '../shared/schema';
import { ADB, adb, NOT_RESPONDING, PACKAGE_RE, parseSections, PersistentShell, sectionsCommand } from './adb';
import { errorMessage } from './exec';
import {
  type CpuTimes,
  cpuPercent,
  parseBattery,
  parseCoreFreqs,
  parseCoreStats,
  parseCpuStat,
  parseFocus,
  parseGfxinfo,
  parseLogLine,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseThermal,
  parseVmRss,
} from './parse';
import { clearStaleProxy, DeviceProxy } from './proxy';

const SAMPLE_MS = 1_000;
const HISTORY = 120;
const LOG_RING = 5_000;
const LOG_FLUSH_MS = 200;
const IDLE_STOP_MS = 15_000;

type Listener = (event: ServerEvent) => void;

const BASE_COMMAND = sectionsCommand({
  stat: "grep '^cpu' /proc/stat",
  mem: "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  freq: 'grep . /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq',
  maxfreq: 'grep . /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq',
  thermal: 'dumpsys thermalservice',
  current: 'cat /sys/class/power_supply/battery/current_now',
  net: 'cat /proc/net/dev',
  bat: 'dumpsys battery',
  // mCurrentFocus fica null com painéis abertos; a atividade retomada é sempre a do app na tela.
  focus: 'dumpsys activity activities | grep -m 1 topResumedActivity',
});

/** O pacote já foi validado com PACKAGE_RE antes de entrar no comando. */
const appCommand = (pkg: string) =>
  `P=$(pidof -s ${pkg}); echo '@@pid'; echo "$P"; ` +
  `if [ -n "$P" ]; then echo '@@stat'; cat /proc/$P/stat; echo '@@status'; grep VmRSS /proc/$P/status; fi; ` +
  `echo '@@gfx'; dumpsys gfxinfo ${pkg} reset 2>/dev/null | grep -E 'Total frames rendered|Janky frames:|90th percentile'`;

interface Previous {
  at: number;
  cpu: CpuTimes | null;
  cores: Map<number, CpuTimes>;
  net: { rx: number; tx: number } | null;
  pkg: string | null;
  procTicks: number | null;
}

/**
 * Tudo o que acontece "ao vivo" num aparelho enquanto alguma aba está aberta:
 * métricas (1/s), logcat e o proxy de requisições.
 */
export class DeviceSession {
  private readonly listeners = new Set<Listener>();
  private readonly shell: PersistentShell;
  private readonly history: MetricsSample[] = [];
  private readonly logs: LogLine[] = [];
  private pendingLogs: LogLine[] = [];
  private logId = 0;
  private sampler: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private logcat: ChildProcessWithoutNullStreams | null = null;
  private logFlush: NodeJS.Timeout | null = null;
  private lastLogTime: string | null = null;
  private prev: Previous | null = null;
  private failing = false;
  private running = false;
  readonly proxy: DeviceProxy;

  constructor(readonly serial: string) {
    this.shell = new PersistentShell(serial);
    this.proxy = new DeviceProxy(serial, {
      exchange: (exchange: HttpExchange) => this.emit({ type: 'http', exchange }),
      tlsFailure: (failure) => this.emit({ type: 'tls-failure', failure }),
      status: (status) => this.emit({ type: 'proxy', status }),
    });
  }

  subscribe(listener: Listener): () => void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.listeners.add(listener);
    listener({
      type: 'snapshot',
      metrics: [...this.history],
      logs: [...this.logs],
      http: this.proxy.list(),
      proxy: this.proxy.status(),
    });
    if (!this.running) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.idleTimer = setTimeout(() => void this.pause(), IDLE_STOP_MS);
    };
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private start(): void {
    this.running = true;
    void clearStaleProxy(this.serial).then((cleared) => {
      if (cleared) {
        this.emit({
          type: 'device-error',
          message: 'O aparelho tinha um proxy de uma sessão anterior que caiu. Já removi; a internet dele voltou ao normal.',
        });
      }
    });
    const loop = async () => {
      if (!this.running) return;
      await this.sample();
      if (this.running) this.sampler = setTimeout(() => void loop(), this.failing ? SAMPLE_MS * 2 : SAMPLE_MS);
    };
    void loop();
    this.startLogcat();
  }

  /** Sem abas abertas: para de amostrar, mas mantém o proxy se estiver capturando. */
  private async pause(): Promise<void> {
    this.running = false;
    if (this.sampler) clearTimeout(this.sampler);
    this.sampler = null;
    this.shell.close();
    this.stopLogcat();
  }

  async dispose(): Promise<void> {
    await this.pause();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.proxy.stop().catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Métricas

  private async sample(): Promise<void> {
    try {
      const at = Date.now();
      const base = parseSections(await this.shell.exec(BASE_COMMAND, 6_000));
      const cpu = parseCpuStat(base.get('stat') ?? '');
      const coreTimes = parseCoreStats(base.get('stat') ?? '');
      const freqs = parseCoreFreqs(base.get('freq') ?? '');
      const maxFreqs = parseCoreFreqs(base.get('maxfreq') ?? '');
      const mem = parseMeminfo(base.get('mem') ?? '');
      const net = parseNetDev(base.get('net') ?? '');
      const focus = parseFocus(base.get('focus') ?? '');
      const prev = this.prev;
      const dt = prev ? (at - prev.at) / 1000 : 0;

      const pkg = focus && PACKAGE_RE.test(focus.pkg) ? focus.pkg : null;
      let app: MetricsSample['app'] = null;
      let pid: number | null = null;
      let procTicks: number | null = null;
      if (pkg) {
        const out = parseSections(await this.shell.exec(appCommand(pkg), 6_000));
        const parsedPid = Number.parseInt(out.get('pid') ?? '', 10);
        pid = Number.isFinite(parsedPid) ? parsedPid : null;
        procTicks = pid === null ? null : parseProcStat(out.get('stat') ?? '');
        const gfx = parseGfxinfo(out.get('gfx') ?? '');
        // Na primeira amostra de um app, o gfxinfo traz o acumulado desde sempre: não vale como taxa.
        const samePkg = prev?.pkg === pkg && dt > 0;
        const sameProcess = samePkg && prev.procTicks !== null && procTicks !== null && procTicks >= prev.procTicks;
        const dTotal = cpu && prev?.cpu ? cpu.total - prev.cpu.total : 0;
        app = {
          pkg,
          cpuPct:
            sameProcess && dTotal > 0 && procTicks !== null && prev.procTicks !== null
              ? Math.min(100, (100 * (procTicks - prev.procTicks)) / dTotal)
              : null,
          rssKb: parseVmRss(out.get('status') ?? ''),
          fps: samePkg && gfx ? gfx.frames / dt : null,
          jankPct: samePkg && gfx ? (gfx.frames > 0 ? (100 * gfx.janky) / gfx.frames : 0) : null,
          p90FrameMs: samePkg && gfx && gfx.frames > 0 ? gfx.p90Ms : null,
        };
      }

      const rate = (next: number | undefined, before: number | undefined) =>
        next === undefined || before === undefined || dt <= 0 || next < before ? null : (next - before) / dt;

      const sampleOut: MetricsSample = {
        t: at,
        cpuPct: cpuPercent(prev?.cpu ?? null, cpu),
        cores: [...coreTimes.keys()]
          .sort((a, b) => a - b)
          .map((core) => ({
            pct: cpuPercent(prev?.cores.get(core) ?? null, coreTimes.get(core) ?? null),
            freqMhz: freqs.get(core) ?? null,
            maxMhz: maxFreqs.get(core) ?? null,
          })),
        memUsedKb: mem ? mem.totalKb - mem.availableKb : 0,
        memTotalKb: mem?.totalKb ?? 0,
        memAvailableKb: mem?.availableKb ?? 0,
        swapTotalKb: mem?.swapTotalKb ?? 0,
        swapUsedKb: mem?.swapUsedKb ?? 0,
        temps: parseThermal(base.get('thermal') ?? ''),
        netRxBps: rate(net?.rx, prev?.net?.rx),
        netTxBps: rate(net?.tx, prev?.net?.tx),
        foreground: focus ? { ...focus, pid } : null,
        app,
        battery: parseBattery(base.get('bat') ?? '', base.get('current') ?? ''),
      };
      this.prev = { at, cpu, cores: coreTimes, net, pkg, procTicks };
      this.failing = false;
      this.history.push(sampleOut);
      if (this.history.length > HISTORY) this.history.shift();
      this.emit({ type: 'metrics', sample: sampleOut });
    } catch (error) {
      if (!this.running) return;
      this.prev = null;
      if (!this.failing) this.emit({ type: 'device-error', message: errorMessage(error) || NOT_RESPONDING });
      this.failing = true;
    }
  }

  // -------------------------------------------------------------------------
  // Logcat

  private startLogcat(): void {
    if (this.logcat) return;
    // Na volta (aba reaberta ou queda), continua de onde parou; na primeira vez, as últimas 500 linhas.
    const since = this.lastLogTime ? ['-T', this.lastLogTime] : ['-T', '500'];
    const child = spawn(ADB, ['-s', this.serial, 'logcat', '-v', 'threadtime', ...since], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.logcat = child;
    child.stdin.end();
    child.stdin.on('error', () => undefined);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => this.onLogLine(line));
    child.on('error', () => undefined);
    child.on('exit', () => {
      if (this.logcat !== child) return;
      this.logcat = null;
      // Caiu sozinho (aparelho sumiu): tenta de novo enquanto houver aba aberta.
      if (this.running) setTimeout(() => this.running && this.startLogcat(), 2_000);
    });
  }

  private stopLogcat(): void {
    const child = this.logcat;
    this.logcat = null;
    child?.kill();
    if (this.logFlush) clearTimeout(this.logFlush);
    this.logFlush = null;
    this.flushLogs();
  }

  private onLogLine(raw: string): void {
    const parsed = parseLogLine(raw);
    if (!parsed) return;
    if (this.lastLogTime && parsed.time < this.lastLogTime) return;
    this.lastLogTime = parsed.time;
    this.logId += 1;
    this.pendingLogs.push({ id: this.logId, ...parsed });
    this.logFlush ??= setTimeout(() => {
      this.logFlush = null;
      this.flushLogs();
    }, LOG_FLUSH_MS);
  }

  private flushLogs(): void {
    if (this.pendingLogs.length === 0) return;
    const batch = this.pendingLogs;
    this.pendingLogs = [];
    this.logs.push(...batch);
    if (this.logs.length > LOG_RING) this.logs.splice(0, this.logs.length - LOG_RING);
    this.emit({ type: 'logs', lines: batch });
  }

  async clearLogs(): Promise<void> {
    await adb(this.serial, ['logcat', '-c'], 8_000);
    this.logs.length = 0;
    this.pendingLogs = [];
    this.emit({ type: 'logs-cleared' });
  }

  clearHttp(): void {
    this.proxy.clear();
    this.emit({ type: 'http-cleared' });
  }
}

export class DeviceRegistry {
  private readonly sessions = new Map<string, DeviceSession>();

  get(serial: string): DeviceSession {
    let session = this.sessions.get(serial);
    if (!session) {
      session = new DeviceSession(serial);
      this.sessions.set(serial, session);
    }
    return session;
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.dispose()));
  }
}
