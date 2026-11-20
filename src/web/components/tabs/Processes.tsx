import { Pause, Play, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Process, ProcessList } from '../../../shared/schema';
import { api } from '../../api';
import { formatKb, formatNumber } from '../../format';
import { ConfirmDialog, type ConfirmRequest } from '../ConfirmDialog';

const REFRESH_MS = 3_000;
const MAX_ROWS = 400;

interface ProcessesProps {
  serial: string;
  onError(message: string): void;
  onInfo(message: string): void;
}

export function Processes({ serial, onError, onInfo }: ProcessesProps) {
  const [data, setData] = useState<ProcessList | null>(null);
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [onlyApps, setOnlyApps] = useState(false);
  const [sort, setSort] = useState<'cpu' | 'mem'>('cpu');
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [freeing, setFreeing] = useState(false);
  const [tick, setTick] = useState(0);

  // Atualiza sozinho; o `top` leva ~1 s para medir, então a próxima leitura só sai depois da anterior.
  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api
        .processes(serial)
        .then((r) => alive && setData(r))
        .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (alive) timer = setTimeout(load, REFRESH_MS);
        });
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [serial, paused, onError, tick]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (data?.processes ?? []).filter(
      (p) =>
        (!onlyApps || p.pkg !== null) &&
        (!q || p.name.toLowerCase().includes(q) || String(p.pid) === q || p.user.toLowerCase().includes(q)),
    );
    return sort === 'mem' ? list.slice().sort((a, b) => b.rssKb - a.rssKb) : list;
  }, [data, query, onlyApps, sort]);

  async function kill(p: Process) {
    try {
      onInfo((await api.kill(serial, p.pid, p.name)).message ?? 'Encerrado.');
      setTick((n) => n + 1);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function freeRam() {
    setFreeing(true);
    try {
      onInfo((await api.freeMemory(serial)).message ?? 'Feito.');
      setTick((n) => n + 1);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setFreeing(false);
    }
  }

  function ask(p: Process) {
    setConfirm({
      title: p.pkg ? `Encerrar ${p.pkg}?` : `Encerrar o processo ${p.pid}?`,
      body: p.pkg ? (
        <p>
          Para o app inteiro (<span className="mono">am force-stop</span>), com todos os processos dele. O que não foi
          salvo no app se perde.
        </p>
      ) : (
        <p>
          Envia <span className="mono">kill -9</span> para <span className="mono">{p.name}</span> (dono {p.user}).
          {data?.rooted
            ? ' Com root, encerrar processos do sistema pode reiniciar a interface ou o aparelho.'
            : ' Sem root, o Android só deixa encerrar processos do próprio adb.'}
        </p>
      ),
      confirmLabel: 'Encerrar',
      tone: 'danger',
      onConfirm: () => void kill(p),
    });
  }

  const usedPct = data && data.memTotalKb > 0 ? 100 - (100 * data.memAvailableKb) / data.memTotalKb : null;

  return (
    <div className="tab-body">
      <div className="section-head">
        <p className="hint num">
          {data
            ? `${data.processes.length} processos · RAM ${formatNumber(usedPct)}% em uso (${formatKb(data.memAvailableKb)} livre de ${formatKb(data.memTotalKb)})${data.rooted ? ' · root' : ''}`
            : 'Lendo processos…'}
        </p>
        <button type="button" className="btn sm" disabled={freeing} onClick={() => void freeRam()}>
          <Trash2 size={14} aria-hidden="true" /> {freeing ? 'Liberando…' : 'Liberar RAM'}
        </button>
      </div>
      <div className="toolbar">
        <input
          className="input grow"
          type="search"
          placeholder="Buscar por nome, PID ou usuário"
          aria-label="Buscar processo"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={onlyApps} onChange={(e) => setOnlyApps(e.target.checked)} />
          <span>Só apps</span>
        </label>
        <div className="segmented" role="group" aria-label="Ordenar por">
          <button type="button" aria-pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>
            CPU
          </button>
          <button type="button" aria-pressed={sort === 'mem'} onClick={() => setSort('mem')}>
            Memória
          </button>
        </div>
        <button type="button" className="btn sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {paused ? 'Continuar' : 'Pausar'}
        </button>
      </div>

      <div className="table-wrap tall" role="region" aria-label="Processos" tabIndex={0}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Processo</th>
              <th scope="col" className="r">
                PID
              </th>
              <th scope="col">Usuário</th>
              <th scope="col" className="r">
                CPU
              </th>
              <th scope="col" className="r">
                Memória
              </th>
              <th scope="col">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map((p) => (
              <tr key={p.pid}>
                <td className="mono proc-name" title={p.name}>
                  {p.name}
                </td>
                <td className="r num mono">{p.pid}</td>
                <td className="mono muted">{p.user}</td>
                <td className="r num">{formatNumber(p.cpuPct, 1)}%</td>
                <td className="r num">{formatKb(p.rssKb)}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="btn icon sm ghost"
                    title={p.pkg ? `Encerrar ${p.pkg}` : 'Encerrar processo'}
                    aria-label={`Encerrar ${p.name}`}
                    onClick={() => ask(p)}
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && rows.length === 0 && <p className="empty">Nenhum processo com esse filtro.</p>}
      </div>
      {rows.length > MAX_ROWS && <p className="hint">Mostrando {MAX_ROWS} de {rows.length}. Use a busca para achar o resto.</p>}
      <p className="hint">
        CPU = % do total do aparelho no último segundo. Memória = RSS (inclui bibliotecas compartilhadas).
      </p>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
