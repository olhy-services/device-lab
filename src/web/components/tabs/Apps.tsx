import { Eraser, Play, RefreshCw, Square, Trash2, Upload } from 'lucide-react';
import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';

import type { App, AppAction } from '../../../shared/schema';
import { api } from '../../api';
import { formatBytes } from '../../format';
import { ConfirmDialog, type ConfirmRequest } from '../ConfirmDialog';

interface AppsProps {
  serial: string;
  foregroundPkg: string | null;
  onError(message: string): void;
  onInfo(message: string): void;
}

export function Apps({ serial, foregroundPkg, onError, onInfo }: AppsProps) {
  const [apps, setApps] = useState<App[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [busyPkg, setBusyPkg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .apps(serial)
      .then((r) => alive && setApps(r.apps))
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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (apps ?? []).filter((a) => (showSystem || !a.system) && (!q || a.pkg.toLowerCase().includes(q)));
  }, [apps, query, showSystem]);

  async function run(pkg: string, action: AppAction) {
    setBusyPkg(pkg);
    try {
      const result = await api.appAction(serial, pkg, action);
      onInfo(result.message ?? 'Feito.');
      if (action === 'uninstall' || action === 'clear-data') load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyPkg(null);
    }
  }

  async function install(file: File) {
    if (!file.name.toLowerCase().endsWith('.apk')) {
      onError('Envie um arquivo .apk (para .aab, gere um APK com o bundletool).');
      return;
    }
    setInstalling(file.name);
    try {
      const result = await api.install(serial, file);
      onInfo(`${file.name}: ${result.message ?? 'instalado'}`);
      load();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setInstalling(null);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void install(file);
  }

  return (
    <div
      className="tab-body"
      data-dragging={dragging}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="toolbar">
        <input
          className="input grow"
          type="search"
          placeholder="Buscar pacote"
          aria-label="Buscar app pelo pacote"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
          <span>Apps do sistema</span>
        </label>
        <button type="button" className="btn sm ghost" onClick={load} disabled={loading} aria-label="Atualizar lista">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <label className="btn sm">
          <Upload size={14} aria-hidden="true" /> Instalar APK
          <input
            type="file"
            accept=".apk,application/vnd.android.package-archive"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void install(file);
            }}
          />
        </label>
      </div>
      <p className="hint" role="status">
        {installing
          ? `Instalando ${installing}…`
          : dragging
            ? 'Solte o APK para instalar.'
            : 'Arraste um APK para esta aba para instalar (substitui a versão instalada, mantendo os dados).'}
      </p>

      {apps === null ? (
        <p className="empty">{loading ? 'Carregando apps…' : 'Não foi possível listar os apps.'}</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Apps instalados" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Pacote</th>
                <th scope="col" className="r">
                  App
                </th>
                <th scope="col" className="r">
                  Dados
                </th>
                <th scope="col" className="r">
                  Cache
                </th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((app) => (
                <tr key={app.pkg}>
                  <td>
                    <span className="mono">{app.pkg}</span>
                    {app.pkg === foregroundPkg && <span className="badge ok">na tela</span>}
                    {app.system && <span className="badge muted">sistema</span>}
                    {app.versionCode !== null && <span className="muted mono"> v{app.versionCode}</span>}
                  </td>
                  <td className="r num">{formatBytes(app.sizeBytes)}</td>
                  <td className="r num">{formatBytes(app.dataBytes)}</td>
                  <td className="r num">{formatBytes(app.cacheBytes)}</td>
                  <td className="actions">
                    <IconButton label="Abrir" disabled={busyPkg === app.pkg} onClick={() => void run(app.pkg, 'launch')}>
                      <Play size={14} />
                    </IconButton>
                    <IconButton
                      label="Forçar parada"
                      disabled={busyPkg === app.pkg}
                      onClick={() => void run(app.pkg, 'force-stop')}
                    >
                      <Square size={14} />
                    </IconButton>
                    <IconButton
                      label="Apagar dados"
                      disabled={busyPkg === app.pkg}
                      onClick={() =>
                        setConfirm({
                          title: 'Apagar os dados do app?',
                          body: (
                            <p>
                              Apaga login, banco local, preferências e cache de <span className="mono">{app.pkg}</span>.
                              O app volta ao estado de recém-instalado. Não dá para desfazer.
                            </p>
                          ),
                          confirmLabel: 'Apagar dados',
                          tone: 'danger',
                          onConfirm: () => void run(app.pkg, 'clear-data'),
                        })
                      }
                    >
                      <Eraser size={14} />
                    </IconButton>
                    {!app.system && (
                      <IconButton
                        label="Desinstalar"
                        disabled={busyPkg === app.pkg}
                        onClick={() =>
                          setConfirm({
                            title: 'Desinstalar o app?',
                            body: (
                              <p>
                                Remove <span className="mono">{app.pkg}</span> e todos os dados dele do aparelho.
                              </p>
                            ),
                            confirmLabel: 'Desinstalar',
                            tone: 'danger',
                            onConfirm: () => void run(app.pkg, 'uninstall'),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="empty">Nenhum app com esse nome.</p>}
        </div>
      )}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button type="button" className="btn icon sm ghost" title={label} aria-label={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}
