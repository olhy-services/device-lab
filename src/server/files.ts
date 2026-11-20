import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { posix } from 'node:path';

import type { DirListing } from '../shared/schema';
import { ADB, type Access, adb, isRooted, PACKAGE_RE, quote, shell, wrap } from './adb';
import { parseListing } from './parse';

const MAX_ENTRIES = 3_000;
const PREVIEW_BYTES = 64 * 1024;
/** Pastas que apagar inteiras seria um desastre (ou quebraria o aparelho com root). */
const PROTECTED = new Set(['/', '/sdcard', '/storage', '/storage/emulated', '/storage/emulated/0', '/storage/self/primary', '/system', '/vendor', '/data', '/data/data', '/data/user', '/data/user/0', '/proc', '/sys', '/apex', '/product']);

export class FileAccessError extends Error {}

/** Como ler: app debuggable (run-as) quando pedido; senão root se houver; senão o shell do adb. */
export async function resolveAccess(serial: string, as: string | undefined): Promise<Access> {
  if (as) {
    if (!PACKAGE_RE.test(as)) throw new FileAccessError('Pacote inválido');
    return { via: 'run-as', pkg: as };
  }
  return (await isRooted(serial)) ? { via: 'root' } : { via: 'shell' };
}

function normalize(path: string): string {
  const out = posix.normalize(path);
  return out.length > 1 ? out.replace(/\/+$/, '') : out;
}

function explain(out: string, path: string, access: Access): never {
  if (/not debuggable/i.test(out)) {
    throw new FileAccessError('Esse app não é debuggable: só dá para abrir a pasta privada de builds de debug (ou com root).');
  }
  if (/denied|not permitted/i.test(out)) {
    throw new FileAccessError(
      access.via === 'shell'
        ? `Sem permissão para ${path}. Sem root, o shell do adb lê /sdcard, /system, /vendor e /proc; pastas privadas de apps só pelo "Ler como app" (apps debuggable).`
        : `Sem permissão para ${path}.`,
    );
  }
  throw new FileAccessError(out.trim().split('\n')[0] || `Não consegui abrir ${path}.`);
}

export async function listDir(serial: string, rawPath: string, as: string | undefined): Promise<DirListing> {
  const path = normalize(rawPath);
  const access = await resolveAccess(serial, as);
  // Uma linha por item: link<TAB>tamanho|mtime|modo|tipo<TAB>nome. Para em MAX_ENTRIES.
  const script =
    `cd ${quote(path)} || exit 3; ls -a . >/dev/null || exit 4; n=0; for f in .* *; do ` +
    `[ "$f" = . ] || [ "$f" = .. ] && continue; [ -e "$f" ] || [ -L "$f" ] || continue; ` +
    `n=$((n+1)); [ $n -gt ${MAX_ENTRIES} ] && { echo __TRUNCATED__; break; }; ` +
    `if [ -L "$f" ]; then l=1; else l=0; fi; ` +
    `s=$(stat -L -c '%s|%Y|%A|%F' -- "$f" 2>/dev/null || stat -c '%s|%Y|%A|%F' -- "$f" 2>/dev/null); ` +
    `printf '%s\\t%s\\t%s\\n' "$l" "$s" "$f"; done`;
  const out = await shell(serial, `( ${wrap(access, script)} ) 2>&1; echo "__EXIT__ $?"`, 30_000);
  const exit = /__EXIT__ (\d+)/.exec(out)?.[1];
  const body = out.replace(/__EXIT__ \d+\s*$/, '');
  if (exit !== '0' && !body.includes('\t')) explain(body, path, access);
  const entries = parseListing(body)
    .map((e) => ({ ...e, path: path === '/' ? `/${e.name}` : `${path}/${e.name}` }))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, 'pt-BR'));
  return { path, entries, truncated: body.includes('__TRUNCATED__'), via: access.via };
}

/** Começo do arquivo, para ver XML/JSON/logs sem baixar. */
export async function previewFile(serial: string, rawPath: string, as: string | undefined) {
  const path = normalize(rawPath);
  const access = await resolveAccess(serial, as);
  const buffer = (await adb(serial, ['exec-out', wrap(access, `head -c ${PREVIEW_BYTES + 1} -- ${quote(path)}`)], 20_000))
    .stdout;
  if (/^head: .*(denied|not permitted|No such)/i.test(buffer)) explain(buffer, path, access);
  const binary = buffer.includes('\u0000');
  return {
    text: binary ? '' : buffer.slice(0, PREVIEW_BYTES),
    truncated: buffer.length > PREVIEW_BYTES,
    binary,
  };
}

/** Lê o arquivo em fluxo direto do aparelho (sem carregar tudo na memória). */
export async function streamFile(
  serial: string,
  rawPath: string,
  as: string | undefined,
): Promise<{ child: ChildProcessWithoutNullStreams; name: string }> {
  const path = normalize(rawPath);
  const access = await resolveAccess(serial, as);
  const check = await shell(serial, wrap(access, `[ -f ${quote(path)} ] && [ -r ${quote(path)} ] && echo ok`), 10_000);
  if (!check.includes('ok')) throw new FileAccessError(`Não dá para ler ${path} (não existe, é pasta ou sem permissão).`);
  const child = spawn(ADB, ['-s', serial, 'exec-out', wrap(access, `cat -- ${quote(path)}`)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  return { child, name: posix.basename(path) };
}

export async function deletePath(serial: string, rawPath: string, as: string | undefined): Promise<string> {
  const path = normalize(rawPath);
  if (PROTECTED.has(path) || path.split('/').length < 3) {
    throw new FileAccessError(`Por segurança, ${path} não pode ser apagado daqui.`);
  }
  const access = await resolveAccess(serial, as);
  const out = await shell(serial, `${wrap(access, `rm -rf -- ${quote(path)}`)} 2>&1; echo "__EXIT__ $?"`, 60_000);
  if (!/__EXIT__ 0/.test(out)) explain(out.replace(/__EXIT__ \d+/, ''), path, access);
  return `${posix.basename(path)} apagado.`;
}

/** Envia um arquivo do computador para uma pasta do aparelho (shell ou root). */
export async function uploadFile(serial: string, localFile: string, dir: string, name: string): Promise<string> {
  if (!/^[^/\0\n\r]{1,255}$/.test(name) || name === '.' || name === '..') throw new FileAccessError('Nome de arquivo inválido');
  const target = `${normalize(dir)}/${name}`;
  const access = await resolveAccess(serial, undefined);
  if (access.via === 'root') {
    const staging = `/data/local/tmp/device-lab-upload-${Date.now()}`;
    await adb(serial, ['push', localFile, staging], 300_000);
    const out = await shell(serial, `su -c ${quote(`cp -- ${quote(staging)} ${quote(target)}`)} 2>&1; rm -f ${quote(staging)}`, 60_000);
    if (out.trim()) explain(out, target, access);
  } else {
    await adb(serial, ['push', localFile, target], 300_000).catch((error: unknown) => {
      explain(error instanceof Error ? error.message : String(error), target, access);
    });
  }
  return `${name} enviado para ${normalize(dir)}.`;
}

const debuggableCache = new Map<string, { list: string[]; at: number }>();

/** Apps instalados que aceitam `run-as` (builds de debug). Cache de 1 min. */
export async function debuggableApps(serial: string): Promise<string[]> {
  const cached = debuggableCache.get(serial);
  if (cached && Date.now() - cached.at < 60_000) return cached.list;
  const out = await shell(
    serial,
    'for p in $(pm list packages -3 | cut -d: -f2); do run-as "$p" true 2>/dev/null && echo "$p"; done; true',
    60_000,
  );
  const list = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => PACKAGE_RE.test(l))
    .sort();
  debuggableCache.set(serial, { list, at: Date.now() });
  return list;
}
