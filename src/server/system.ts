import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Process, ProcessList } from '../shared/schema';
import { adb, isRooted, PACKAGE_RE, parseSections, quote, sectionsCommand, shell } from './adb';
import { parseMeminfo, parseThermal, parseTop } from './parse';

const TOP_COMMAND = 'top -b -n 2 -d 1 -o PID,PPID,USER,%CPU,RES,S,NAME -s 4';
/** Processos de apps rodam com usuário `u0_a123` (ou `u10_a123` em outro perfil). */
const APP_USER = /^u\d+_a\d+$/;

function ownerPackage(user: string, name: string): string | null {
  const base = name.split(':')[0] ?? '';
  return APP_USER.test(user) && PACKAGE_RE.test(base) ? base : null;
}

export async function listProcesses(serial: string): Promise<ProcessList> {
  const [topOut, memOut, rooted] = await Promise.all([
    shell(serial, TOP_COMMAND, 10_000),
    shell(serial, "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo", 5_000),
    isRooted(serial),
  ]);
  const { cores, processes } = parseTop(topOut);
  const mem = parseMeminfo(memOut);
  const list: Process[] = processes
    // O próprio `top` usado para medir não interessa.
    .filter((p) => !(p.name === 'top' && p.user === 'shell'))
    .map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      user: p.user,
      cpuPct: p.cpu / cores,
      rssKb: p.rssKb,
      state: p.state,
      name: p.name,
      pkg: ownerPackage(p.user, p.name),
    }))
    .sort((a, b) => b.cpuPct - a.cpuPct || b.rssKb - a.rssKb);
  return {
    cores,
    memTotalKb: mem?.totalKb ?? 0,
    memAvailableKb: mem?.availableKb ?? 0,
    rooted,
    processes: list,
  };
}

/**
 * Apps: `am force-stop` (para o app inteiro, todos os processos dele).
 * Outros processos: `kill`, que sem root só funciona nos do próprio adb.
 */
export async function killProcess(serial: string, pid: number, name: string): Promise<string> {
  const user = (await shell(serial, `stat -c %U /proc/${pid}`, 5_000).catch(() => '')).trim();
  if (!user) return `O processo ${pid} já tinha terminado.`;
  const pkg = ownerPackage(user, name);
  if (pkg) {
    await shell(serial, `am force-stop ${pkg}`, 10_000);
    return `${pkg} encerrado (todos os processos do app).`;
  }
  const rooted = await isRooted(serial);
  const out = await shell(serial, rooted ? `su -c 'kill -9 ${pid}'` : `kill -9 ${pid}`, 5_000).catch(
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (/not permitted|denied/i.test(out)) {
    throw new Error(
      `Sem root, o Android não deixa encerrar ${name} (dono: ${user}). Só dá para encerrar apps e processos do próprio adb.`,
    );
  }
  return `Processo ${pid} (${name}) encerrado.`;
}

async function availableKb(serial: string): Promise<number> {
  return parseMeminfo(await shell(serial, 'cat /proc/meminfo', 5_000))?.availableKb ?? 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** "Limpar RAM": encerra os processos em cache/segundo plano que o Android considera seguros. */
export async function freeMemory(serial: string): Promise<{ message: string; freedKb: number }> {
  const before = await availableKb(serial);
  await shell(serial, 'am kill-all', 15_000);
  await sleep(1_500);
  const after = await availableKb(serial);
  const freedKb = Math.max(0, after - before);
  const freedMb = Math.round(freedKb / 1024);
  return {
    freedKb,
    message:
      freedMb > 0
        ? `Liberou ${freedMb} MB de RAM encerrando apps em segundo plano. O Android pode reabrir alguns serviços sozinho.`
        : 'Nada a liberar: o Android já tinha pouca coisa em segundo plano.',
  };
}

// ---------------------------------------------------------------------------
// Esfriar

/**
 * O estado de antes fica no próprio aparelho (`low|brilho|modo`), para o "desfazer"
 * funcionar mesmo depois de reiniciar o device-lab ou trocar de computador.
 */
const COOL_STATE = '/data/local/tmp/device-lab-cool-state';

function hottest(text: string): string {
  const temps = parseThermal(text);
  const top = temps.sort((a, b) => b.c - a.c)[0];
  return top ? `${top.name} ${top.c.toFixed(1).replace('.', ',')} °C` : 'sem sensor';
}

/**
 * Reduz o que gera calor: apps em segundo plano, brilho e desempenho (economia de
 * bateria). O aparelho esfria nos minutos seguintes; nada aqui resfria na hora.
 */
export async function coolDown(serial: string): Promise<string> {
  const out = parseSections(
    await shell(
      serial,
      sectionsCommand({
        saved: `cat ${COOL_STATE} 2>/dev/null; true`,
        low: 'settings get global low_power',
        bright: 'settings get system screen_brightness',
        mode: 'settings get system screen_brightness_mode',
        thermal: 'dumpsys thermalservice',
      }),
      8_000,
    ),
  );
  // Esfriar de novo não sobrescreve o estado original.
  const alreadySaved = (out.get('saved') ?? '').includes('|');
  const state = [out.get('low') ?? '0', out.get('bright') ?? '', out.get('mode') ?? '1'].map((v) => v.replace(/\D/g, '')).join('|');
  await shell(
    serial,
    [
      ...(alreadySaved ? [] : [`echo ${quote(state)} > ${COOL_STATE}`]),
      'am kill-all',
      'settings put global low_power 1',
      'settings put system screen_brightness_mode 0',
      'settings put system screen_brightness 25',
    ].join('; '),
    15_000,
  );
  const top = await listProcesses(serial).catch(() => null);
  const hogs = (top?.processes ?? [])
    .filter((p) => p.pkg && p.cpuPct >= 5)
    .slice(0, 3)
    .map((p) => `${p.pkg} (${Math.round(p.cpuPct)}%)`);
  return (
    `Modo resfriar ligado: apps em segundo plano encerrados, economia de bateria ligada e brilho no mínimo. ` +
    `Mais quente agora: ${hottest(out.get('thermal') ?? '')}.` +
    (hogs.length > 0 ? ` Ainda gastando CPU: ${hogs.join(', ')}; encerre em Processos se não precisar.` : '') +
    ' Tirar do carregador e da capinha ajuda.'
  );
}

export async function undoCoolDown(serial: string): Promise<string> {
  const raw = (await shell(serial, `cat ${COOL_STATE} 2>/dev/null; true`)).trim();
  const [lowPower, brightness, brightnessMode] = raw.split('|');
  const known = raw.includes('|');
  const commands = [`settings put global low_power ${lowPower === '1' ? 1 : 0}`];
  if (brightness && /^\d+$/.test(brightness)) commands.push(`settings put system screen_brightness ${brightness}`);
  commands.push(`settings put system screen_brightness_mode ${brightnessMode === '0' ? 0 : 1}`);
  commands.push(`rm -f ${COOL_STATE}`);
  await shell(serial, commands.join('; '), 10_000);
  return known
    ? 'Brilho e economia de bateria voltaram ao que eram antes.'
    : 'Não havia registro de antes; economia de bateria desligada e brilho automático.';
}

// ---------------------------------------------------------------------------
// Ejetar água do alto-falante

const EJECT_HZ = 165;
const EJECT_SECONDS = 30;
const SAMPLE_RATE = 44_100;
const DEVICE_WAV = '/sdcard/Download/device-lab-ejetar-agua.wav';

/** Tom senoidal grave em WAV PCM 16 bits mono, com rampa de entrada/saída para não estalar. */
function toneWav(): Buffer {
  const samples = SAMPLE_RATE * EJECT_SECONDS;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  const ramp = SAMPLE_RATE / 2;
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / ramp, (samples - i) / ramp);
    const value = Math.sin((2 * Math.PI * EJECT_HZ * i) / SAMPLE_RATE) * envelope * 0.95;
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + i * 2);
  }
  return buffer;
}

export async function ejectWater(serial: string): Promise<string> {
  const file = join(tmpdir(), `device-lab-eject-${process.pid}.wav`);
  await writeFile(file, toneWav());
  try {
    await adb(serial, ['push', file, DEVICE_WAV], 30_000);
  } finally {
    await rm(file, { force: true });
  }
  // Volume de mídia no máximo (a faixa varia por aparelho: lê o teto antes).
  const range = await shell(serial, 'cmd media_session volume --stream 3 --get', 8_000).catch(() => '');
  const max = /\[\d+\.\.(\d+)\]/.exec(range)?.[1] ?? '15';
  await shell(serial, `cmd media_session volume --stream 3 --set ${Number(max)}`, 8_000).catch(() => '');
  const out = await shell(
    serial,
    `am start -a android.intent.action.VIEW -d ${quote(`file://${DEVICE_WAV}`)} -t audio/wav`,
    10_000,
  );
  if (/Error|unable to resolve/i.test(out)) {
    throw new Error(`Nenhum player abriu o som. O arquivo está em ${DEVICE_WAV}: abra no aparelho e toque no volume máximo.`);
  }
  return (
    `Tocando ${EJECT_HZ} Hz por ${EJECT_SECONDS} s no volume máximo. Deixe o alto-falante virado para baixo. ` +
    'Isso só expulsa gotas da grade do alto-falante; se molhou por dentro, desligue o aparelho e deixe secar.'
  );
}
