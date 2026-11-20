import { type KeyboardEvent, useState } from 'react';
import { z } from 'zod';

import type { DeviceLive } from '../useDeviceEvents';
import { Apps } from './tabs/Apps';
import { Files } from './tabs/Files';
import { Logcat } from './tabs/Logcat';
import { Network } from './tabs/Network';
import { Overview } from './tabs/Overview';
import { Performance } from './tabs/Performance';
import { Processes } from './tabs/Processes';
import { StorageTab } from './tabs/StorageTab';
import { Tools } from './tabs/Tools';

const TabSchema = z.enum(['overview', 'performance', 'processes', 'network', 'logcat', 'apps', 'files', 'storage', 'tools']);
type Tab = z.infer<typeof TabSchema>;

const TAB_LABEL: Record<Tab, string> = {
  overview: 'Visão geral',
  performance: 'Desempenho',
  processes: 'Processos',
  network: 'Rede',
  logcat: 'Logcat',
  apps: 'Apps',
  files: 'Arquivos',
  storage: 'Armazenamento',
  tools: 'Ferramentas',
};
const TAB_KEY = 'device-lab:tab';

function storedTab(): Tab {
  try {
    const parsed = TabSchema.safeParse(localStorage.getItem(TAB_KEY));
    return parsed.success ? parsed.data : 'overview';
  } catch {
    return 'overview';
  }
}

interface DevToolsProps {
  serial: string;
  live: DeviceLive;
  onError(message: string): void;
  onInfo(message: string): void;
}

export function DevTools({ serial, live, onError, onInfo }: DevToolsProps) {
  const [tab, setTab] = useState<Tab>(storedTab);
  const last = live.metrics.at(-1);

  function select(next: Tab) {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      // Sem armazenamento: só não lembra a aba.
    }
  }

  // Setas trocam de aba (padrão de tablist).
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = TabSchema.options;
    const index = tabs.indexOf(tab);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    if (next) {
      select(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  }

  return (
    <section className="devtools" aria-label="DevTools">
      <div className="tabs" role="tablist" aria-label="Ferramentas" onKeyDown={onKeyDown}>
        {TabSchema.options.map((t) => (
          <button
            key={t}
            id={`tab-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls="devtools-panel"
            tabIndex={tab === t ? 0 : -1}
            onClick={() => select(t)}
          >
            {TAB_LABEL[t]}
            {t === 'network' && live.proxy?.capturing && <span className="tab-dot" aria-label="(capturando)" />}
          </button>
        ))}
        <span className="tabs-status" aria-live="polite">
          {!live.connected && 'reconectando…'}
        </span>
      </div>
      <div id="devtools-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'overview' && <Overview serial={serial} metrics={live.metrics} onError={onError} onInfo={onInfo} />}
        {tab === 'performance' && <Performance metrics={live.metrics} />}
        {tab === 'processes' && <Processes serial={serial} onError={onError} onInfo={onInfo} />}
        {tab === 'network' && (
          <Network
            serial={serial}
            metrics={live.metrics}
            http={live.http}
            proxy={live.proxy}
            tlsFailures={live.tlsFailures}
            onError={onError}
          />
        )}
        {tab === 'logcat' && <Logcat serial={serial} logs={live.logs} last={last} onError={onError} />}
        {tab === 'apps' && (
          <Apps serial={serial} foregroundPkg={last?.foreground?.pkg ?? null} onError={onError} onInfo={onInfo} />
        )}
        {tab === 'files' && <Files serial={serial} onError={onError} onInfo={onInfo} />}
        {tab === 'storage' && <StorageTab serial={serial} onError={onError} />}
        {tab === 'tools' && <Tools serial={serial} onError={onError} onInfo={onInfo} />}
      </div>
    </section>
  );
}
