import { ArrowRight, Pause, Play, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { Socket } from '../../../shared/schema';
import { api } from '../../api';

const REFRESH_MS = 2_000;

/** O que costuma rodar em cada porta (ajuda a ler a lista; não é garantia). */
const PORT_HINT: Record<number, string> = {
  53: 'DNS',
  80: 'HTTP',
  443: 'HTTPS',
  853: 'DNS sobre TLS',
  1883: 'MQTT',
  3478: 'STUN (chamadas)',
  5222: 'XMPP (WhatsApp/chat)',
  5228: 'Google push (FCM)',
  8883: 'MQTT TLS',
};

function portLabel(s: Socket): string | null {
  if (s.proto.startsWith('udp') && s.remotePort === 443) return 'QUIC (HTTP/3)';
  return PORT_HINT[s.remotePort] ?? null;
}

function endpoint(ip: string, port: number): string {
  return ip.includes(':') ? `[${ip}]:${port}` : `${ip}:${port}`;
}

/** Domínio registrável aproximado (`edge-x.facebook.com` → `facebook.com`, `api.loja.com.br` → `loja.com.br`). */
function baseDomain(host: string): string {
  const labels = host.split('.');
  const take = labels.length > 2 && /^(com|net|org|gov|edu|co)$/.test(labels.at(-2) ?? '') ? 3 : 2;
  return labels.slice(-take).join('.');
}

function socketKey(s: Socket): string {
  return `${s.proto}-${s.localIp}-${s.localPort}-${s.remoteIp}-${s.remotePort}-${s.uid}`;
}

interface ConnectionsProps {
  serial: string;
  onError(message: string): void;
  /** Abre as requisições HTTP filtradas por esse texto. */
  onInspect(query: string): void;
}

export function Connections({ serial, onError, onInspect }: ConnectionsProps) {
  const [sockets, setSockets] = useState<Socket[] | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [owner, setOwner] = useState('');
  const [query, setQuery] = useState('');
  const [activeOnly, setActiveOnly] = useState(true);

  useEffect(() => {
    if (paused) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api
        .sockets(serial)
        .then((r) => alive && setSockets(r.sockets))
        .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)))
        .finally(() => {
          if (alive) timer = setTimeout(load, REFRESH_MS);
        });
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [serial, paused, onError]);

  const owners = useMemo(() => [...new Set((sockets ?? []).map((s) => s.owner))].sort(), [sockets]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (sockets ?? []).filter(
      (s) =>
        (!activeOnly || s.state === 'ESTABLISHED') &&
        (!owner || s.owner === owner) &&
        (!q || `${s.owner} ${s.remoteIp} ${s.remoteHost ?? ''} ${s.remotePort}`.toLowerCase().includes(q)),
    );
  }, [sockets, owner, query, activeOnly]);

  const selected = selectedKey === null ? null : ((sockets ?? []).find((s) => socketKey(s) === selectedKey) ?? null);

  return (
    <div className="stack">
      <p className="hint">
        Todas as conexões abertas no aparelho, de qualquer app, lidas do <span className="mono">/proc/net</span>. Mostra{' '}
        <b>com quem</b> o app fala, não o conteúdo. É aqui que aparecem apps que ignoram o proxy, como o WhatsApp
        (protocolo próprio com criptografia de ponta a ponta).
      </p>
      <div className="toolbar">
        <select
          className="select"
          aria-label="Filtrar por app"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        >
          <option value="">Todos os apps</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <input
          className="input grow"
          type="search"
          placeholder="Buscar IP, servidor ou porta"
          aria-label="Buscar conexão"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
          <span>Só ativas</span>
        </label>
        <button type="button" className="btn sm" aria-pressed={paused} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {paused ? 'Continuar' : 'Pausar'}
        </button>
      </div>
      <div className="req-layout" data-detail={selectedKey !== null}>
        <div className="table-wrap tall" role="region" aria-label="Conexões" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Servidor</th>
                <th scope="col">Porta</th>
                <th scope="col">Estado</th>
                <th scope="col" className="r">
                  Local
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={socketKey(s)}
                  aria-selected={socketKey(s) === selectedKey}
                  onClick={() => setSelectedKey(socketKey(s) === selectedKey ? null : socketKey(s))}
                >
                  <td className="mono proc-name" title={s.owner}>
                    <button type="button" className="link-cell">
                      {s.owner}
                    </button>
                  </td>
                  <td className="mono host-cell" title={s.remoteHost ? `${s.remoteHost} (${s.remoteIp})` : s.remoteIp}>
                    {s.remoteHost && <span>{s.remoteHost} </span>}
                    <span className={s.remoteHost ? 'muted' : undefined}>{s.remoteIp}</span>
                  </td>
                  <td className="mono nowrap">
                    {s.proto.replace('6', '')} {s.remotePort}
                    {portLabel(s) && <span className="muted"> · {portLabel(s)}</span>}
                  </td>
                  <td className="mono muted">{s.state}</td>
                  <td className="r mono muted">{endpoint(s.localIp, s.localPort)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {sockets && rows.length === 0 && <p className="empty">Nenhuma conexão com esse filtro.</p>}
          {!sockets && <p className="empty">Lendo conexões…</p>}
        </div>
        {selectedKey !== null && (
          <SocketDetail socket={selected} onClose={() => setSelectedKey(null)} onInspect={onInspect} />
        )}
      </div>
    </div>
  );
}

function SocketDetail({
  socket: s,
  onClose,
  onInspect,
}: {
  socket: Socket | null;
  onClose(): void;
  onInspect(query: string): void;
}) {
  if (!s) {
    return (
      <aside className="detail" aria-label="Detalhes da conexão">
        <div className="detail-head">
          <span className="muted">A conexão foi fechada.</span>
          <button type="button" className="btn icon sm ghost" aria-label="Fechar detalhes" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </aside>
    );
  }
  const udp = s.proto.startsWith('udp');
  const encrypted = s.remotePort === 443 || s.remotePort === 853 || s.remotePort === 8883 || s.remotePort === 5222;
  const query = s.remoteHost ? baseDomain(s.remoteHost) : s.remoteIp;
  return (
    <aside className="detail" aria-label="Detalhes da conexão">
      <div className="detail-head">
        <span className="mono detail-url" title={s.owner}>
          {s.owner}
        </span>
        <button type="button" className="btn icon sm ghost" aria-label="Fechar detalhes" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="detail-scroll">
        <dl className="headers mono">
          <div>
            <dt>Servidor</dt>
            <dd>{s.remoteHost ?? 'sem nome reverso'}</dd>
          </div>
          <div>
            <dt>IP</dt>
            <dd>{endpoint(s.remoteIp, s.remotePort)}</dd>
          </div>
          <div>
            <dt>Protocolo</dt>
            <dd>
              {udp ? 'UDP' : 'TCP'} {s.remoteIp.includes(':') ? '(IPv6)' : '(IPv4)'}
              {portLabel(s) && ` · ${portLabel(s)}`}
            </dd>
          </div>
          <div>
            <dt>Estado</dt>
            <dd>{s.state}</dd>
          </div>
          <div>
            <dt>Origem no aparelho</dt>
            <dd>{endpoint(s.localIp, s.localPort)}</dd>
          </div>
          <div>
            <dt>UID</dt>
            <dd>{s.uid}</dd>
          </div>
        </dl>
        <p className="hint">
          {encrypted
            ? 'O tráfego desta conexão é criptografado (TLS). Daqui só dá para ver com quem o app fala, quando e por qual porta. '
            : 'Esta lista lê o kernel: mostra o destino, não os bytes. '}
          O que o app enviou (URL, cabeçalhos, corpo do login) aparece em Requisições HTTP/HTTPS, quando a captura está
          ligada e o app aceita a CA do device-lab.
          {udp &&
            s.remotePort === 443 &&
            ' Conexões QUIC (UDP) não passam pelo proxy; a maioria dos apps cai para HTTPS comum quando o QUIC falha.'}
        </p>
        <button type="button" className="btn sm" onClick={() => onInspect(query)}>
          Ver requisições de <span className="mono">{query}</span> <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
