import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { type WebSocket, WebSocketServer } from 'ws';
import { type ZodType, z } from 'zod';

import {
  AppActionSchema,
  ControlMessageSchema,
  DeletePathSchema,
  DevicePathSchema,
  FileAccessSchema,
  KillRequestSchema,
  OpenUrlSchema,
  SerialSchema,
  SettingsPatchSchema,
  WifiConnectRequestSchema,
  WifiPairRequestSchema,
} from '../shared/schema';
import { adbConnect, adbDisconnect, adbPair, discoverWifi, isRooted, listDevices, PACKAGE_RE, switchToWifi } from './adb';
import { listSockets } from './connections';
import type { DeviceRegistry } from './device';
import { errorMessage } from './exec';
import { MirrorSession } from './mirror';
import {
  appAction,
  deviceInfo,
  installApk,
  listApps,
  openUrl,
  patchSettings,
  readSettings,
  screenshot,
  storage,
} from './ops';
import { debuggableApps, deletePath, listDir, previewFile, streamFile, uploadFile } from './files';
import { DATA_DIR } from './proxy';
import { coolDown, ejectWater, freeMemory, killProcess, listProcesses, undoCoolDown } from './system';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;
const MAX_CONTROL_BYTES = 128 * 1024;
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Resposta que não é JSON (imagem, certificado). */
class RawBody {
  constructor(
    readonly contentType: string,
    readonly body: Buffer,
    readonly filename: string,
  ) {}
}

/** Resposta em fluxo direto de um processo (download de arquivo do aparelho). */
class StreamBody {
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly filename: string,
  ) {}
}

interface Context {
  req: IncomingMessage;
  params: string[];
  url: URL;
}

type Handler = (ctx: Context) => Promise<unknown>;

export interface ServerOptions {
  host: string;
  devices: DeviceRegistry;
  staticDir: string;
  devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
}

export function createAppServer(options: ServerOptions): { server: Server; mirrors: Map<string, MirrorSession> } {
  const { devices } = options;
  const mirrors = new Map<string, MirrorSession>();
  /** `raw`: tipo de corpo binário aceito pela rota (em vez de JSON). */
  const routes: { method: string; pattern: RegExp; handler: Handler; raw?: string | undefined }[] = [];
  const on = (method: string, path: string, handler: Handler, raw?: string) => {
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), handler, raw });
  };
  const serialParam = (ctx: Context) => parse(SerialSchema, decodeURIComponent(ctx.params[0] ?? ''));
  const ok = (message?: string) => ({ ok: true as const, ...(message && { message }) });

  on('GET', '/api/devices', () => listDevices());

  on('GET', '/api/wifi/discover', async () => ({ services: await discoverWifi() }));
  on('POST', '/api/wifi/pair', async (ctx) => {
    const body = parse(WifiPairRequestSchema, await readJson(ctx.req));
    return { message: await adbPair(body.host, body.port, body.code) };
  });
  on('POST', '/api/wifi/connect', async (ctx) => {
    const body = parse(WifiConnectRequestSchema, await readJson(ctx.req));
    return { message: await adbConnect(body.host, body.port) };
  });
  on('POST', '/api/devices/:serial/wifi', async (ctx) => ({ message: await switchToWifi(serialParam(ctx)) }));
  on('POST', '/api/devices/:serial/disconnect', async (ctx) => {
    await adbDisconnect(serialParam(ctx));
    return ok();
  });

  on('GET', '/api/devices/:serial/info', (ctx) => deviceInfo(serialParam(ctx)));
  on('GET', '/api/devices/:serial/storage', (ctx) => storage(serialParam(ctx)));
  on('GET', '/api/devices/:serial/apps', async (ctx) => ({ apps: await listApps(serialParam(ctx)) }));
  on('POST', '/api/devices/:serial/apps/:pkg/:action', async (ctx) => {
    const pkg = parse(z.string().regex(PACKAGE_RE), decodeURIComponent(ctx.params[1] ?? ''));
    const action = parse(AppActionSchema, ctx.params[2]);
    return ok(await appAction(serialParam(ctx), pkg, action));
  });
  on(
    'POST',
    '/api/devices/:serial/install',
    async (ctx) => ok(await installApk(serialParam(ctx), await receiveUpload(ctx.req, '.apk'))),
    'application/vnd.android.package-archive',
  );

  // Processos, memória e cuidados com o aparelho
  on('GET', '/api/devices/:serial/processes', (ctx) => listProcesses(serialParam(ctx)));
  on('POST', '/api/devices/:serial/processes/kill', async (ctx) => {
    const body = parse(KillRequestSchema, await readJson(ctx.req));
    return ok(await killProcess(serialParam(ctx), body.pid, body.name));
  });
  on('POST', '/api/devices/:serial/memory/free', async (ctx) => ok((await freeMemory(serialParam(ctx))).message));
  on('POST', '/api/devices/:serial/care/cool', async (ctx) => ok(await coolDown(serialParam(ctx))));
  on('POST', '/api/devices/:serial/care/cool/undo', async (ctx) => ok(await undoCoolDown(serialParam(ctx))));
  on('POST', '/api/devices/:serial/care/eject-water', async (ctx) => ok(await ejectWater(serialParam(ctx))));

  // Conexões de todos os apps
  on('GET', '/api/devices/:serial/sockets', async (ctx) => ({ sockets: await listSockets(serialParam(ctx)), at: Date.now() }));

  // Arquivos
  const fileQuery = (ctx: Context) => ({
    path: parse(DevicePathSchema, ctx.url.searchParams.get('path') ?? ''),
    as: parse(FileAccessSchema, { as: ctx.url.searchParams.get('as') ?? undefined }).as || undefined,
  });
  on('GET', '/api/devices/:serial/files/access', async (ctx) => {
    const serial = serialParam(ctx);
    const [rooted, debuggable] = await Promise.all([isRooted(serial), debuggableApps(serial)]);
    return { rooted, debuggable };
  });
  on('GET', '/api/devices/:serial/files', (ctx) => {
    const q = fileQuery(ctx);
    return listDir(serialParam(ctx), q.path, q.as);
  });
  on('GET', '/api/devices/:serial/files/preview', (ctx) => {
    const q = fileQuery(ctx);
    return previewFile(serialParam(ctx), q.path, q.as);
  });
  on('GET', '/api/devices/:serial/files/download', async (ctx) => {
    const q = fileQuery(ctx);
    const { child, name } = await streamFile(serialParam(ctx), q.path, q.as);
    return new StreamBody(child, name);
  });
  on('POST', '/api/devices/:serial/files/delete', async (ctx) => {
    const body = parse(DeletePathSchema, await readJson(ctx.req));
    return ok(await deletePath(serialParam(ctx), body.path, body.as || undefined));
  });
  on(
    'POST',
    '/api/devices/:serial/files/upload',
    async (ctx) => {
      const dir = parse(DevicePathSchema, ctx.url.searchParams.get('dir') ?? '');
      const name = parse(z.string().min(1).max(255), decodeURIComponent(String(ctx.req.headers['x-file-name'] ?? '')));
      const file = await receiveUpload(ctx.req, '.bin');
      try {
        return ok(await uploadFile(serialParam(ctx), file, dir, name));
      } finally {
        await rm(file, { force: true });
      }
    },
    'application/octet-stream',
  );

  on('GET', '/api/devices/:serial/settings', (ctx) => readSettings(serialParam(ctx)));
  on('POST', '/api/devices/:serial/settings', async (ctx) =>
    patchSettings(serialParam(ctx), parse(SettingsPatchSchema, await readJson(ctx.req))),
  );
  on('GET', '/api/devices/:serial/screenshot', async (ctx) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return new RawBody('image/png', await screenshot(serialParam(ctx)), `tela-${stamp}.png`);
  });
  on('POST', '/api/devices/:serial/open-url', async (ctx) =>
    ok(await openUrl(serialParam(ctx), parse(OpenUrlSchema, await readJson(ctx.req)).url)),
  );

  on('POST', '/api/devices/:serial/proxy/start', (ctx) => devices.get(serialParam(ctx)).proxy.start());
  on('POST', '/api/devices/:serial/proxy/stop', (ctx) => devices.get(serialParam(ctx)).proxy.stop());
  on('POST', '/api/devices/:serial/http/clear', async (ctx) => {
    devices.get(serialParam(ctx)).clearHttp();
    return ok();
  });
  on('POST', '/api/devices/:serial/logs/clear', async (ctx) => {
    await devices.get(serialParam(ctx)).clearLogs();
    return ok();
  });
  on('GET', '/api/ca.pem', async () => {
    const cert = await readFile(join(DATA_DIR, 'ca.pem')).catch(() => {
      throw new HttpError(404, 'O certificado é criado ao ligar a captura de requisições pela primeira vez.');
    });
    return new RawBody('application/x-pem-file', cert, 'device-lab-ca.crt');
  });

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
      else res.end();
    });
  });

  // ---------------------------------------------------------------- WebSocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host ?? '';
    const path = new URL(req.url ?? '/', 'http://local').pathname;
    const match = /^\/ws\/(screen|events)\/([^/]+)$/.exec(path);
    // WebSocket não tem CORS: a origem precisa ser esta página, sempre.
    if (!isLocalHost(host, options.host) || req.headers.origin !== `http://${host}` || !match?.[1] || !match[2]) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const serial = SerialSchema.safeParse(decodeURIComponent(match[2]));
    if (!serial.success) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const channel = match[1];
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (channel === 'screen') attachScreen(ws, serial.data);
      else attachEvents(ws, serial.data);
    });
  });

  function attachScreen(ws: WebSocket, serial: string): void {
    let mirror = mirrors.get(serial);
    if (!mirror) {
      const created = new MirrorSession(serial, () => {
        if (mirrors.get(serial) === created) mirrors.delete(serial);
      });
      mirrors.set(serial, created);
      mirror = created;
    }
    const session = mirror;
    session.attach(ws);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        return;
      }
      const message = ControlMessageSchema.safeParse(value);
      if (message.success) void session.control(message.data).catch(() => undefined);
    });
  }

  function attachEvents(ws: WebSocket, serial: string): void {
    const unsubscribe = devices.get(serial).subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on('close', unsubscribe);
  }

  // --------------------------------------------------------------------- HTTP
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    // Proteção contra DNS rebinding: só aceita Host local.
    if (!isLocalHost(host, options.host)) {
      sendJson(res, 403, { error: 'Host não permitido' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host}`);

    if (!url.pathname.startsWith('/api/')) {
      if (options.devMiddleware) {
        options.devMiddleware(req, res, () => sendJson(res, 404, { error: 'Não encontrado' }));
        return;
      }
      serveStatic(options.staticDir, url.pathname, res);
      return;
    }

    const method = req.method ?? 'GET';
    const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
    if (method !== 'GET') {
      // Um site qualquer aberto no navegador não pode mandar comandos para cá:
      // a origem tem que ser esta, e corpo JSON/binário força preflight de CORS (que não respondemos).
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) {
        sendJson(res, 403, { error: 'Origem não permitida' });
        return;
      }
      const type = req.headers['content-type'] ?? '';
      const expected = route?.raw ?? 'application/json';
      if (!type.startsWith(expected)) {
        sendJson(res, 415, { error: `Envie Content-Type: ${expected}` });
        return;
      }
    }
    if (!route) {
      sendJson(res, 404, { error: 'Rota não encontrada' });
      return;
    }
    const match = route.pattern.exec(url.pathname);
    try {
      const result = await route.handler({ req, url, params: match ? match.slice(1) : [] });
      if (result instanceof StreamBody) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.on('close', () => result.child.kill());
        result.child.stdout.pipe(res);
        return;
      }
      if (result instanceof RawBody) {
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(result.body);
        return;
      }
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, error instanceof HttpError ? error.status : 422, { error: errorMessage(error) });
    }
  }

  return { server, mirrors };
}

function isLocalHost(host: string, configured: string): boolean {
  const hostname = host.replace(/:\d+$/, '');
  return LOCAL_HOSTNAMES.has(hostname) || hostname === configured;
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw new HttpError(400, `Dados inválidos — ${where}${issue?.message ?? 'formato inesperado'}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo da requisição grande demais');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

/** Grava o corpo enviado num arquivo temporário (o adb lê do disco). */
async function receiveUpload(req: IncomingMessage, extension: string): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Arquivo grande demais (máximo 1 GB)');
  const file = join(tmpdir(), `device-lab-${randomUUID()}${extension}`);
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) req.destroy(new HttpError(413, 'Arquivo grande demais (máximo 1 GB)'));
  });
  await pipeline(req, createWriteStream(file, { mode: 0o600 }));
  if (size === 0) throw new HttpError(400, 'Arquivo vazio');
  return file;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const index = join(root, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Interface não compilada. Rode "pnpm build" ou use "pnpm dev".');
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(root, safe);
  if (!file.startsWith(root + sep) || !existsSync(file) || statSync(file).isDirectory()) file = index;
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file === index ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(res);
}
