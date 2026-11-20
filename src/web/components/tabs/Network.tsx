import { Copy, Download, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { HttpExchange, MetricsSample, ProxyStatus, TlsFailure } from '../../../shared/schema';
import { api } from '../../api';
import { formatBytes, formatMs, formatRate } from '../../format';
import { LineChart } from '../LineChart';
import { Connections } from './Connections';

interface NetworkProps {
  serial: string;
  metrics: readonly MetricsSample[];
  http: readonly HttpExchange[];
  proxy: ProxyStatus | null;
  tlsFailures: readonly TlsFailure[];
  onError(message: string): void;
}

export function Network({ serial, metrics, http, proxy, tlsFailures, onError }: NetworkProps) {
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<'sockets' | 'http'>('sockets');
  const capturing = proxy?.capturing ?? false;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? http.filter((x) => `${x.method} ${x.url} ${x.status ?? ''}`.toLowerCase().includes(q)) : http;
    // Mais recentes em cima.
    return list.slice().reverse();
  }, [http, query]);
  const selected = selectedId === null ? null : (http.find((x) => x.id === selectedId) ?? null);
  const failedHosts = [...new Set(tlsFailures.filter((f) => f.reason === 'cert-rejected').map((f) => f.host))];

  async function toggle() {
    setBusy(true);
    try {
      await (capturing ? api.proxyStop(serial) : api.proxyStart(serial));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tab-body">
      <LineChart
        title="Tráfego de rede (todas as interfaces)"
        times={metrics.map((m) => m.t)}
        format={(v) => formatRate(v)}
        series={[
          {
            key: 'rx',
            label: 'Recebido',
            color: '--series-1',
            values: metrics.map((m) => m.netRxBps),
          },
          {
            key: 'tx',
            label: 'Enviado',
            color: '--series-2',
            values: metrics.map((m) => m.netTxBps),
          },
        ]}
      />

      <div className="segmented" role="group" aria-label="O que ver">
        <button type="button" aria-pressed={view === 'sockets'} onClick={() => setView('sockets')}>
          Conexões de todos os apps
        </button>
        <button type="button" aria-pressed={view === 'http'} onClick={() => setView('http')}>
          Requisições HTTP/HTTPS{http.length > 0 ? ` (${http.length})` : ''}
        </button>
      </div>

      {view === 'sockets' && (
        <Connections
          serial={serial}
          onError={onError}
          onInspect={(q) => {
            setQuery(q);
            setSelectedId(null);
            setView('http');
          }}
        />
      )}

      {view === 'http' && (
        <section className="requests" aria-labelledby="req-title">
          <div className="section-head">
            <h3 id="req-title" className="tab-subtitle">
              Requisições HTTP/HTTPS
            </h3>
            <div className="row">
              {http.length > 0 && (
                <button type="button" className="btn sm ghost" onClick={() => void api.clearHttp(serial)}>
                  <Trash2 size={14} aria-hidden="true" /> Limpar
                </button>
              )}
              <button
                type="button"
                className={capturing ? 'btn sm' : 'btn sm primary'}
                disabled={busy}
                onClick={() => void toggle()}
              >
                {busy ? 'Aguarde…' : capturing ? 'Parar captura' : 'Capturar requisições'}
              </button>
            </div>
          </div>

          {capturing ? (
            <p className="status-line">
              <span className="dot ok" aria-hidden="true" />
              <span>
                Capturando pelo proxy na porta <span className="mono">{proxy?.port}</span>. Parar devolve a internet
                normal ao aparelho.
              </span>
            </p>
          ) : (
            <CaptureHelp />
          )}

          {failedHosts.length > 0 && (
            <div className="error" role="alert">
              Estes servidores foram recusados porque o app não confia no certificado do device-lab:{' '}
              <span className="mono">{failedHosts.slice(0, 6).join(', ')}</span>
              {failedHosts.length > 6 && ` e mais ${failedHosts.length - 6}`}. Instale a CA no aparelho e libere
              certificados de usuário no app (veja abaixo).
            </div>
          )}

          {(capturing || http.length > 0) && (
            <input
              className="input"
              type="search"
              placeholder="Filtrar por URL, método ou status"
              aria-label="Filtrar requisições"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {rows.length > 0 && (
            <div className="req-layout" data-detail={selected !== null}>
              <div className="table-wrap" role="region" aria-label="Lista de requisições" tabIndex={0}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Método</th>
                      <th scope="col">Status</th>
                      <th scope="col">URL</th>
                      <th scope="col" className="r">
                        Tamanho
                      </th>
                      <th scope="col" className="r">
                        Tempo
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((x) => (
                      <tr
                        key={x.id}
                        aria-selected={x.id === selectedId}
                        onClick={() => setSelectedId(x.id === selectedId ? null : x.id)}
                      >
                        <td className="mono">{x.method}</td>
                        <td>
                          <StatusBadge exchange={x} />
                        </td>
                        <td className="url">
                          <button type="button" className="link-cell" title={x.url}>
                            <span className="muted">{x.host}</span>
                            {x.path}
                          </button>
                        </td>
                        <td className="r num">{x.responseBytes === null ? '' : formatBytes(x.responseBytes)}</td>
                        <td className="r num">{formatMs(x.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {selected && <ExchangeDetail exchange={selected} onClose={() => setSelectedId(null)} />}
            </div>
          )}
          {http.length > 0 && rows.length === 0 && (
            <p className="empty">
              Nenhuma requisição para “{query}”. Se o app usa esse servidor e nada aparece, ele não passa pelo proxy ou
              recusa a CA (veja a ajuda acima).
            </p>
          )}
          {capturing && http.length === 0 && (
            <p className="empty">Nenhuma requisição ainda. Use o app no aparelho; elas aparecem aqui na hora.</p>
          )}
        </section>
      )}
    </div>
  );
}

function StatusBadge({ exchange }: { exchange: HttpExchange }) {
  if (exchange.error) return <span className="badge danger">falhou</span>;
  if (exchange.status === null) return <span className="badge muted">…</span>;
  const tone =
    exchange.status >= 500 ? 'danger' : exchange.status >= 400 ? 'warn' : exchange.status >= 300 ? 'muted' : 'ok';
  return <span className={`badge ${tone} num`}>{exchange.status}</span>;
}

function CaptureHelp() {
  return (
    <details className="help">
      <summary>Como funciona e o que precisa no app</summary>
      <ol className="steps">
        <li>
          <b>Capturar requisições</b> liga um proxy só neste computador e aponta o aparelho para ele pelo cabo/adb (
          <span className="mono">adb reverse</span>). Nada fica exposto na rede.
        </li>
        <li>
          HTTP aparece direto. Para ver <b>HTTPS</b>, instale o certificado no aparelho: ele é copiado para{' '}
          <span className="mono">Download/device-lab-ca.crt</span> ao iniciar. No aparelho: Configurações › Segurança ›
          Mais configurações › Criptografia e credenciais › Instalar certificado › Certificado CA.{' '}
          <a href="/api/ca.pem" download>
            <Download size={12} aria-hidden="true" /> Baixar a CA
          </a>
        </li>
        <li>
          Desde o Android 7 os apps só confiam nesse certificado se permitirem. Na build de debug do seu app, adicione
          em <span className="mono">network_security_config.xml</span>:{' '}
          <span className="mono">
            {'<debug-overrides><trust-anchors><certificates src="user"/></trust-anchors></debug-overrides>'}
          </span>
        </li>
        <li>
          Só passa por aqui quem respeita o proxy do sistema e fala HTTP. WhatsApp (protocolo próprio, criptografia de
          ponta a ponta), apps Flutter e apps com certificate pinning não aparecem ou aparecem como recusados; veja em{' '}
          <b>Conexões de todos os apps</b> com quem eles falam.
        </li>
      </ol>
    </details>
  );
}

function pretty(body: string | null, mime: string | null): string | null {
  if (body === null) return null;
  if (mime && /json/i.test(mime)) {
    try {
      const value: unknown = JSON.parse(body);
      return JSON.stringify(value, null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

function curl(x: HttpExchange): string {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const skip = new Set(['host', 'content-length', 'connection', 'accept-encoding']);
  const parts = [`curl -X ${x.method} ${q(x.url)}`];
  for (const [k, v] of Object.entries(x.requestHeaders))
    if (!skip.has(k.toLowerCase())) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (x.requestBody) parts.push(`--data-raw ${q(x.requestBody)}`);
  return parts.join(' \\\n  ');
}

function ExchangeDetail({ exchange: x, onClose }: { exchange: HttpExchange; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  const requestMime = x.requestHeaders['content-type'] ?? null;
  const reqBody = pretty(x.requestBody, requestMime);
  const resBody = pretty(x.responseBody, x.mime);

  return (
    <aside className="detail" aria-label="Detalhes da requisição">
      <div className="detail-head">
        <span className="mono detail-url" title={x.url}>
          {x.method} {x.url}
        </span>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() =>
            void navigator.clipboard.writeText(curl(x)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            })
          }
        >
          <Copy size={14} aria-hidden="true" /> {copied ? 'Copiado' : 'cURL'}
        </button>
        <button type="button" className="btn icon sm ghost" aria-label="Fechar detalhes" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="detail-scroll">
        <p className="hint num">
          {x.error ? `Falhou: ${x.error}` : x.status === null ? 'Aguardando resposta…' : `Status ${x.status}`}
          {x.durationMs !== null && ` · ${formatMs(x.durationMs)}`}
          {x.responseBytes !== null && ` · ${formatBytes(x.responseBytes)}`}
        </p>
        <Headers title="Cabeçalhos da requisição" headers={x.requestHeaders} />
        {reqBody !== null && <Body title="Corpo da requisição" text={reqBody} />}
        {x.responseHeaders && <Headers title="Cabeçalhos da resposta" headers={x.responseHeaders} />}
        {resBody !== null && <Body title="Corpo da resposta" text={resBody} />}
        {x.bodyTruncated && <p className="hint">Parte do corpo não é mostrada (binário ou maior que 256 KB).</p>}
      </div>
    </aside>
  );
}

function Headers({ title, headers }: { title: string; headers: Record<string, string> }) {
  return (
    <details open>
      <summary>{title}</summary>
      <dl className="headers mono">
        {Object.entries(headers).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function Body({ title, text }: { title: string; text: string }) {
  return (
    <details open>
      <summary>{title}</summary>
      <pre className="code">{text}</pre>
    </details>
  );
}
