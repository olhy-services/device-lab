import { Pause, Play, Trash2 } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { type LogLevel, LogLevelSchema, type LogLine, type MetricsSample } from '../../../shared/schema';
import { api } from '../../api';

const LEVEL_RANK: Record<LogLevel, number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
const LEVEL_LABEL: Record<LogLevel, string> = {
  V: 'Verbose',
  D: 'Debug',
  I: 'Info',
  W: 'Aviso',
  E: 'Erro',
  F: 'Fatal',
};
const MAX_RENDERED = 1_500;

interface LogcatProps {
  serial: string;
  logs: readonly LogLine[];
  last: MetricsSample | undefined;
  onError(message: string): void;
}

export function Logcat({ serial, logs, last, onError }: LogcatProps) {
  const [minLevel, setMinLevel] = useState<LogLevel>('D');
  const [onlyApp, setOnlyApp] = useState(true);
  const [query, setQuery] = useState('');
  const [frozen, setFrozen] = useState<readonly LogLine[] | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const pid = last?.foreground?.pid ?? null;
  const pkg = last?.foreground?.pkg ?? null;
  const source = frozen ?? logs;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rank = LEVEL_RANK[minLevel];
    const out: LogLine[] = [];
    // De trás para frente: só as últimas MAX_RENDERED que passam no filtro.
    for (let i = source.length - 1; i >= 0 && out.length < MAX_RENDERED; i--) {
      const line = source[i];
      if (!line || LEVEL_RANK[line.level] < rank) continue;
      if (onlyApp && pid !== null && line.pid !== pid) continue;
      if (q && !`${line.tag} ${line.message}`.toLowerCase().includes(q)) continue;
      out.push(line);
    }
    return out.reverse();
  }, [source, minLevel, onlyApp, pid, query]);

  // Acompanha o fim enquanto o dev estiver no fim; se rolou para cima, não puxa.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [visible]);

  async function clear() {
    try {
      await api.clearLogs(serial);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="tab-body logcat">
      <div className="toolbar">
        <input
          className="input grow"
          type="search"
          placeholder="Buscar por tag ou mensagem"
          aria-label="Buscar no logcat"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="select"
          aria-label="Nível mínimo"
          value={minLevel}
          onChange={(e) => {
            const level = LogLevelSchema.safeParse(e.target.value);
            if (level.success) setMinLevel(level.data);
          }}
        >
          {LogLevelSchema.options.map((level) => (
            <option key={level} value={level}>
              {LEVEL_LABEL[level]} e acima
            </option>
          ))}
        </select>
        <label className="check" title={pkg ?? 'Nenhum app em primeiro plano'}>
          <input type="checkbox" checked={onlyApp} onChange={(e) => setOnlyApp(e.target.checked)} />
          <span>Só o app na tela</span>
        </label>
        <button
          type="button"
          className="btn sm"
          aria-pressed={frozen !== null}
          onClick={() => setFrozen(frozen ? null : logs.slice())}
        >
          {frozen ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {frozen ? 'Continuar' : 'Pausar'}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => void clear()}>
          <Trash2 size={14} aria-hidden="true" /> Limpar
        </button>
      </div>
      {onlyApp && (
        <p className="hint">
          {pkg && pid !== null ? (
            <>
              Mostrando <span className="mono">{pkg}</span> (pid {pid}).
            </>
          ) : (
            'Nenhum app em primeiro plano: mostrando tudo.'
          )}
        </p>
      )}
      <div
        ref={listRef}
        className="log-list mono"
        role="log"
        aria-live="off"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {visible.length === 0 && <p className="empty">Nada por aqui com esses filtros.</p>}
        {visible.map((line) => (
          <div key={line.id} className="log-line" data-level={line.level}>
            <span className="log-time">{line.time.slice(6)}</span>
            <span className="log-level" title={LEVEL_LABEL[line.level]}>
              {line.level}
            </span>
            <span className="log-tag" title={`pid ${line.pid} · tid ${line.tid}`}>
              {line.tag}
            </span>
            <span className="log-msg">{line.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
