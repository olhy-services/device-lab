import { Droplets, ExternalLink } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import { type DeviceSettings, OpenUrlSchema, type SettingsPatch } from '../../../shared/schema';
import { api } from '../../api';

const FONT_SCALES = [0.85, 1, 1.15, 1.3, 1.5, 2] as const;

interface ToolsProps {
  serial: string;
  onError(message: string): void;
  onInfo(message: string): void;
}

export function Tools({ serial, onError, onInfo }: ToolsProps) {
  const [settings, setSettings] = useState<DeviceSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [url, setUrl] = useState('');
  const [ejecting, setEjecting] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .settings(serial)
      .then((s) => alive && setSettings(s))
      .catch((e: unknown) => alive && onError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [serial, onError]);

  async function patch(change: SettingsPatch) {
    setSaving(true);
    try {
      setSettings(await api.patchSettings(serial, change));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function open(event: FormEvent) {
    event.preventDefault();
    const parsed = OpenUrlSchema.safeParse({ url });
    if (!parsed.success) {
      onError(parsed.error.issues[0]?.message ?? 'Link inválido');
      return;
    }
    try {
      onInfo((await api.openUrl(serial, parsed.data.url)).message ?? 'Link aberto.');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function ejectWater() {
    setEjecting(true);
    try {
      onInfo((await api.ejectWater(serial)).message ?? 'Tocando o som.');
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setEjecting(false);
    }
  }

  return (
    <div className="tab-body">
      <section aria-labelledby="link-title" className="stack">
        <h3 id="link-title" className="tab-subtitle">
          Abrir link ou deep link
        </h3>
        <form className="row" onSubmit={(e) => void open(e)}>
          <input
            className="input grow mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="meuapp://pedido/123 ou https://…"
            aria-label="Link para abrir no aparelho"
            inputMode="url"
            spellCheck={false}
          />
          <button type="submit" className="btn" disabled={url.trim().length < 3}>
            <ExternalLink size={14} aria-hidden="true" /> Abrir
          </button>
        </form>
        <p className="hint">Dispara um intent VIEW: testa intent-filters, App Links e rotas do app.</p>
      </section>

      <section aria-labelledby="water-title" className="stack">
        <div className="section-head">
          <h3 id="water-title" className="tab-subtitle">
            Tirar água do alto-falante
          </h3>
          <button type="button" className="btn sm" disabled={ejecting} onClick={() => void ejectWater()}>
            <Droplets size={14} aria-hidden="true" /> {ejecting ? 'Preparando…' : 'Tocar som de 165 Hz'}
          </button>
        </div>
        <p className="hint">
          Toca um tom grave de 30 s no volume máximo: a vibração do alto-falante empurra gotas para fora da grade. Deixe o
          alto-falante virado para baixo. Só ajuda no alto-falante; não seca o aparelho por dentro (se molhou, desligue e
          deixe secar).
        </p>
      </section>

      <section aria-labelledby="display-title" className="stack">
        <h3 id="display-title" className="tab-subtitle">
          Tela e acessibilidade
        </h3>
        {!settings ? (
          <p className="empty">Lendo as configurações…</p>
        ) : (
          <div className="settings" aria-busy={saving}>
            <Toggle
              label="Tema escuro"
              hint={settings.darkMode === null ? 'Hoje: automático' : undefined}
              checked={settings.darkMode === true}
              disabled={saving}
              onChange={(darkMode) => void patch({ darkMode })}
            />
            <div className="setting">
              <span>
                Tamanho da fonte
                <small className="muted num"> atual {settings.fontScale.toLocaleString('pt-BR')}×</small>
              </span>
              <div className="segmented" role="group" aria-label="Tamanho da fonte">
                {FONT_SCALES.map((scale) => (
                  <button
                    key={scale}
                    type="button"
                    aria-pressed={Math.abs(settings.fontScale - scale) < 0.01}
                    disabled={saving}
                    onClick={() => void patch({ fontScale: scale })}
                    className="num"
                  >
                    {scale.toLocaleString('pt-BR')}×
                  </button>
                ))}
              </div>
            </div>
            <Toggle
              label="Mostrar toques"
              hint="Bolinha onde o dedo toca (bom para gravar vídeos)"
              checked={settings.showTouches}
              disabled={saving}
              onChange={(showTouches) => void patch({ showTouches })}
            />
            <Toggle
              label="Mostrar limites de layout"
              hint="Margens e bordas de cada view"
              checked={settings.layoutBounds}
              disabled={saving}
              onChange={(layoutBounds) => void patch({ layoutBounds })}
            />
            <Toggle
              label="Girar automaticamente"
              checked={settings.autoRotate}
              disabled={saving}
              onChange={(autoRotate) => void patch({ autoRotate })}
            />
            <Toggle
              label="Tela sempre ligada no carregador"
              checked={settings.stayAwake}
              disabled={saving}
              onChange={(stayAwake) => void patch({ stayAwake })}
            />
            {settings.locale && (
              <p className="hint">
                Idioma do aparelho: <span className="mono">{settings.locale}</span>
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

interface ToggleProps {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  disabled: boolean;
  onChange(value: boolean): void;
}

function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps) {
  return (
    <label className="setting">
      <span>
        {label}
        {hint && <small className="muted"> {hint}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
