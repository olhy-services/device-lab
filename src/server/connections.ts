import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

import type { Socket } from '../shared/schema';
import { parseSections, sectionsCommand, shell } from './adb';
import { withTimeout } from './exec';
import { parseProcNet, parseUidPackages } from './parse';

/** UIDs fixos do Android (android.os.Process). */
const SYSTEM_UIDS: Record<number, string> = {
  0: 'root',
  1000: 'system',
  1001: 'radio (telefonia)',
  1002: 'bluetooth',
  1010: 'wifi',
  1013: 'media',
  1021: 'gps',
  1027: 'nfc',
  1051: 'dns (netd)',
  1073: 'network_stack',
  2000: 'shell (adb)',
};

const COMMAND = sectionsCommand({
  tcp: 'cat /proc/net/tcp',
  tcp6: 'cat /proc/net/tcp6',
  udp: 'cat /proc/net/udp',
  udp6: 'cat /proc/net/udp6',
});

const uidCache = new Map<string, { map: Map<number, string>; at: number }>();

async function uidMap(serial: string): Promise<Map<number, string>> {
  const cached = uidCache.get(serial);
  if (cached && Date.now() - cached.at < 60_000) return cached.map;
  const map = parseUidPackages(await shell(serial, 'pm list packages -U', 15_000));
  uidCache.set(serial, { map, at: Date.now() });
  return map;
}

function ownerOf(uid: number, packages: Map<number, string>): string {
  // Perfis de trabalho/outros usuários: UID = usuário * 100000 + appId.
  const appId = uid % 100_000;
  return packages.get(uid) ?? packages.get(appId) ?? SYSTEM_UIDS[appId] ?? `uid ${uid}`;
}

// --------------------------------------------------------------- DNS reverso
const names = new Map<string, string | null>();
const pending = new Set<string>();

function isPublic(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224);
  }
  return isIP(ip) === 6 && !/^(::|::1|fe80:|fc|fd|ff)/i.test(ip);
}

/** Nome do servidor (PTR) em segundo plano: a próxima leitura já vem com ele. */
function lookup(ip: string): string | null {
  if (!isPublic(ip)) return null;
  if (names.has(ip)) return names.get(ip) ?? null;
  if (!pending.has(ip) && pending.size < 32) {
    pending.add(ip);
    void withTimeout(dns.reverse(ip), 2_000, 'dns')
      .then((hosts) => names.set(ip, hosts[0] ?? null))
      .catch(() => names.set(ip, null))
      .finally(() => pending.delete(ip));
  }
  return null;
}

/**
 * Todas as conexões abertas no aparelho, de todos os apps, lidas do `/proc/net`.
 * Funciona com qualquer app, inclusive os que ignoram o proxy (WhatsApp, Flutter,
 * sockets próprios): mostra com quem o app fala, não o conteúdo.
 */
export async function listSockets(serial: string): Promise<Socket[]> {
  const [out, packages] = await Promise.all([shell(serial, COMMAND, 10_000).then(parseSections), uidMap(serial)]);
  const sockets: Socket[] = [];
  for (const proto of ['tcp', 'tcp6', 'udp', 'udp6'] as const) {
    for (const s of parseProcNet(out.get(proto) ?? '', proto.startsWith('udp'))) {
      sockets.push({ proto, ...s, owner: ownerOf(s.uid, packages), remoteHost: lookup(s.remoteIp) });
    }
  }
  // Conexões ativas primeiro, depois por app.
  const rank = (s: Socket) => (s.state === 'ESTABLISHED' ? 0 : s.state === 'LISTEN' || s.state === 'UNCONN' ? 2 : 1);
  return sockets.sort((a, b) => rank(a) - rank(b) || a.owner.localeCompare(b.owner) || a.remotePort - b.remotePort);
}
