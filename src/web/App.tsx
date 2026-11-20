import { Unplug, Wifi, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Device, DeviceList } from '../shared/schema';
import { api } from './api';
import { DeviceControls } from './components/DeviceControls';
import { DevTools } from './components/DevTools';
import { Screen } from './components/Screen';
import { WifiConnect } from './components/WifiConnect';
import { useDeviceEvents } from './useDeviceEvents';
import { useMirror } from './useMirror';

const SELECTED_KEY = 'device-lab:serial';

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sem armazenamento (aba privada): só não lembra a escolha.
  }
}

interface Toast {
  id: number;
  tone: 'error' | 'info';
  text: string;
}

const CONNECTION_LABEL: Record<Device['connection'], string> = { usb: 'USB', wifi: 'Wi-Fi', emulator: 'emulador' };

export function App() {
  const [list, setList] = useState<DeviceList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => readStored(SELECTED_KEY));
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const refresh = useCallback(() => {
    api
      .devices()
      .then((data) => {
        setList(data);
        setListError(null);
      })
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const notify = useCallback((tone: Toast['tone'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((all) => [...all.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), tone === 'error' ? 9_000 : 4_000);
  }, []);
  const onError = useCallback((text: string) => notify('error', text), [notify]);
  const onInfo = useCallback((text: string) => notify('info', text), [notify]);

  const devices = list?.devices ?? [];
  // O escolhido saiu da lista: cai para o primeiro pronto.
  const device =
    devices.find((d) => d.serial === chosen) ?? devices.find((d) => d.unavailableReason === null) ?? devices[0] ?? null;

  function choose(serial: string) {
    setChosen(serial);
    writeStored(SELECTED_KEY, serial);
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">device-lab</h1>
        {devices.length > 0 && device && (
          <label className="device-select">
            <span className="sr-only">Aparelho</span>
            <select className="select" value={device.serial} onChange={(e) => choose(e.target.value)}>
              {devices.map((d) => (
                <option key={d.serial} value={d.serial}>
                  {d.model} · {CONNECTION_LABEL[d.connection]}
                  {d.unavailableReason ? ' (indisponível)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {device && <DeviceStatus device={device} onInfo={onInfo} onError={onError} onChanged={refresh} />}
        <details className="popover">
          <summary className="btn sm ghost">
            <Wifi size={14} aria-hidden="true" /> Conectar
          </summary>
          <div className="popover-body">
            <WifiConnect defaultOpen onConnected={refresh} />
          </div>
        </details>
      </header>

      {device && device.unavailableReason === null ? (
        <Workspace key={device.serial} device={device} onError={onError} onInfo={onInfo} />
      ) : (
        <Empty list={list} listError={listError} device={device} onConnected={refresh} />
      )}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span>{t.text}</span>
            <button
              type="button"
              className="btn icon sm ghost"
              aria-label="Fechar aviso"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Workspace({ device, onError, onInfo }: { device: Device; onError(m: string): void; onInfo(m: string): void }) {
  const mirror = useMirror(device.serial);
  const live = useDeviceEvents(device.serial);

  return (
    <main className="workspace">
      <section className="phone-pane" aria-label="Tela do aparelho">
        <div className="phone">
          <Screen mirror={mirror} label={device.model} />
          <DeviceControls serial={device.serial} mirror={mirror} onError={onError} />
        </div>
        {mirror.deviceClipboard !== null && (
          <p className="hint clip" title={mirror.deviceClipboard}>
            Copiado no aparelho: <span className="mono">{mirror.deviceClipboard.slice(0, 80)}</span>
          </p>
        )}
      </section>
      {live.notice && (
        <div className="notice-bar" role="alert">
          <span>{live.notice}</span>
          <button type="button" className="btn icon sm ghost" aria-label="Fechar aviso" onClick={live.dismissNotice}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <DevTools serial={device.serial} live={live} onError={onError} onInfo={onInfo} />
    </main>
  );
}

interface DeviceStatusProps {
  device: Device;
  onInfo(message: string): void;
  onError(message: string): void;
  onChanged(): void;
}

function DeviceStatus({ device, onInfo, onError, onChanged }: DeviceStatusProps) {
  const [busy, setBusy] = useState(false);

  async function act(task: () => Promise<{ message?: string | undefined }>) {
    setBusy(true);
    try {
      const result = await task();
      if (result.message) onInfo(result.message);
      onChanged();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="device-status">
      <span className={device.unavailableReason ? 'dot warn' : 'dot ok'} aria-hidden="true" />
      <span className="mono muted">{device.serial}</span>
      {device.connection === 'usb' && device.unavailableReason === null && (
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          title="Ativa o adb pela rede e conecta pelo IP do celular; depois dá para tirar o cabo"
          onClick={() => void act(() => api.switchToWifi(device.serial))}
        >
          <Wifi size={14} aria-hidden="true" /> {busy ? 'Passando…' : 'Passar para Wi-Fi'}
        </button>
      )}
      {device.connection === 'wifi' && device.unavailableReason !== null && (
        <button
          type="button"
          className="btn sm ghost"
          disabled={busy}
          title="Remove a conexão travada do adb"
          onClick={() => void act(() => api.disconnect(device.serial))}
        >
          <Unplug size={14} aria-hidden="true" /> Desconectar
        </button>
      )}
    </div>
  );
}

interface EmptyProps {
  list: DeviceList | null;
  listError: string | null;
  device: Device | null;
  onConnected(): void;
}

function Empty({ list, listError, device, onConnected }: EmptyProps) {
  return (
    <main className="empty-state">
      <div className="empty-card">
        {listError ? (
          <>
            <h2>Servidor do device-lab fora do ar</h2>
            <p className="error">{listError}</p>
          </>
        ) : !list ? (
          <p className="hint">Procurando aparelhos…</p>
        ) : !list.adb ? (
          <>
            <h2>adb não encontrado</h2>
            <p>
              Instale o Android SDK platform-tools ou aponte o caminho em <span className="mono">DEVICE_LAB_ADB</span> e
              reinicie o device-lab.
            </p>
          </>
        ) : device ? (
          <>
            <h2>{device.model} não está pronto</h2>
            <p className="error">{device.unavailableReason}</p>
            {device.connection === 'wifi' && (
              <p className="hint">
                Pelo Wi-Fi: confira se o celular está desbloqueado e na mesma rede. Se a conexão travou, use{' '}
                <b>Desconectar</b> no topo e conecte de novo, ou ligue o cabo USB.
              </p>
            )}
            <p className="hint">A lista atualiza sozinha a cada 3 s.</p>
          </>
        ) : (
          <>
            <h2>Conecte um Android</h2>
            <ol className="steps">
              <li>No aparelho: Configurações › Sobre › toque 7 vezes em “Número da versão”.</li>
              <li>Em Opções do desenvolvedor, ligue a Depuração USB e conecte o cabo.</li>
              <li>Aceite “Permitir depuração USB” na tela do aparelho.</li>
            </ol>
            <p className="hint">Ou sem cabo, pela rede:</p>
            <WifiConnect defaultOpen={false} onConnected={onConnected} />
          </>
        )}
      </div>
    </main>
  );
}
