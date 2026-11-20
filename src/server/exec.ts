import { execFile } from 'node:child_process';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: string | number | null,
    /** O processo foi morto por estourar o tempo limite. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

function toError(error: Error & { code?: string | number | null; killed?: boolean }, output: string, timeoutMs: number) {
  if (error.killed) return new CommandError(`Sem resposta em ${Math.round(timeoutMs / 1000)} s`, null, true);
  const detail = (output || error.message).trim().split('\n').slice(0, 3).join(' ');
  return new CommandError(detail, error.code ?? null);
}

/**
 * Executa um binário sem shell (argumentos nunca são interpretados pelo host).
 * Sempre com tempo limite: um aparelho que sumiu da rede não pode travar nada.
 */
export function run(file: string, args: readonly string[], timeoutMs = 10_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(toError(error, stderr || stdout, timeoutMs));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/** Igual a `run`, mas devolve a saída binária (ex.: PNG do `screencap`). */
export function runBuffer(file: string, args: readonly string[], timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          reject(toError(error, stderr.toString('utf8'), timeoutMs));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export function isMissingBinary(error: unknown): boolean {
  return error instanceof CommandError && error.code === 'ENOENT';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejeita se a promessa não terminar a tempo (para APIs que não aceitam timeout). */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandError(message, null, true)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
