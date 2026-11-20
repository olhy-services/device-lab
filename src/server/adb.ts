import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Device, DeviceList } from '../shared/schema';
import { CommandError, isMissingBinary, run, runBuffer } from './exec';

function resolveAdb(): string {
  const fromEnv = process.env.DEVICE_LAB_ADB;
  if (fromEnv) return fromEnv;
  const roots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(homedir(), 'Android', 'Sdk'),
    join(homedir(), 'Library', 'Android', 'sdk'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : undefined,
  ];
  for (const root of roots) {
    if (!root) continue;
    const bin = join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    if (existsSync(bin)) return bin;
  }
  return 'adb';
}

export const ADB = resolveAdb();

export const NOT_RESPONDING =
  'O aparelho não responde. Ele pode ter saído do Wi-Fi, bloqueado a tela com economia de energia ou travado.';

export const adb = (serial: string, args: readonly string[], timeoutMs = 10_000) =>
  run(ADB, ['-s', serial, ...args], timeoutMs);

export const adbBuffer = (serial: string, args: readonly string[], timeoutMs = 15_000) =>
  runBuffer(ADB, ['-s', serial, ...args], timeoutMs);

/** Comando no shell do aparelho. Valores de fora entram sempre via `quote`. */
export const shell = async (serial: string, command: string, timeoutMs = 10_000) =>
  (await adb(serial, ['shell', command], timeoutMs)).stdout;

/** Aspas simples para o `sh` do aparelho. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export const PACKAGE_RE = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;

/**
 * Vários comandos numa ida só, cada saída separada por um marcador.
 * `parseSections` devolve a saída de cada um pelo nome.
 */
export function sectionsCommand(commands: Record<string, string>): string {
  return Object.entries(commands)
    .map(([name, command]) => `echo '@@${name}'; { ${command} ; } 2>/dev/null`)
    .join('; ');
}

export function parseSections(output: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = output.split(/^@@(\w+)\r?$/m);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const name = parts[i];
    const body = parts[i + 1];
    if (name !== undefined && body !== undefined) out.set(name, body.trim());
  }
  return out;
}

/** `192.168.0.10:5555` (adb tcpip) ou `adb-XXXX._adb-tls-connect._tcp` (depuração por Wi-Fi). */
export function isWifiSerial(serial: string): boolean {
  return /^[\d.]+:\d+$/.test(serial) || serial.includes('._adb-tls-connect.');
}

export async function listDevices(): Promise<DeviceList> {
  let stdout: string;
  try {
    ({ stdout } = await run(ADB, ['devices', '-l'], 8_000));
  } catch (error) {
    if (isMissingBinary(error)) return { adb: false, devices: [] };
    throw error;
  }

  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices') && !line.startsWith('*'));

  const devices = await Promise.all(
    lines.map(async (line): Promise<Device | null> => {
      const [serial, state, ...rest] = line.split(/\s+/);
      if (!serial || !state) return null;
      const model = rest.find((t) => t.startsWith('model:'))?.slice('model:'.length).replaceAll('_', ' ') ?? serial;
      const connection = serial.startsWith('emulator-') ? 'emulator' : isWifiSerial(serial) ? 'wifi' : 'usb';
      const base = { serial, model, connection } as const;

      if (state === 'unauthorized') return { ...base, unavailableReason: 'Autorize a depuração USB na tela do aparelho' };
      if (state === 'offline') return { ...base, unavailableReason: 'Offline para o adb. Reconecte o cabo ou o Wi-Fi.' };
      if (state !== 'device') return { ...base, unavailableReason: `Estado do adb: ${state}` };

      // O adb continua dizendo "device" por um tempo quando o Wi-Fi do celular cai.
      try {
        await shell(serial, 'echo ok', 4_000);
      } catch {
        return { ...base, unavailableReason: NOT_RESPONDING };
      }
      return { ...base, unavailableReason: null };
    }),
  );

  return { adb: true, devices: devices.filter((d) => d !== null) };
}

// ---------------------------------------------------------------------------
// Depuração por Wi-Fi

export async function adbPair(host: string, port: number, code: string): Promise<string> {
  const { stdout } = await run(ADB, ['pair', `${host}:${port}`, code], 20_000).catch((error: unknown) => {
    throw new Error(`Não pareou: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!/successfully paired/i.test(stdout)) throw new Error(`Não pareou: ${stdout.trim() || 'sem resposta'}`);
  return 'Pareado. Agora conecte usando o IP e a porta da tela principal de Depuração por Wi-Fi.';
}

export async function adbConnect(host: string, port: number): Promise<string> {
  const { stdout } = await run(ADB, ['connect', `${host}:${port}`], 15_000);
  const out = stdout.trim();
  // `adb connect` sai com 0 mesmo quando falha; o resultado está no texto.
  if (/failed|cannot|unable|refused|no route/i.test(out) || !/connected to/i.test(out)) {
    throw new Error(
      `Não conectou em ${host}:${port}. Confira se o celular está na mesma rede e se a porta é a da tela ` +
        `principal (não a do pareamento). Resposta do adb: ${out || 'vazia'}`,
    );
  }
  return `Conectado em ${host}:${port}.`;
}

/** Derruba a conexão pendurada de um aparelho Wi-Fi que parou de responder. */
export async function adbDisconnect(serial: string): Promise<void> {
  await run(ADB, ['disconnect', serial], 5_000).catch(() => undefined);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Com o cabo ligado: ativa o adb pela rede na porta 5555 e conecta pelo IP do Wi-Fi do celular. */
export async function switchToWifi(serial: string): Promise<string> {
  const out = await shell(serial, 'ip -f inet addr show wlan0', 5_000);
  const ip = /inet (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1];
  if (!ip) throw new Error('O celular não está conectado a uma rede Wi-Fi.');
  await adb(serial, ['tcpip', '5555']);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(1200);
    try {
      await adbConnect(ip, 5555);
      return `Conectado pelo Wi-Fi em ${ip}:5555. Pode tirar o cabo.`;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Não conectou pelo Wi-Fi');
}

export async function discoverWifi(): Promise<{ name: string; kind: 'pairing' | 'connect'; host: string; port: number }[]> {
  const { stdout } = await run(ADB, ['mdns', 'services'], 5_000).catch(() => ({ stdout: '' }));
  const out: { name: string; kind: 'pairing' | 'connect'; host: string; port: number }[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([\d.]+):(\d+)/.exec(line.trim());
    if (!match) continue;
    const [, name, kind, host, port] = match;
    if (!name || !host || !port || (kind !== 'pairing' && kind !== 'connect')) continue;
    out.push({ name, kind, host, port: Number(port) });
  }
  return out;
}

// ---------------------------------------------------------------------------

/**
 * Uma sessão `adb shell` aberta para comandos frequentes (métricas a cada
 * segundo). Abrir um `adb shell` por comando custa ~100 ms; pela mesma
 * conexão são poucos ms. Um comando por vez; quem chama evita sobreposição.
 */
export class PersistentShell {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private seq = 0;
  private pending: { marker: string; resolve: (out: string) => void; reject: (e: Error) => void } | null = null;

  constructor(private readonly serial: string) {}

  get busy(): boolean {
    return this.pending !== null;
  }

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(ADB, ['-s', this.serial, 'shell'], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const onData = (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const fail = (message: string) => {
      if (this.child !== child) return;
      this.child = null;
      this.buffer = '';
      this.pending?.reject(new CommandError(message, null));
      this.pending = null;
    };
    child.on('exit', () => fail('Aparelho desconectado do adb'));
    child.on('error', (error) => fail(error.message));
    // Escrever num shell que já morreu gera EPIPE: sem este handler o processo inteiro cai.
    child.stdin.on('error', () => fail('Aparelho desconectado do adb'));
    this.child = child;
    return child;
  }

  private flush(): void {
    const pending = this.pending;
    if (!pending) return;
    const match = new RegExp(`${pending.marker} (\\d+)`).exec(this.buffer);
    if (!match) return;
    const output = this.buffer.slice(0, match.index);
    this.buffer = this.buffer.slice(match.index + match[0].length).replace(/^\r?\n/, '');
    this.pending = null;
    pending.resolve(output);
  }

  exec(command: string, timeoutMs = 5_000): Promise<string> {
    if (this.pending) return Promise.reject(new Error('Comando anterior ainda em andamento'));
    const child = this.ensure();
    this.seq += 1;
    const marker = `__DEVLAB_${this.seq}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CommandError(NOT_RESPONDING, null, true));
        this.close();
      }, timeoutMs);
      this.pending = {
        marker,
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      if (child.stdin.writable) {
        child.stdin.write(`{ ${command} ; } 2>&1; echo ${marker} $?\n`);
        return;
      }
      this.close();
      clearTimeout(timer);
      reject(new CommandError('Aparelho desconectado do adb', null));
    });
  }

  close(): void {
    const child = this.child;
    const pending = this.pending;
    this.child = null;
    this.pending = null;
    this.buffer = '';
    pending?.reject(new CommandError('Sessão encerrada', null));
    if (child) {
      if (child.stdin.writable) child.stdin.end('exit\n');
      child.kill();
    }
  }
}

// ---------------------------------------------------------------------------
// Root

const rootCache = new Map<string, { rooted: boolean; at: number }>();

/** O aparelho tem `su` funcionando para o shell do adb? (cache de 1 min) */
export async function isRooted(serial: string): Promise<boolean> {
  const cached = rootCache.get(serial);
  if (cached && Date.now() - cached.at < 60_000) return cached.rooted;
  const out = await shell(serial, 'command -v su >/dev/null 2>&1 && su -c id 2>/dev/null', 6_000).catch(() => '');
  const rooted = /uid=0\b/.test(out);
  rootCache.set(serial, { rooted, at: Date.now() });
  return rooted;
}

export type Access = { via: 'shell' } | { via: 'root' } | { via: 'run-as'; pkg: string };

/** Embrulha um script para rodar como root, como um app debuggable ou como o shell. */
export function wrap(access: Access, script: string): string {
  if (access.via === 'root') return `su -c ${quote(script)}`;
  if (access.via === 'run-as') return `run-as ${access.pkg} sh -c ${quote(script)}`;
  return script;
}
