import { rm } from 'node:fs/promises';

import type { App, AppAction, DeviceInfo, DeviceSettings, SettingsPatch, Storage } from '../shared/schema';
import { adb, adbBuffer, PACKAGE_RE, parseSections, quote, sectionsCommand, shell } from './adb';
import { parseDiskstats, parseDiskstatsPackages, parseMeminfo, parsePackageList, parseWm } from './parse';

// ---------------------------------------------------------------------------
// Informações

export async function deviceInfo(serial: string): Promise<DeviceInfo> {
  const out = parseSections(
    await shell(
      serial,
      sectionsCommand({
        manufacturer: 'getprop ro.product.manufacturer',
        model: 'getprop ro.product.model',
        device: 'getprop ro.product.device',
        android: 'getprop ro.build.version.release',
        sdk: 'getprop ro.build.version.sdk',
        abi: 'getprop ro.product.cpu.abi',
        build: 'getprop ro.build.display.id',
        patch: 'getprop ro.build.version.security_patch',
        size: 'wm size',
        density: 'wm density',
        cores: 'grep -c ^processor /proc/cpuinfo',
        mem: 'grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
        ip: 'ip -f inet addr show wlan0',
        uptime: 'cat /proc/uptime',
      }),
      8_000,
    ),
  );
  const get = (key: string) => out.get(key) ?? '';
  return {
    serial,
    manufacturer: get('manufacturer'),
    model: get('model'),
    device: get('device'),
    android: get('android'),
    sdk: Number.parseInt(get('sdk'), 10) || 0,
    abi: get('abi'),
    build: get('build'),
    securityPatch: get('patch'),
    screen: parseWm(get('size'), get('density')),
    cpuCores: Number.parseInt(get('cores'), 10) || 0,
    memTotalKb: parseMeminfo(get('mem'))?.totalKb ?? 0,
    ip: /inet (\d+\.\d+\.\d+\.\d+)/.exec(get('ip'))?.[1] ?? null,
    uptimeSec: Number.parseFloat(get('uptime').split(/\s+/)[0] ?? '') || 0,
  };
}

// ---------------------------------------------------------------------------
// Apps

export async function listApps(serial: string): Promise<App[]> {
  const out = parseSections(
    await shell(
      serial,
      sectionsCommand({
        user: 'pm list packages -3 --show-versioncode',
        system: 'pm list packages -s --show-versioncode',
        disk: 'dumpsys diskstats',
      }),
      20_000,
    ),
  );
  const sizes = parseDiskstatsPackages(out.get('disk') ?? '');
  const toApp = (system: boolean) => (p: { pkg: string; versionCode: number | null }): App => {
    const size = sizes.get(p.pkg);
    return {
      pkg: p.pkg,
      versionCode: p.versionCode,
      system,
      sizeBytes: size?.app ?? null,
      dataBytes: size?.data ?? null,
      cacheBytes: size?.cache ?? null,
    };
  };
  return [
    ...parsePackageList(out.get('user') ?? '').map(toApp(false)),
    ...parsePackageList(out.get('system') ?? '').map(toApp(true)),
  ].sort((a, b) => Number(a.system) - Number(b.system) || a.pkg.localeCompare(b.pkg));
}

export async function appAction(serial: string, pkg: string, action: AppAction): Promise<string> {
  if (!PACKAGE_RE.test(pkg)) throw new Error('Nome de pacote inválido');
  switch (action) {
    case 'launch': {
      const out = await shell(serial, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, 15_000);
      if (/No activities found/i.test(out)) throw new Error('Este app não tem tela de abertura.');
      return `${pkg} aberto.`;
    }
    case 'force-stop':
      await shell(serial, `am force-stop ${pkg}`);
      return `${pkg} encerrado.`;
    case 'clear-data': {
      const out = await shell(serial, `pm clear ${pkg}`, 20_000);
      if (!/Success/i.test(out)) throw new Error(`Não apagou os dados: ${out.trim()}`);
      return `Dados de ${pkg} apagados.`;
    }
    case 'uninstall': {
      const out = await shell(serial, `pm uninstall ${pkg}`, 30_000);
      if (!/Success/i.test(out)) throw new Error(`Não desinstalou: ${out.trim() || 'sem resposta'}`);
      return `${pkg} desinstalado.`;
    }
  }
}

export async function installApk(serial: string, file: string): Promise<string> {
  try {
    const { stdout } = await adb(serial, ['install', '-r', '-t', file], 180_000);
    if (!/Success/i.test(stdout)) throw new Error(stdout.trim());
    return 'App instalado.';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /INSTALL_FAILED_[A-Z_]+/.exec(message)?.[0];
    throw new Error(reason ? `Instalação recusada: ${reason}` : `Instalação falhou: ${message}`, { cause: error });
  } finally {
    await rm(file, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Armazenamento

export async function storage(serial: string): Promise<Storage> {
  return parseDiskstats(await shell(serial, 'dumpsys diskstats', 20_000));
}

// ---------------------------------------------------------------------------
// Ferramentas rápidas

export async function readSettings(serial: string): Promise<DeviceSettings> {
  const out = parseSections(
    await shell(
      serial,
      sectionsCommand({
        night: 'cmd uimode night',
        font: 'settings get system font_scale',
        touches: 'settings get system show_touches',
        layout: 'getprop debug.layout',
        rotate: 'settings get system accelerometer_rotation',
        awake: 'settings get global stay_on_while_plugged_in',
        locale: 'getprop persist.sys.locale',
      }),
      8_000,
    ),
  );
  const night = /Night mode:\s*(\w+)/.exec(out.get('night') ?? '')?.[1];
  return {
    darkMode: night === 'yes' ? true : night === 'no' ? false : null,
    fontScale: Number.parseFloat(out.get('font') ?? '') || 1,
    showTouches: out.get('touches') === '1',
    layoutBounds: out.get('layout') === 'true',
    autoRotate: out.get('rotate') === '1',
    stayAwake: (Number.parseInt(out.get('awake') ?? '', 10) || 0) > 0,
    locale: out.get('locale') || '',
  };
}

export async function patchSettings(serial: string, patch: SettingsPatch): Promise<DeviceSettings> {
  const commands: string[] = [];
  if (patch.darkMode !== undefined) commands.push(`cmd uimode night ${patch.darkMode ? 'yes' : 'no'}`);
  if (patch.fontScale !== undefined) commands.push(`settings put system font_scale ${patch.fontScale.toFixed(2)}`);
  if (patch.showTouches !== undefined) commands.push(`settings put system show_touches ${patch.showTouches ? 1 : 0}`);
  if (patch.autoRotate !== undefined) {
    commands.push(`settings put system accelerometer_rotation ${patch.autoRotate ? 1 : 0}`);
  }
  if (patch.stayAwake !== undefined) {
    // 7 = carregando por AC, USB ou sem fio.
    commands.push(`settings put global stay_on_while_plugged_in ${patch.stayAwake ? 7 : 0}`);
  }
  if (patch.layoutBounds !== undefined) {
    // O "service call" avisa os apps para relerem as propriedades (SYSPROPS_TRANSACTION).
    commands.push(`setprop debug.layout ${patch.layoutBounds}`, 'service call activity 1599295570 > /dev/null');
  }
  if (commands.length > 0) await shell(serial, commands.join('; '), 10_000);
  return readSettings(serial);
}

export async function screenshot(serial: string): Promise<Buffer> {
  return adbBuffer(serial, ['exec-out', 'screencap', '-p'], 20_000);
}

export async function openUrl(serial: string, url: string): Promise<string> {
  const out = await shell(serial, `am start -a android.intent.action.VIEW -d ${quote(url)}`, 10_000);
  if (/Error|unable to resolve/i.test(out)) {
    throw new Error('Nenhum app do aparelho abre esse link. Confira o esquema (ex.: meuapp://) e o intent-filter.');
  }
  return 'Link aberto no aparelho.';
}
