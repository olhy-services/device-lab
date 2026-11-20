import { type PointerEvent, useEffect, useRef, useState } from 'react';

import { formatClock } from '../format';

export interface Series {
  key: string;
  label: string;
  /** Token de cor da série (`--series-1`, `--series-2`). */
  color: string;
  values: readonly (number | null)[];
}

interface LineChartProps {
  title: string;
  times: readonly number[];
  series: readonly Series[];
  format(value: number): string;
  /** Teto fixo (ex.: 100 para %). Sem ele, a escala acompanha o maior valor. */
  max?: number;
  height?: number;
}

const PAD = { top: 8, right: 8, bottom: 18, left: 52 };

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Linha do tempo das últimas amostras, com cursor e tooltip ao passar o mouse. */
export function LineChart({ title, times, series, format, max, height = 132 }: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry ? entry.contentRect.width : 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = times.length;
  const peak = Math.max(0, ...series.flatMap((s) => s.values.filter((v) => v !== null)));
  const top = max ?? niceMax(peak * 1.1);
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;
  // Janela fixa de 2 minutos: a linha anda da direita para a esquerda.
  const slots = Math.max(n, 120);
  const x = (i: number) => PAD.left + ((slots - n + i) / Math.max(1, slots - 1)) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.min(v, top) / top) * plotH;

  const path = (values: readonly (number | null)[]) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  function onMove(event: PointerEvent<SVGSVGElement>) {
    if (n === 0 || plotW <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = (event.clientX - rect.left - PAD.left) / plotW;
    const i = Math.round(rel * (slots - 1)) - (slots - n);
    setHover(i >= 0 && i < n ? i : null);
  }

  const gridValues = [0, top / 2, top];
  const latest = (s: Series) => {
    for (let i = s.values.length - 1; i >= 0; i--) {
      const v = s.values[i];
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const hoverX = hover === null ? 0 : x(hover);
  const hoverTime = hover === null ? undefined : times[hover];

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-legend">
          {series.map((s) => {
            const value = latest(s);
            return (
              <span key={s.key} className="chart-key">
                {series.length > 1 && <i style={{ background: `var(${s.color})` }} aria-hidden="true" />}
                {series.length > 1 && <span className="muted">{s.label}</span>}
                <b className="num">{value === null ? '—' : format(value)}</b>
              </span>
            );
          })}
        </span>
      </figcaption>
      <div ref={wrapRef} className="chart-plot">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={`${title}, últimos 2 minutos`}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            {gridValues.map((v) => (
              <g key={v}>
                <line className="chart-grid" x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} />
                <text className="chart-axis" x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end">
                  {format(v)}
                </text>
              </g>
            ))}
            <text className="chart-axis" x={PAD.left} y={height - 4}>
              −2 min
            </text>
            <text className="chart-axis" x={PAD.left + plotW} y={height - 4} textAnchor="end">
              agora
            </text>
            {series.map((s) => (
              <path key={s.key} className="chart-line" d={path(s.values)} style={{ stroke: `var(${s.color})` }} />
            ))}
            {hover !== null && (
              <g>
                <line className="chart-cursor" x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + plotH} />
                {series.map((s) => {
                  const v = s.values[hover];
                  return v === null || v === undefined ? null : (
                    <circle key={s.key} className="chart-dot" cx={hoverX} cy={y(v)} r={4} style={{ fill: `var(${s.color})` }} />
                  );
                })}
              </g>
            )}
          </svg>
        )}
        {hover !== null && (
          <div
            className="chart-tip"
            style={{ left: Math.min(hoverX + 10, Math.max(PAD.left, width - 150)) }}
            role="status"
          >
            <div className="muted num">{hoverTime === undefined ? '' : formatClock(hoverTime)}</div>
            {series.map((s) => {
              const v = s.values[hover];
              return (
                <div key={s.key} className="chart-key">
                  <i style={{ background: `var(${s.color})` }} aria-hidden="true" />
                  <span>{s.label}</span>
                  <b className="num">{v === null || v === undefined ? '—' : format(v)}</b>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </figure>
  );
}
