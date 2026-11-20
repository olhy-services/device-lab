import { useEffect, useReducer } from 'react';

import {
  type HttpExchange,
  type LogLine,
  type MetricsSample,
  type ProxyStatus,
  type ServerEvent,
  ServerEventSchema,
  type TlsFailure,
} from '../shared/schema';

const MAX_LOGS = 5_000;
const MAX_HISTORY = 120;
const MAX_TLS = 50;

export interface DeviceLive {
  connected: boolean;
  metrics: MetricsSample[];
  logs: LogLine[];
  /** Ordem de chegada; a mesma requisição é atualizada no lugar quando a resposta chega. */
  http: HttpExchange[];
  proxy: ProxyStatus | null;
  tlsFailures: TlsFailure[];
  /** Mensagem do servidor sobre o aparelho (não responde, proxy limpo…); some na próxima amostra. */
  notice: string | null;
}

const initial: DeviceLive = {
  connected: false,
  metrics: [],
  logs: [],
  http: [],
  proxy: null,
  tlsFailures: [],
  notice: null,
};

type Action = ServerEvent | { type: 'socket'; connected: boolean } | { type: 'reset' } | { type: 'dismiss' };

function reduce(state: DeviceLive, action: Action): DeviceLive {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'socket':
      return { ...state, connected: action.connected };
    case 'dismiss':
      return { ...state, notice: null };
    case 'snapshot':
      return {
        ...state,
        metrics: action.metrics,
        logs: action.logs,
        http: action.http,
        proxy: action.proxy,
      };
    case 'metrics': {
      const metrics = state.metrics.length >= MAX_HISTORY ? state.metrics.slice(1) : state.metrics.slice();
      metrics.push(action.sample);
      // Amostra nova = o aparelho voltou a responder.
      const notice = state.notice && /não responde|desconectado/i.test(state.notice) ? null : state.notice;
      return { ...state, metrics, notice };
    }
    case 'logs': {
      const logs = state.logs.concat(action.lines);
      return { ...state, logs: logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs };
    }
    case 'logs-cleared':
      return { ...state, logs: [] };
    case 'http': {
      const index = state.http.findIndex((x) => x.id === action.exchange.id);
      const http = state.http.slice();
      if (index >= 0) http[index] = action.exchange;
      else http.push(action.exchange);
      return { ...state, http };
    }
    case 'http-cleared':
      return { ...state, http: [], tlsFailures: [] };
    case 'tls-failure':
      return { ...state, tlsFailures: [action.failure, ...state.tlsFailures].slice(0, MAX_TLS) };
    case 'proxy':
      return { ...state, proxy: action.status };
    case 'device-error':
      return { ...state, notice: action.message };
  }
}

/** Canal ao vivo de um aparelho: métricas, logcat e requisições. Reconecta sozinho. */
export function useDeviceEvents(serial: string | null): DeviceLive & { dismissNotice(): void } {
  const [state, dispatch] = useReducer(reduce, initial);

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (!serial) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    const open = () => {
      socket = new WebSocket(`ws://${location.host}/ws/events/${encodeURIComponent(serial)}`);
      socket.onopen = () => dispatch({ type: 'socket', connected: true });
      socket.onmessage = (message: MessageEvent<unknown>) => {
        if (typeof message.data !== 'string') return;
        let value: unknown;
        try {
          value = JSON.parse(message.data);
        } catch {
          return;
        }
        const event = ServerEventSchema.safeParse(value);
        if (event.success) dispatch(event.data);
      };
      socket.onclose = () => {
        dispatch({ type: 'socket', connected: false });
        if (alive) retry = setTimeout(open, 1_500);
      };
    };
    open();

    return () => {
      alive = false;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [serial]);

  return { ...state, dismissNotice: () => dispatch({ type: 'dismiss' }) };
}
