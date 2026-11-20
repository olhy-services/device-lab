import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { listDevices } from './adb';
import { DeviceRegistry } from './device';
import { errorMessage } from './exec';
import { createAppServer } from './http';
import { clearDeviceProxy } from './proxy';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const HELP = `device-lab — espelha e controla um Android pelo navegador, com DevTools

Uso:
  device-lab [serve]             Abre a interface (http://127.0.0.1:4700)
      --port <n>                 Porta (padrão 4700)
      --no-open                  Não abrir o navegador
  device-lab devices             Lista aparelhos e se estão prontos
  device-lab reset <serial>      Tira o proxy do aparelho (se o device-lab caiu capturando)

Variáveis: DEVICE_LAB_ADB (caminho do adb), DEVICE_LAB_HOME (onde fica a CA, padrão ~/.device-lab)`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    // `pnpm dev -- --flag` repassa um "--" solto; sem isso ele encerraria as opções.
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      dev: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command = 'serve', ...rest] = positionals;
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'serve':
      return serve({
        port: z.coerce.number().int().min(1).max(65_535).parse(values.port ?? '4700'),
        dev: values.dev ?? false,
        open: !(values['no-open'] ?? false),
      });
    case 'devices': {
      const { adb, devices } = await listDevices();
      if (!adb) console.log('adb não encontrado (instale o Android SDK platform-tools ou defina DEVICE_LAB_ADB).');
      if (devices.length === 0) console.log('Nenhum aparelho conectado.');
      for (const d of devices) {
        console.log(`${d.unavailableReason ? '✗' : '✓'} ${d.serial.padEnd(24)} ${d.model}${d.unavailableReason ? ` — ${d.unavailableReason}` : ''}`);
      }
      return;
    }
    case 'reset': {
      const serial = rest[0];
      if (!serial) throw new Error('Informe o aparelho: device-lab reset <serial> (veja "device-lab devices")');
      await clearDeviceProxy(serial, null);
      console.log(`Proxy removido de ${serial}.`);
      return;
    }
    default:
      throw new Error(`Comando desconhecido "${command}".\n\n${HELP}`);
  }
}

async function serve(options: { port: number; dev: boolean; open: boolean }): Promise<void> {
  // Só o computador local: o espelho controla o aparelho e o proxy vê o tráfego dele.
  const host = '127.0.0.1';
  const devices = new DeviceRegistry();

  let devMiddleware: Parameters<typeof createAppServer>[0]['devMiddleware'];
  let closeVite: (() => Promise<void>) | undefined;
  if (options.dev) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: join(PROJECT_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { port: options.port + 1 } },
      appType: 'spa',
    });
    devMiddleware = (req, res, next) => vite.middlewares(req, res, next);
    closeVite = () => vite.close();
  }

  const { server, mirrors } = createAppServer({ host, devices, staticDir: join(PROJECT_ROOT, 'dist', 'web'), devMiddleware });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => resolveListen());
  });

  const url = `http://${host}:${options.port}`;
  console.log(`device-lab rodando em ${url}`);
  if (options.open) openBrowser(url);

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nEncerrando: tirando o proxy dos aparelhos e fechando o espelhamento…');
    void Promise.all([devices.disposeAll(), ...[...mirrors.values()].map((m) => m.stop())])
      .then(() => closeVite?.())
      .finally(() => {
        server.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    // Sem navegador disponível: a URL já foi impressa.
  }
}

main().catch((error: unknown) => {
  console.error(`device-lab: ${errorMessage(error)}`);
  process.exit(1);
});
