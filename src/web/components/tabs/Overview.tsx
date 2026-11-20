import { Snowflake, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DeviceInfo, MetricsSample } from '../../../shared/schema';
import { api } from '../../api';
import { formatBytes, formatKb, formatNumber, formatPct, formatRate, formatUptime } from '../../format';
import { LineChart } from '../LineChart';

interface OverviewProps {
  serial: string;
  metrics: readonly MetricsSample[];
  onError(message: string): void;
  onInfo(message: string): void;
}

const celsius = (c: number) => `${formatNumber(c, 1)} °C`;

/** Faixas de alerta: bateria esquenta pouco; chip aguenta bem mais. */
function heatTone(name: string, c: number): 'ok' | 'warn' | 'danger' {
  const [warn, danger] = name === 'Bateria' ? [40, 45] : name === 'Superfície' ? [42, 48] : [70, 85];
  return c >= danger ? 'danger' : c >= warn ? 'warn' : 'ok';
}
const HEAT_LABEL = { ok: 'normal', warn: 'quente', danger: 'muito quente' } as const;

export function Overview({ serial, metrics, onError, onInfo }: OverviewProps) {
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [busy, setBusy] = useState<'ram' | 'cool' | 'undo' | null>(null);
  const [cooled, setCooled] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .info(serial)
      .then((data) => alive && setInfo(data))
      .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [serial, onError]);

  async function run(kind: 'ram' | 'cool' | 'undo') {
    setBusy(kind);
    try {
      const task = kind === 'ram' ? api.freeMemory : kind === 'cool' ? api.coolDown : api.undoCoolDown;
      const result = await task(serial);
      if (kind !== 'ram') setCooled(kind === 'cool');
      onInfo(result.message ?? 'Feito.');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  const last = metrics.at(-1);
  const times = metrics.map((m) => m.t);
  const memPct = last && last.memTotalKb > 0 ? (100 * last.memUsedKb) / last.memTotalKb : null;
  const battery = last?.battery ?? null;
  const temps = (last?.temps ?? []).slice().sort((a, b) => b.c - a.c);

  return (
    <div className="tab-body">
      <dl className="stats">
        <Stat label="CPU" value={formatPct(last?.cpuPct)} sub={last ? `${last.cores.length} núcleos` : undefined} />
        <Stat
          label="RAM em uso"
          value={formatKb(last?.memUsedKb)}
          sub={last ? `${formatPct(memPct)} de ${formatKb(last.memTotalKb)} · ${formatKb(last.memAvailableKb)} livre` : undefined}
        />
        <Stat
          label="RAM Boost (virtual)"
          value={last && last.swapTotalKb > 0 ? formatKb(last.swapUsedKb) : 'desligado'}
          sub={last && last.swapTotalKb > 0 ? `em uso de ${formatKb(last.swapTotalKb)}` : undefined}
        />
        <Stat label="Rede" value={`↓ ${formatRate(last?.netRxBps)}`} sub={`↑ ${formatRate(last?.netTxBps)}`} />
        <Stat
          label="Bateria"
          value={battery ? `${battery.level}%` : '—'}
          sub={battery ? `${battery.charging ? `carregando${battery.source ? ` (${battery.source})` : ''}` : 'na bateria'} · ${celsius(battery.tempC)}` : undefined}
        />
      </dl>

      <section aria-labelledby="cores-title" className="stack">
        <h3 id="cores-title" className="tab-subtitle">
          Núcleos
        </h3>
        <ul className="cores">
          {(last?.cores ?? []).map((core, i) => (
            <li key={i} className="core">
              <span className="core-head">
                <span className="muted">Núcleo {i}</span>
                <b className="num">{formatPct(core.pct)}</b>
              </span>
              <span className="bar-track" aria-hidden="true">
                <span style={{ width: `${core.pct ?? 0}%` }} />
              </span>
              <span className="core-freq num muted">
                {core.freqMhz === null ? '—' : `${formatNumber(core.freqMhz)} MHz`}
                {core.maxMhz !== null && ` / ${formatNumber(core.maxMhz)}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <LineChart
        title="CPU (total)"
        times={times}
        max={100}
        format={(v) => formatPct(v)}
        series={[{ key: 'cpu', label: 'CPU', color: '--series-1', values: metrics.map((m) => m.cpuPct) }]}
      />

      <div className="section-head">
        <h3 className="tab-subtitle">Memória</h3>
        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void run('ram')}>
          <Trash2 size={14} aria-hidden="true" /> {busy === 'ram' ? 'Liberando…' : 'Liberar RAM'}
        </button>
      </div>
      <LineChart
        title="RAM em uso"
        times={times}
        max={last?.memTotalKb ? last.memTotalKb * 1024 : undefined}
        format={(v) => formatBytes(v)}
        series={[{ key: 'mem', label: 'RAM', color: '--series-1', values: metrics.map((m) => m.memUsedKb * 1024) }]}
      />
      {last && last.swapTotalKb > 0 && (
        <LineChart
          title="RAM Boost (memória virtual / swap) em uso"
          times={times}
          max={last.swapTotalKb * 1024}
          format={(v) => formatBytes(v)}
          series={[{ key: 'swap', label: 'Swap', color: '--series-1', values: metrics.map((m) => m.swapUsedKb * 1024) }]}
        />
      )}
      <p className="hint">
        “Liberar RAM” encerra os apps em segundo plano que o Android considera seguros (<span className="mono">am kill-all</span>).
        RAM livre não deixa o aparelho mais rápido por si só: o sistema volta a usar para cache.
      </p>

      <LineChart
        title="Tráfego de rede (todas as interfaces)"
        times={times}
        format={(v) => formatRate(v)}
        series={[
          { key: 'rx', label: 'Recebido', color: '--series-1', values: metrics.map((m) => m.netRxBps) },
          { key: 'tx', label: 'Enviado', color: '--series-2', values: metrics.map((m) => m.netTxBps) },
        ]}
      />

      <section aria-labelledby="heat-title" className="stack">
        <div className="section-head">
          <h3 id="heat-title" className="tab-subtitle">
            Temperatura
          </h3>
          {cooled ? (
            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void run('undo')}>
              {busy === 'undo' ? 'Desfazendo…' : 'Desfazer resfriar'}
            </button>
          ) : (
            <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void run('cool')}>
              <Snowflake size={14} aria-hidden="true" /> {busy === 'cool' ? 'Resfriando…' : 'Esfriar'}
            </button>
          )}
        </div>
        {temps.length === 0 ? (
          <p className="empty">O aparelho não informa sensores de temperatura.</p>
        ) : (
          <ul className="temps">
            {temps.map((t) => {
              const tone = heatTone(t.name, t.c);
              return (
                <li key={t.name} className="temp">
                  <span>{t.name}</span>
                  <b className={`num tone-${tone}`}>{celsius(t.c)}</b>
                  <span className={`temp-state tone-${tone}`}>{HEAT_LABEL[tone]}</span>
                </li>
              );
            })}
          </ul>
        )}
        <LineChart
          title="Temperatura da bateria"
          times={times}
          format={(v) => celsius(v)}
          series={[
            { key: 'bt', label: 'Bateria', color: '--series-1', values: metrics.map((m) => m.battery?.tempC ?? null) },
          ]}
        />
        <p className="hint">
          “Esfriar” encerra apps em segundo plano, liga a economia de bateria e baixa o brilho. O calor cai nos minutos
          seguintes; tirar da tomada e da capinha ajuda mais que qualquer comando.
        </p>
      </section>

      {battery && (
        <section aria-labelledby="battery-title">
          <h3 id="battery-title" className="tab-subtitle">
            Bateria
          </h3>
          <dl className="props">
            <Prop label="Carga" value={`${battery.level}%`} />
            <Prop
              label="Estado"
              value={battery.charging ? `Carregando${battery.source ? ` por ${battery.source}` : ''}` : 'Descarregando'}
            />
            <Prop label="Corrente" value={battery.currentMa === null ? '—' : `${formatNumber(battery.currentMa)} mA`} />
            <Prop label="Tensão" value={`${formatNumber(battery.voltageMv / 1000, 2)} V`} />
            <Prop label="Temperatura" value={celsius(battery.tempC)} />
            <Prop label="Saúde" value={battery.health ?? '—'} />
            <Prop label="Tecnologia" value={battery.technology ?? '—'} />
          </dl>
        </section>
      )}

      <section aria-labelledby="info-title">
        <h3 id="info-title" className="tab-subtitle">
          Aparelho
        </h3>
        {info && (
          <dl className="props">
            <Prop label="Modelo" value={`${info.manufacturer} ${info.model} (${info.device})`} />
            <Prop label="Android" value={`${info.android} · API ${info.sdk}`} />
            <Prop label="Build" value={info.build} mono />
            <Prop label="Patch de segurança" value={info.securityPatch} />
            <Prop label="Tela" value={`${info.screen.width} × ${info.screen.height} px · ${info.screen.density} dpi`} />
            <Prop label="CPU" value={`${info.cpuCores} núcleos · ${info.abi}`} />
            <Prop label="Memória" value={formatKb(info.memTotalKb)} />
            <Prop label="IP (Wi-Fi)" value={info.ip ?? 'sem Wi-Fi'} mono />
            <Prop label="Ligado há" value={formatUptime(info.uptimeSec)} />
            <Prop label="Serial" value={info.serial} mono />
          </dl>
        )}
      </section>
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string | undefined }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
      {sub && <dd className="stat-sub num">{sub}</dd>}
    </div>
  );
}

function Prop({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="prop">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value || '—'}</dd>
    </div>
  );
}
