import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type CompletedRequest, type CompletedResponse, generateCACertificate, getLocal, type Mockttp } from 'mockttp';

import type { HttpExchange, ProxyStatus, TlsFailure } from '../shared/schema';
import { adb, shell } from './adb';
import { errorMessage } from './exec';

export const PROXY_PORTS = { startPort: 8800, endPort: 8899 } as const;
const MAX_EXCHANGES = 1_000;
const MAX_BODY_CHARS = 256 * 1024;
const DEVICE_CA_PATH = '/sdcard/Download/device-lab-ca.crt';
const TEXT_MIME = /json|text\/|xml|javascript|x-www-form-urlencoded|graphql|html/i;

export const DATA_DIR = process.env.DEVICE_LAB_HOME ?? join(homedir(), '.device-lab');
const CA_KEY = join(DATA_DIR, 'ca.key');
const CA_CERT = join(DATA_DIR, 'ca.pem');

/** CA local, gerada uma vez por computador (instalar uma vez no aparelho basta). */
async function ensureCa(): Promise<void> {
  try {
    await readFile(CA_CERT);
    await readFile(CA_KEY);
    return;
  } catch {
    // Ainda não existe: gera abaixo.
  }
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const { key, cert } = await generateCACertificate({
    subject: { commonName: 'device-lab (somente desenvolvimento)', organizationName: 'device-lab' },
  });
  await writeFile(CA_KEY, key, { mode: 0o600 });
  await chmod(CA_KEY, 0o600);
  await writeFile(CA_CERT, cert);
}

function flatHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | null {
  const value = headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** Corpo legível (texto) até um limite. Binário fica de fora, só com o tamanho. */
async function readBody(
  body: CompletedRequest['body'],
  mime: string | null,
): Promise<{ text: string | null; truncated: boolean; bytes: number }> {
  const bytes = body.buffer.length;
  if (bytes === 0) return { text: null, truncated: false, bytes };
  if (!mime || !TEXT_MIME.test(mime)) return { text: null, truncated: true, bytes };
  const text = (await body.getText().catch(() => undefined)) ?? null;
  if (text === null) return { text: null, truncated: true, bytes };
  if (text.length > MAX_BODY_CHARS) return { text: text.slice(0, MAX_BODY_CHARS), truncated: true, bytes };
  return { text, truncated: false, bytes };
}

export interface ProxyEvents {
  exchange(exchange: HttpExchange): void;
  tlsFailure(failure: TlsFailure): void;
  status(status: ProxyStatus): void;
}

/**
 * Proxy de interceptação (mockttp) para UM aparelho. O aparelho alcança o
 * proxy pelo `adb reverse` (127.0.0.1 do celular → 127.0.0.1 deste computador);
 * o proxy só escuta em 127.0.0.1 (patch em patches/mockttp*.patch).
 */
export class DeviceProxy {
  private server: Mockttp | null = null;
  private port: number | null = null;
  private caOnDevice: string | null = null;
  private readonly exchanges = new Map<string, HttpExchange>();

  constructor(
    private readonly serial: string,
    private readonly events: ProxyEvents,
  ) {}

  status(): ProxyStatus {
    return { capturing: this.server !== null, port: this.port, caPath: CA_CERT, caOnDevice: this.caOnDevice };
  }

  list(): HttpExchange[] {
    return [...this.exchanges.values()];
  }

  clear(): void {
    this.exchanges.clear();
  }

  async start(): Promise<ProxyStatus> {
    if (this.server) return this.status();
    await ensureCa();
    const server = getLocal({ https: { keyPath: CA_KEY, certPath: CA_CERT }, cors: false });
    await server.forAnyRequest().thenPassThrough();
    await server.on('request', (req) => this.onRequest(req));
    await server.on('response', (res) => void this.onResponse(res));
    await server.on('abort', (req) => {
      this.update(req.id, { error: req.error?.message ?? 'Conexão interrompida', durationMs: this.elapsed(req.id) });
    });
    await server.on('tls-client-error', (failure) => {
      this.events.tlsFailure({
        host: failure.tlsMetadata.sniHostname ?? failure.destination?.hostname ?? 'desconhecido',
        at: Date.now(),
        reason: failure.failureCause,
      });
    });
    await server.start(PROXY_PORTS);
    const port = server.port;

    try {
      await adb(this.serial, ['reverse', `tcp:${port}`, `tcp:${port}`], 8_000);
      await shell(this.serial, `settings put global http_proxy 127.0.0.1:${port}`, 8_000);
    } catch (error) {
      await server.stop().catch(() => undefined);
      await clearDeviceProxy(this.serial, port);
      throw new Error(`Não consegui ligar o proxy no aparelho: ${errorMessage(error)}`, { cause: error });
    }
    this.server = server;
    this.port = port;

    // Deixa o certificado à mão no aparelho, para instalar pelas Configurações.
    this.caOnDevice = await adb(this.serial, ['push', CA_CERT, DEVICE_CA_PATH], 15_000)
      .then(() => DEVICE_CA_PATH)
      .catch(() => null);

    const status = this.status();
    this.events.status(status);
    return status;
  }

  async stop(): Promise<ProxyStatus> {
    const server = this.server;
    const port = this.port;
    this.server = null;
    this.port = null;
    // Primeiro devolve a internet ao aparelho; o proxy pode cair depois.
    await clearDeviceProxy(this.serial, port);
    await server?.stop().catch(() => undefined);
    const status = this.status();
    this.events.status(status);
    return status;
  }

  private elapsed(id: string): number | null {
    const exchange = this.exchanges.get(id);
    return exchange ? Date.now() - exchange.startedAt : null;
  }

  private onRequest(req: CompletedRequest): void {
    const mime = headerValue(req.headers, 'content-type');
    const exchange: HttpExchange = {
      id: req.id,
      method: req.method,
      url: req.url,
      host: req.destination.hostname,
      path: req.path,
      startedAt: req.timingEvents.startTime,
      status: null,
      durationMs: null,
      requestHeaders: flatHeaders(req.headers),
      responseHeaders: null,
      requestBody: null,
      responseBody: null,
      bodyTruncated: false,
      mime: null,
      responseBytes: null,
      error: null,
    };
    this.store(exchange);
    void readBody(req.body, mime).then(({ text, truncated }) => {
      const current = this.exchanges.get(req.id);
      this.update(req.id, { requestBody: text, bodyTruncated: (current?.bodyTruncated ?? false) || truncated });
    });
  }

  private async onResponse(res: CompletedResponse): Promise<void> {
    const mime = headerValue(res.headers, 'content-type');
    const body = await readBody(res.body, mime);
    const current = this.exchanges.get(res.id);
    this.update(res.id, {
      status: res.statusCode,
      durationMs: this.elapsed(res.id),
      responseHeaders: flatHeaders(res.headers),
      responseBody: body.text,
      bodyTruncated: (current?.bodyTruncated ?? false) || body.truncated,
      mime,
      responseBytes: body.bytes,
    });
  }

  private store(exchange: HttpExchange): void {
    this.exchanges.set(exchange.id, exchange);
    if (this.exchanges.size > MAX_EXCHANGES) {
      const oldest = this.exchanges.keys().next().value;
      if (oldest !== undefined) this.exchanges.delete(oldest);
    }
    this.events.exchange(exchange);
  }

  private update(id: string, patch: Partial<HttpExchange>): void {
    const current = this.exchanges.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.exchanges.set(id, next);
    this.events.exchange(next);
  }
}

/**
 * Tira o proxy do aparelho. Também usado para limpar um proxy que ficou
 * configurado quando o device-lab caiu (sem isso o celular fica sem internet).
 */
export async function clearDeviceProxy(serial: string, port: number | null): Promise<void> {
  await shell(serial, 'settings put global http_proxy :0', 8_000).catch(() => undefined);
  if (port !== null) await adb(serial, ['reverse', '--remove', `tcp:${port}`], 5_000).catch(() => undefined);
}

/** Proxy apontando para uma porta nossa sem captura ativa = sobra de uma sessão que caiu. */
export async function clearStaleProxy(serial: string): Promise<boolean> {
  const current = (await shell(serial, 'settings get global http_proxy', 5_000).catch(() => '')).trim();
  const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(current)?.[1]);
  if (!Number.isInteger(port) || port < PROXY_PORTS.startPort || port > PROXY_PORTS.endPort) return false;
  await clearDeviceProxy(serial, port);
  return true;
}
