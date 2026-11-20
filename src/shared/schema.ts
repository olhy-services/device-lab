import { z } from 'zod';

/**
 * Contratos entre o servidor local (adb/scrcpy/proxy) e a interface web.
 * Tudo que atravessa HTTP/WebSocket é validado com estes schemas.
 */

export const SerialSchema = z.string().regex(/^[\w.:-]{1,160}$/);

// ---------------------------------------------------------------------------
// Aparelhos

export const ConnectionSchema = z.enum(['usb', 'wifi', 'emulator']);
export type Connection = z.infer<typeof ConnectionSchema>;

export const DeviceSchema = z.object({
  serial: z.string(),
  model: z.string(),
  connection: ConnectionSchema,
  /** null = pronto; texto = motivo de não estar. */
  unavailableReason: z.string().nullable(),
});
export type Device = z.infer<typeof DeviceSchema>;

export const DeviceListSchema = z.object({ devices: z.array(DeviceSchema), adb: z.boolean() });
export type DeviceList = z.infer<typeof DeviceListSchema>;

export const DeviceInfoSchema = z.object({
  serial: z.string(),
  manufacturer: z.string(),
  model: z.string(),
  device: z.string(),
  android: z.string(),
  sdk: z.number().int(),
  abi: z.string(),
  build: z.string(),
  securityPatch: z.string(),
  screen: z.object({ width: z.number().int(), height: z.number().int(), density: z.number().int() }),
  cpuCores: z.number().int(),
  memTotalKb: z.number(),
  ip: z.string().nullable(),
  uptimeSec: z.number(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

// ---------------------------------------------------------------------------
// Métricas ao vivo (1 amostra por segundo)

export const ForegroundSchema = z.object({
  pkg: z.string(),
  activity: z.string(),
  pid: z.number().int().nullable(),
});
export type Foreground = z.infer<typeof ForegroundSchema>;

export const CoreSampleSchema = z.object({
  /** % de uso deste núcleo no último segundo. */
  pct: z.number().nullable(),
  freqMhz: z.number().nullable(),
  maxMhz: z.number().nullable(),
});
export type CoreSample = z.infer<typeof CoreSampleSchema>;

export const TemperatureSchema = z.object({ name: z.string(), c: z.number() });

export const MetricsSampleSchema = z.object({
  t: z.number(),
  cpuPct: z.number().nullable(),
  cores: z.array(CoreSampleSchema),
  memUsedKb: z.number(),
  memTotalKb: z.number(),
  memAvailableKb: z.number(),
  /** Memória virtual (swap/zram), o "RAM Boost" de vários fabricantes. */
  swapTotalKb: z.number(),
  swapUsedKb: z.number(),
  /** Sensores de temperatura do sistema (CPU, GPU, bateria, superfície…). */
  temps: z.array(TemperatureSchema),
  netRxBps: z.number().nullable(),
  netTxBps: z.number().nullable(),
  foreground: ForegroundSchema.nullable(),
  app: z
    .object({
      pkg: z.string(),
      cpuPct: z.number().nullable(),
      rssKb: z.number().nullable(),
      fps: z.number().nullable(),
      /** % de quadros lentos desde a última amostra. */
      jankPct: z.number().nullable(),
      p90FrameMs: z.number().nullable(),
    })
    .nullable(),
  battery: z
    .object({
      level: z.number(),
      tempC: z.number(),
      charging: z.boolean(),
      voltageMv: z.number(),
      /** Corrente instantânea em mA (sinal depende do fabricante; mostrado sem sinal). */
      currentMa: z.number().nullable(),
      health: z.string().nullable(),
      source: z.string().nullable(),
      technology: z.string().nullable(),
    })
    .nullable(),
});
export type MetricsSample = z.infer<typeof MetricsSampleSchema>;

// ---------------------------------------------------------------------------
// Logcat

export const LogLevelSchema = z.enum(['V', 'D', 'I', 'W', 'E', 'F']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogLineSchema = z.object({
  id: z.number().int(),
  time: z.string(),
  pid: z.number().int(),
  tid: z.number().int(),
  level: LogLevelSchema,
  tag: z.string(),
  message: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

// ---------------------------------------------------------------------------
// Requisições (proxy)

export const HttpExchangeSchema = z.object({
  id: z.string(),
  method: z.string(),
  url: z.string(),
  host: z.string(),
  path: z.string(),
  startedAt: z.number(),
  status: z.number().int().nullable(),
  durationMs: z.number().nullable(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()).nullable(),
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
  /** true quando o corpo foi cortado ou é binário. */
  bodyTruncated: z.boolean(),
  mime: z.string().nullable(),
  responseBytes: z.number().nullable(),
  error: z.string().nullable(),
});
export type HttpExchange = z.infer<typeof HttpExchangeSchema>;

export const TlsFailureSchema = z.object({ host: z.string(), at: z.number(), reason: z.string() });
export type TlsFailure = z.infer<typeof TlsFailureSchema>;

export const ProxyStatusSchema = z.object({
  capturing: z.boolean(),
  port: z.number().int().nullable(),
  caPath: z.string(),
  /** Caminho do certificado no aparelho (para instalar pelas Configurações). */
  caOnDevice: z.string().nullable(),
});
export type ProxyStatus = z.infer<typeof ProxyStatusSchema>;

// ---------------------------------------------------------------------------
// Eventos do canal /ws/events (servidor → navegador)

export const ServerEventSchema = z.discriminatedUnion('type', [
  /** Estado atual para quem acabou de abrir a aba. */
  z.object({
    type: z.literal('snapshot'),
    metrics: z.array(MetricsSampleSchema),
    logs: z.array(LogLineSchema),
    http: z.array(HttpExchangeSchema),
    proxy: ProxyStatusSchema,
  }),
  z.object({ type: z.literal('metrics'), sample: MetricsSampleSchema }),
  z.object({ type: z.literal('logs-cleared') }),
  z.object({ type: z.literal('http-cleared') }),
  z.object({ type: z.literal('logs'), lines: z.array(LogLineSchema) }),
  z.object({ type: z.literal('http'), exchange: HttpExchangeSchema }),
  z.object({ type: z.literal('tls-failure'), failure: TlsFailureSchema }),
  z.object({ type: z.literal('proxy'), status: ProxyStatusSchema }),
  z.object({ type: z.literal('device-error'), message: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

// ---------------------------------------------------------------------------
// Espelhamento: mensagens de controle (navegador → servidor, JSON no /ws/screen)

export const DeviceButtonSchema = z.enum([
  'back',
  'home',
  'recents',
  'power',
  'volume-up',
  'volume-down',
  'notifications',
  'quick-settings',
  'rotate',
]);
export type DeviceButton = z.infer<typeof DeviceButtonSchema>;

const Coord = z.number().finite();

export const ControlMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('touch'),
    action: z.enum(['down', 'move', 'up', 'cancel']),
    pointerId: z.number().int().min(-4).max(64),
    x: Coord,
    y: Coord,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pressure: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('scroll'),
    x: Coord,
    y: Coord,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    dx: z.number().min(-16).max(16),
    dy: z.number().min(-16).max(16),
  }),
  z.object({
    type: z.literal('key'),
    action: z.enum(['down', 'up']),
    /** `KeyboardEvent.code` do navegador (o scrcpy usa os mesmos nomes). */
    code: z.string().regex(/^\w{1,32}$/),
    meta: z.enum(['none', 'shift', 'ctrl', 'alt']),
  }),
  z.object({ type: z.literal('text'), text: z.string().min(1).max(5000) }),
  z.object({ type: z.literal('paste'), text: z.string().max(100_000) }),
  z.object({ type: z.literal('button'), button: DeviceButtonSchema }),
  z.object({ type: z.literal('keyframe') }),
]);
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/** Mensagens JSON do servidor no /ws/screen (o vídeo vai em frames binários). */
export const ScreenEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), codec: z.number().int(), width: z.number().int(), height: z.number().int() }),
  z.object({ type: z.literal('size'), width: z.number().int(), height: z.number().int() }),
  z.object({ type: z.literal('clipboard'), text: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('closed'), message: z.string() }),
]);
export type ScreenEvent = z.infer<typeof ScreenEventSchema>;

/** Cabeçalho binário de cada pacote de vídeo: [tipo:u8][flags:u8][pts:i64] + dados. */
export const VIDEO_HEADER_BYTES = 10;
export const VIDEO_PACKET_CONFIG = 0;
export const VIDEO_PACKET_DATA = 1;
export const VIDEO_FLAG_KEYFRAME = 1;
export const VIDEO_FLAG_HAS_PTS = 2;

// ---------------------------------------------------------------------------
// Apps e armazenamento

export const AppSchema = z.object({
  pkg: z.string(),
  versionCode: z.number().int().nullable(),
  system: z.boolean(),
  sizeBytes: z.number().nullable(),
  dataBytes: z.number().nullable(),
  cacheBytes: z.number().nullable(),
});
export type App = z.infer<typeof AppSchema>;
export const AppListSchema = z.object({ apps: z.array(AppSchema) });

export const AppActionSchema = z.enum(['launch', 'force-stop', 'clear-data', 'uninstall']);
export type AppAction = z.infer<typeof AppActionSchema>;

export const StorageSchema = z.object({
  totalBytes: z.number(),
  freeBytes: z.number(),
  /** Quanto cada tipo de conteúdo ocupa (do `dumpsys diskstats`, calculado pelo sistema). */
  breakdown: z.array(z.object({ key: z.string(), label: z.string(), bytes: z.number() })),
});
export type Storage = z.infer<typeof StorageSchema>;

// ---------------------------------------------------------------------------
// Ferramentas rápidas

export const DeviceSettingsSchema = z.object({
  darkMode: z.boolean().nullable(),
  fontScale: z.number(),
  showTouches: z.boolean(),
  layoutBounds: z.boolean(),
  autoRotate: z.boolean(),
  stayAwake: z.boolean(),
  locale: z.string(),
});
export type DeviceSettings = z.infer<typeof DeviceSettingsSchema>;

export const SettingsPatchSchema = z.object({
  darkMode: z.boolean().optional(),
  fontScale: z.number().min(0.85).max(2).optional(),
  showTouches: z.boolean().optional(),
  layoutBounds: z.boolean().optional(),
  autoRotate: z.boolean().optional(),
  stayAwake: z.boolean().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

export const OpenUrlSchema = z.object({
  url: z
    .string()
    .trim()
    .min(3)
    .max(2000)
    .regex(/^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/, 'Use um link completo, ex.: https://… ou meuapp://tela'),
});

export const ApiErrorSchema = z.object({ error: z.string() });
export const OkSchema = z.object({ ok: z.literal(true), message: z.string().optional() });

// ---------------------------------------------------------------------------
// Conexão pelo Wi-Fi

const HostSchema = z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/, 'IP ou nome inválido');
const PortSchema = z.number().int().min(1).max(65_535);

export const WifiPairRequestSchema = z.object({
  host: HostSchema,
  port: PortSchema,
  code: z.string().regex(/^\d{6}$/, 'O código tem 6 dígitos'),
});
export const WifiConnectRequestSchema = z.object({ host: HostSchema, port: PortSchema });
export const WifiServiceSchema = z.object({
  name: z.string(),
  kind: z.enum(['pairing', 'connect']),
  host: z.string(),
  port: z.number().int(),
});
export type WifiService = z.infer<typeof WifiServiceSchema>;
export const WifiDiscoverSchema = z.object({ services: z.array(WifiServiceSchema) });
export const MessageSchema = z.object({ message: z.string() });

// ---------------------------------------------------------------------------
// Processos

export const ProcessSchema = z.object({
  pid: z.number().int(),
  ppid: z.number().int(),
  user: z.string(),
  /** % do total do aparelho (todos os núcleos), medido em 1 s. */
  cpuPct: z.number(),
  rssKb: z.number(),
  state: z.string(),
  name: z.string(),
  /** Pacote do app dono do processo (ex.: com.whatsapp para com.whatsapp:push). */
  pkg: z.string().nullable(),
});
export type Process = z.infer<typeof ProcessSchema>;

export const ProcessListSchema = z.object({
  cores: z.number().int(),
  memTotalKb: z.number(),
  memAvailableKb: z.number(),
  /** O shell tem root (`su`): encerrar qualquer processo e ver qualquer pasta. */
  rooted: z.boolean(),
  processes: z.array(ProcessSchema),
});
export type ProcessList = z.infer<typeof ProcessListSchema>;

export const KillRequestSchema = z.object({ pid: z.number().int().positive(), name: z.string().max(300) });

// ---------------------------------------------------------------------------
// Conexões de rede (sockets de todos os apps, do /proc/net)

export const SocketSchema = z.object({
  proto: z.enum(['tcp', 'tcp6', 'udp', 'udp6']),
  localIp: z.string(),
  localPort: z.number().int(),
  remoteIp: z.string(),
  remotePort: z.number().int(),
  state: z.string(),
  uid: z.number().int(),
  /** Dono pelo UID: pacote do app, "root", "system" ou "uid 1234". */
  owner: z.string(),
  remoteHost: z.string().nullable(),
});
export type Socket = z.infer<typeof SocketSchema>;
export const SocketListSchema = z.object({ sockets: z.array(SocketSchema), at: z.number() });

// ---------------------------------------------------------------------------
// Arquivos

/** Caminho absoluto no aparelho, sem quebras de linha. */
export const DevicePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^\/[^\n\r\0]*$/, 'Use um caminho absoluto, ex.: /sdcard/Download');

export const FileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['dir', 'file', 'other']),
  link: z.boolean(),
  sizeBytes: z.number(),
  modifiedAt: z.number(),
  mode: z.string(),
});
export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileAccessSchema = z.object({
  /** Pacote para ler como o app (`run-as`, só apps debuggable). Vazio = shell/root. */
  as: z.string().regex(/^([A-Za-z][\w]*(\.[A-Za-z_][\w]*)+)?$/).optional(),
});

export const DirListingSchema = z.object({
  path: z.string(),
  entries: z.array(FileEntrySchema),
  truncated: z.boolean(),
  /** Como está sendo lido: shell do adb, root ou um app debuggable. */
  via: z.enum(['shell', 'root', 'run-as']),
});
export type DirListing = z.infer<typeof DirListingSchema>;

export const FileAccessInfoSchema = z.object({
  rooted: z.boolean(),
  debuggable: z.array(z.string()),
});

export const FilePreviewSchema = z.object({ text: z.string(), truncated: z.boolean(), binary: z.boolean() });
export const DeletePathSchema = z.object({ path: DevicePathSchema, as: z.string().optional() });
