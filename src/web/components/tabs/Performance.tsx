import type { MetricsSample } from '../../../shared/schema';
import { formatKb, formatNumber, formatPct } from '../../format';
import { LineChart } from '../LineChart';
import { Stat } from './Overview';

/** Quadros acima disso perdem o prazo de 60 Hz. */
const FRAME_BUDGET_MS = 16.7;

export function Performance({ metrics }: { metrics: readonly MetricsSample[] }) {
  const last = metrics.at(-1);
  const app = last?.app ?? null;

  if (!app) {
    return (
      <div className="tab-body">
        <p className="empty">
          Abra um app no aparelho. As medidas são sempre do app em primeiro plano (o que está na tela).
        </p>
      </div>
    );
  }

  // Só as amostras do app atual: trocar de app recomeça os gráficos.
  let from = metrics.length;
  while (from > 0 && metrics[from - 1]?.app?.pkg === app.pkg) from -= 1;
  const own = metrics.slice(from);
  const times = own.map((m) => m.t);
  const slow = app.p90FrameMs !== null && app.p90FrameMs > FRAME_BUDGET_MS;

  return (
    <div className="tab-body">
      <p className="app-line">
        <span className="mono">{app.pkg}</span>
        {last?.foreground?.pid !== null && last?.foreground?.pid !== undefined && (
          <span className="muted mono">pid {last.foreground.pid}</span>
        )}
      </p>

      <dl className="stats">
        <Stat label="Quadros/s" value={formatNumber(app.fps)} sub="quadros desenhados (parado = 0)" />
        <Stat label="Travadas" value={formatPct(app.jankPct)} sub="quadros lentos no último segundo" />
        <Stat
          label="90% dos quadros em até"
          value={app.p90FrameMs === null ? '—' : `${formatNumber(app.p90FrameMs)} ms`}
          sub={slow ? 'acima de 16,7 ms: perde 60 Hz' : 'meta: 16,7 ms (60 Hz)'}
        />
        <Stat label="CPU do app" value={formatPct(app.cpuPct)} sub="do total do aparelho" />
        <Stat label="Memória do app" value={formatKb(app.rssKb)} sub="RSS (inclui bibliotecas)" />
      </dl>

      <LineChart
        title="Quadros por segundo"
        times={times}
        format={(v) => formatNumber(v)}
        series={[{ key: 'fps', label: 'Quadros/s', color: '--series-1', values: own.map((m) => m.app?.fps ?? null) }]}
      />
      <LineChart
        title="Quadros lentos (%)"
        times={times}
        max={100}
        format={(v) => formatPct(v)}
        series={[
          { key: 'jank', label: 'Travadas', color: '--series-1', values: own.map((m) => m.app?.jankPct ?? null) },
        ]}
      />
      <LineChart
        title="CPU do app"
        times={times}
        format={(v) => formatPct(v)}
        series={[{ key: 'cpu', label: 'CPU', color: '--series-1', values: own.map((m) => m.app?.cpuPct ?? null) }]}
      />
      <LineChart
        title="Memória do app (RSS)"
        times={times}
        format={(v) => formatKb(v)}
        series={[{ key: 'rss', label: 'RSS', color: '--series-1', values: own.map((m) => m.app?.rssKb ?? null) }]}
      />
      <p className="hint">
        Quadros e travadas vêm do <span className="mono">dumpsys gfxinfo</span> e só contam o que o app desenha com
        a renderização do Android (Views, Compose, React Native). Flutter, jogos e telas em SurfaceView/OpenGL aparecem como 0.
      </p>
    </div>
  );
}
