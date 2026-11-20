import { ArrowUp, Download, Eye, File, Folder, FolderSymlink, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import type { DirListing, FileEntry } from '../../../shared/schema';
import { api } from '../../api';
import { formatBytes } from '../../format';
import { ConfirmDialog, type ConfirmRequest } from '../ConfirmDialog';

const SHORTCUTS = ['/sdcard', '/sdcard/Download', '/sdcard/DCIM', '/sdcard/Android/data', '/data/local/tmp', '/system', '/vendor', '/proc'];
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;

interface FilesProps {
  serial: string;
  onError(message: string): void;
  onInfo(message: string): void;
}

interface Preview {
  entry: FileEntry;
  text: string | null;
  note: string | null;
}

const VIA_LABEL = { shell: 'shell do adb', root: 'root', 'run-as': 'como o app' } as const;

export function Files({ serial, onError, onInfo }: FilesProps) {
  const [as, setAs] = useState('');
  const [path, setPath] = useState('/sdcard');
  const [draft, setDraft] = useState('/sdcard');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [access, setAccess] = useState<{ rooted: boolean; debuggable: string[] } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .fileAccess(serial)
      .then((a) => alive && setAccess(a))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [serial]);

  useEffect(() => {
    let alive = true;
    api
      .listDir(serial, path, as)
      .then((l) => {
        if (!alive) return;
        setListing(l);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setListing(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [serial, path, as, version]);

  function go(next: string) {
    setLoading(true);
    setPreview(null);
    setPath(next);
    setDraft(next);
  }

  function readAs(pkg: string) {
    setAs(pkg);
    go(pkg ? `/data/data/${pkg}` : '/sdcard');
  }

  function reload() {
    setLoading(true);
    setVersion((v) => v + 1);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    if (next.startsWith('/')) go(next);
  }

  async function open(entry: FileEntry) {
    if (entry.kind === 'dir') {
      go(entry.path);
      return;
    }
    if (IMAGE.test(entry.name)) {
      setPreview({ entry, text: null, note: null });
      return;
    }
    try {
      const p = await api.preview(serial, entry.path, as);
      setPreview({
        entry,
        text: p.binary ? null : p.text,
        note: p.binary ? 'Arquivo binário: baixe para abrir (ex.: banco SQLite com o sqlite3).' : p.truncated ? 'Mostrando os primeiros 64 KB.' : null,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  function askDelete(entry: FileEntry) {
    setConfirm({
      title: `Apagar ${entry.name}?`,
      body: (
        <p>
          {entry.kind === 'dir' ? 'A pasta e tudo dentro dela' : 'O arquivo'} em <span className="mono">{entry.path}</span>{' '}
          será apagado do aparelho. Não vai para a lixeira e não dá para desfazer.
        </p>
      ),
      confirmLabel: 'Apagar',
      tone: 'danger',
      onConfirm: () =>
        void api
          .deletePath(serial, entry.path, as)
          .then((r) => {
            onInfo(r.message ?? 'Apagado.');
            if (preview?.entry.path === entry.path) setPreview(null);
            reload();
          })
          .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e))),
    });
  }

  async function upload(file: File) {
    setUploading(true);
    try {
      onInfo((await api.upload(serial, path, file)).message ?? 'Enviado.');
      reload();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }

  const parent = path === '/' ? null : path.replace(/\/[^/]+$/, '') || '/';
  const crumbs = path.split('/').filter(Boolean);
  const shortcuts = as ? [`/data/data/${as}`, `/sdcard/Android/data/${as}`] : SHORTCUTS;

  return (
    <div className="tab-body">
      <div className="toolbar">
        <label className="field-inline">
          <span className="muted">Ler como</span>
          <select className="select" value={as} onChange={(e) => readAs(e.target.value)} aria-label="Ler como">
            <option value="">{access?.rooted ? 'root' : 'shell do adb'}</option>
            {(access?.debuggable ?? []).map((pkg) => (
              <option key={pkg} value={pkg}>
                {pkg} (debug)
              </option>
            ))}
          </select>
        </label>
        <div className="chips" role="group" aria-label="Atalhos">
          {shortcuts.map((s) => (
            <button key={s} type="button" className="chip mono" aria-pressed={path === s} onClick={() => go(s)}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <form className="row" onSubmit={submit}>
        <button
          type="button"
          className="btn icon sm"
          aria-label="Pasta de cima"
          title="Pasta de cima"
          disabled={!parent}
          onClick={() => parent && go(parent)}
        >
          <ArrowUp size={15} aria-hidden="true" />
        </button>
        <input
          className="input grow mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-label="Caminho no aparelho"
          spellCheck={false}
        />
        <button type="submit" className="btn sm">
          Ir
        </button>
        <button type="button" className="btn icon sm ghost" aria-label="Atualizar" onClick={reload}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        {!as && (
          <label className={uploading ? 'btn sm disabled' : 'btn sm'}>
            <Upload size={14} aria-hidden="true" /> {uploading ? 'Enviando…' : 'Enviar'}
            <input
              type="file"
              hidden
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
        )}
      </form>

      <nav className="crumbs mono" aria-label="Caminho">
        <button type="button" onClick={() => go('/')}>
          /
        </button>
        {crumbs.map((c, i) => {
          const target = `/${crumbs.slice(0, i + 1).join('/')}`;
          return (
            <span key={target}>
              <button type="button" onClick={() => go(target)} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                {c}
              </button>
              {i < crumbs.length - 1 && <span className="muted">/</span>}
            </span>
          );
        })}
        {listing && <span className="muted crumbs-via">lendo como {VIA_LABEL[listing.via]}</span>}
      </nav>

      {error && <p className="error">{error}</p>}

      <div className="req-layout" data-detail={preview !== null}>
        <div className="table-wrap tall" role="region" aria-label="Arquivos" tabIndex={0} aria-busy={loading}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col" className="r">
                  Tamanho
                </th>
                <th scope="col">Modificado</th>
                <th scope="col">Permissões</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {(listing?.entries ?? []).map((entry) => (
                <tr key={entry.path} aria-selected={preview?.entry.path === entry.path}>
                  <td className="url">
                    <button type="button" className="link-cell file-name" onClick={() => void open(entry)} title={entry.path}>
                      {entry.kind === 'dir' ? (
                        entry.link ? (
                          <FolderSymlink size={14} aria-hidden="true" />
                        ) : (
                          <Folder size={14} aria-hidden="true" />
                        )
                      ) : (
                        <File size={14} aria-hidden="true" />
                      )}
                      {entry.name}
                    </button>
                  </td>
                  <td className="r num">{entry.kind === 'dir' ? '' : formatBytes(entry.sizeBytes)}</td>
                  <td className="num muted nowrap">
                    {entry.modifiedAt > 0 ? new Date(entry.modifiedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''}
                  </td>
                  <td className="mono muted nowrap">{entry.mode}</td>
                  <td className="actions">
                    {entry.kind === 'file' && (
                      <>
                        <button
                          type="button"
                          className="btn icon sm ghost"
                          title="Ver"
                          aria-label={`Ver ${entry.name}`}
                          onClick={() => void open(entry)}
                        >
                          <Eye size={14} aria-hidden="true" />
                        </button>
                        <a
                          className="btn icon sm ghost"
                          href={api.downloadUrl(serial, entry.path, as)}
                          download={entry.name}
                          title="Baixar"
                          aria-label={`Baixar ${entry.name}`}
                        >
                          <Download size={14} aria-hidden="true" />
                        </a>
                      </>
                    )}
                    {entry.path.split('/').length > 2 && (
                      <button
                        type="button"
                        className="btn icon sm ghost"
                        title="Apagar"
                        aria-label={`Apagar ${entry.name}`}
                        onClick={() => askDelete(entry)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listing && listing.entries.length === 0 && <p className="empty">Pasta vazia.</p>}
          {listing?.truncated && <p className="hint">Mostrando os primeiros 3.000 itens.</p>}
        </div>

        {preview && (
          <aside className="detail" aria-label={`Conteúdo de ${preview.entry.name}`}>
            <div className="detail-head">
              <span className="mono detail-url" title={preview.entry.path}>
                {preview.entry.name}
              </span>
              <a className="btn sm ghost" href={api.downloadUrl(serial, preview.entry.path, as)} download={preview.entry.name}>
                <Download size={14} aria-hidden="true" /> Baixar
              </a>
              <button type="button" className="btn icon sm ghost" aria-label="Fechar" onClick={() => setPreview(null)}>
                <X size={15} aria-hidden="true" />
              </button>
            </div>
            <div className="detail-scroll">
              {IMAGE.test(preview.entry.name) ? (
                <img className="preview-img" src={api.downloadUrl(serial, preview.entry.path, as)} alt={preview.entry.name} />
              ) : (
                preview.text !== null && <pre className="code">{preview.text}</pre>
              )}
              {preview.note && <p className="hint">{preview.note}</p>}
            </div>
          </aside>
        )}
      </div>
      <p className="hint">
        Sem root, o shell do adb lê <span className="mono">/sdcard</span>, <span className="mono">/system</span>,{' '}
        <span className="mono">/vendor</span> e <span className="mono">/proc</span>. A pasta privada de um app
        (<span className="mono">/data/data/…</span>: shared_prefs, bancos, cache) abre em “Ler como” para builds de debug.
      </p>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
