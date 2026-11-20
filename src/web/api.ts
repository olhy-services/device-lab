import type { ZodType } from 'zod';

import {
  ApiErrorSchema,
  type AppAction,
  AppListSchema,
  DeviceInfoSchema,
  DeviceListSchema,
  DeviceSettingsSchema,
  DirListingSchema,
  FileAccessInfoSchema,
  FilePreviewSchema,
  MessageSchema,
  OkSchema,
  ProcessListSchema,
  ProxyStatusSchema,
  type SettingsPatch,
  SocketListSchema,
  StorageSchema,
  WifiDiscoverSchema,
} from '../shared/schema';

async function readError(response: Response): Promise<Error> {
  const data: unknown = await response.json().catch(() => null);
  const parsed = ApiErrorSchema.safeParse(data);
  return new Error(parsed.success ? parsed.data.error : `Erro HTTP ${response.status}`);
}

async function request<T>(schema: ZodType<T>, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw await readError(response);
  const data: unknown = await response.json();
  return schema.parse(data);
}

function fileParams(path: string, as: string): string {
  const params = new URLSearchParams({ path });
  if (as) params.set('as', as);
  return params.toString();
}

export const devicePath = (serial: string, rest = '') => `/api/devices/${encodeURIComponent(serial)}${rest}`;

export const api = {
  devices: () => request(DeviceListSchema, 'GET', '/api/devices'),
  info: (serial: string) => request(DeviceInfoSchema, 'GET', devicePath(serial, '/info')),
  storage: (serial: string) => request(StorageSchema, 'GET', devicePath(serial, '/storage')),
  apps: (serial: string) => request(AppListSchema, 'GET', devicePath(serial, '/apps')),
  appAction: (serial: string, pkg: string, action: AppAction) =>
    request(OkSchema, 'POST', devicePath(serial, `/apps/${encodeURIComponent(pkg)}/${action}`)),
  async install(serial: string, file: File) {
    const response = await fetch(devicePath(serial, '/install'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.android.package-archive' },
      body: file,
    });
    if (!response.ok) throw await readError(response);
    const data: unknown = await response.json();
    return OkSchema.parse(data);
  },
  settings: (serial: string) => request(DeviceSettingsSchema, 'GET', devicePath(serial, '/settings')),
  patchSettings: (serial: string, patch: SettingsPatch) =>
    request(DeviceSettingsSchema, 'POST', devicePath(serial, '/settings'), patch),
  openUrl: (serial: string, url: string) => request(OkSchema, 'POST', devicePath(serial, '/open-url'), { url }),
  async screenshot(serial: string): Promise<Blob> {
    const response = await fetch(devicePath(serial, '/screenshot'));
    if (!response.ok) throw await readError(response);
    return response.blob();
  },
  proxyStart: (serial: string) => request(ProxyStatusSchema, 'POST', devicePath(serial, '/proxy/start')),
  proxyStop: (serial: string) => request(ProxyStatusSchema, 'POST', devicePath(serial, '/proxy/stop')),
  clearHttp: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/http/clear')),
  clearLogs: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/logs/clear')),

  processes: (serial: string) => request(ProcessListSchema, 'GET', devicePath(serial, '/processes')),
  kill: (serial: string, pid: number, name: string) =>
    request(OkSchema, 'POST', devicePath(serial, '/processes/kill'), { pid, name }),
  freeMemory: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/memory/free')),
  coolDown: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/care/cool')),
  undoCoolDown: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/care/cool/undo')),
  ejectWater: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/care/eject-water')),
  sockets: (serial: string) => request(SocketListSchema, 'GET', devicePath(serial, '/sockets')),

  fileAccess: (serial: string) => request(FileAccessInfoSchema, 'GET', devicePath(serial, '/files/access')),
  listDir: (serial: string, path: string, as: string) =>
    request(DirListingSchema, 'GET', devicePath(serial, `/files?${fileParams(path, as)}`)),
  preview: (serial: string, path: string, as: string) =>
    request(FilePreviewSchema, 'GET', devicePath(serial, `/files/preview?${fileParams(path, as)}`)),
  downloadUrl: (serial: string, path: string, as: string) => devicePath(serial, `/files/download?${fileParams(path, as)}`),
  deletePath: (serial: string, path: string, as: string) =>
    request(OkSchema, 'POST', devicePath(serial, '/files/delete'), { path, as }),
  async upload(serial: string, dir: string, file: File) {
    const response = await fetch(devicePath(serial, `/files/upload?dir=${encodeURIComponent(dir)}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });
    if (!response.ok) throw await readError(response);
    const data: unknown = await response.json();
    return OkSchema.parse(data);
  },

  wifiDiscover: () => request(WifiDiscoverSchema, 'GET', '/api/wifi/discover'),
  wifiPair: (host: string, port: number, code: string) =>
    request(MessageSchema, 'POST', '/api/wifi/pair', { host, port, code }),
  wifiConnect: (host: string, port: number) => request(MessageSchema, 'POST', '/api/wifi/connect', { host, port }),
  switchToWifi: (serial: string) => request(MessageSchema, 'POST', devicePath(serial, '/wifi')),
  disconnect: (serial: string) => request(OkSchema, 'POST', devicePath(serial, '/disconnect')),
};

/** Baixa um Blob com o nome dado (screenshot, gravação). */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
