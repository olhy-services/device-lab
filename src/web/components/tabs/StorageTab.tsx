import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { App, Storage } from '../../../shared/schema';
import { api } from '../../api';
import { formatBytes, formatPct } from '../../format';

const TOP_APPS = 10;

export function StorageTab({ serial, onError }: { serial: string; onError(message: string): void }) {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [apps, setApps] = useState<App[]>([]);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([api.storage(serial), api.apps(serial)])
      .then(([s, a]) => {
        if (!alive) return;
        setStorage(s);
        setApps(a.apps);
      })
      .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [serial, onError, version]);

  const load = useCallback(() => {
    setLoading(true);
    setVersion((v) => v + 1);
  }, []);

  if (!storage) {
    return (
      <div className="tab-body">
        <p className="empty">{loading ? 'Lendo o armazenamento…' : 'Não foi possível ler o armazenamento.'}</p>
      </div>
    );
  }

  const used = storage.totalBytes - storage.freeBytes;
  const usedPct = storage.totalBytes > 0 ? (100 * used) / storage.totalBytes : 0;
  const breakdown = storage.breakdown.slice().sort((a, b) => b.bytes - a.bytes);
  const biggest = Math.max(1, ...breakdown.map((b) => b.bytes));
  const heavyApps = apps
    .map((a) => ({ pkg: a.pkg, total: (a.sizeBytes ?? 0) + (a.dataBytes ?? 0) + (a.cacheBytes ?? 0), app: a }))
    .filter((a) => a.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, TOP_APPS);
  const heaviest = Math.max(1, ...heavyApps.map((a) => a.total));

  return (
    <div className="tab-body">
      <div className="section-head">
        <h3 className="tab-subtitle">Armazenamento interno</h3>
        <button type="button" className="btn sm ghost" onClick={load} disabled={loading} aria-label="Atualizar">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="meter-block">
        <p className="meter-figure num">
          <b>{formatBytes(used)}</b> usados de {formatBytes(storage.totalBytes)}
          <span className="muted"> · {formatBytes(storage.freeBytes)} livres</span>
        </p>
        <div
          className="meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(usedPct)}
          aria-label={`${formatPct(usedPct)} do armazenamento em uso`}
        >
          <span style={{ width: `${usedPct}%` }} />
        </div>
      </div>

      {breakdown.length > 0 && (
        <section aria-labelledby="kinds-title">
          <h3 id="kinds-title" className="tab-subtitle">
            Por tipo
          </h3>
          <ul className="bars">
            {breakdown.map((b) => (
              <Bar key={b.key} label={b.label} bytes={b.bytes} max={biggest} />
            ))}
          </ul>
          <p className="hint">Calculado pelo próprio Android; ele atualiza esses números de tempos em tempos.</p>
        </section>
      )}

      {heavyApps.length > 0 && (
        <section aria-labelledby="apps-title">
          <h3 id="apps-title" className="tab-subtitle">
            Apps que mais ocupam (app + dados + cache)
          </h3>
          <ul className="bars">
            {heavyApps.map((a) => (
              <Bar key={a.pkg} label={a.pkg} bytes={a.total} max={heaviest} mono />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Bar({ label, bytes, max, mono = false }: { label: string; bytes: number; max: number; mono?: boolean }) {
  return (
    <li className="bar-row">
      <span className={mono ? 'bar-label mono' : 'bar-label'} title={label}>
        {label}
      </span>
      <span className="bar-track" aria-hidden="true">
        <span style={{ width: `${Math.max(0.5, (100 * bytes) / max)}%` }} />
      </span>
      <span className="bar-value num">{formatBytes(bytes)}</span>
    </li>
  );
}
