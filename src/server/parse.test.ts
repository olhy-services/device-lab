import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSections, quote, sectionsCommand } from './adb';
import {
  cpuPercent,
  parseBattery,
  parseCoreFreqs,
  parseCoreStats,
  parseCpuStat,
  parseDiskstats,
  parseDiskstatsPackages,
  parseFocus,
  parseGfxinfo,
  parseListing,
  parseLogLine,
  parseMeminfo,
  parseNetDev,
  parsePackageList,
  parseProcNet,
  parseProcStat,
  parseThermal,
  parseTop,
  parseUidPackages,
  parseVmRss,
  parseWm,
} from './parse';

test('CPU: percentual entre duas leituras do /proc/stat', () => {
  const a = parseCpuStat('cpu  3340662 423132 2052975 20685015 72071 480938 120303 0 0 0');
  const b = parseCpuStat('cpu  3340762 423132 2053075 20685715 72071 480938 120303 0 0 0');
  assert.ok(a && b);
  assert.equal(b.total - a.total, 900);
  assert.equal(Math.round(cpuPercent(a, b) ?? -1), 22);
  assert.equal(cpuPercent(null, b), null);
});

test('memória e rede', () => {
  assert.deepEqual(parseMeminfo('MemTotal:        7841232 kB\nMemAvailable:    3120044 kB\n'), {
    totalKb: 7841232,
    availableKb: 3120044,
    swapTotalKb: 0,
    swapUsedKb: 0,
  });
  assert.deepEqual(
    parseMeminfo('MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal:  5853188 kB\nSwapFree:   5176952 kB\n'),
    { totalKb: 100, availableKb: 40, swapTotalKb: 5853188, swapUsedKb: 676236 },
  );
  const net = parseNetDev(
    'Inter-|   Receive |  Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets\n' +
      '    lo:  5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0\n' +
      ' wlan0: 1200 3 0 0 0 0 0 0 800 2 0 0 0 0 0 0\n' +
      'rmnet0: 300 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n',
  );
  assert.deepEqual(net, { rx: 1500, tx: 900 });
});

test('bateria', () => {
  const out = parseBattery('Current Battery Service state:\n  AC powered: false\n  status: 2\n  level: 85\n  voltage: 4300\n  temperature: 312\n');
  assert.deepEqual(out, {
    level: 85,
    tempC: 31.2,
    charging: true,
    voltageMv: 4300,
    currentMa: null,
    health: null,
    source: null,
    technology: null,
  });
  const usb = parseBattery('  USB powered: true\n  status: 3\n  health: 2\n  level: 50\n  voltage: 3900\n  temperature: 330\n  technology: Li-ion\n', '-412000\n');
  assert.equal(usb?.currentMa, 412);
  assert.equal(usb?.source, 'USB');
  assert.equal(usb?.charging, false);
  assert.equal(usb?.technology, 'Li-ion');
  assert.notEqual(usb?.health, null);
});

test('app em primeiro plano', () => {
  assert.deepEqual(
    parseFocus('  mCurrentFocus=Window{b5c0c12 u0 com.instagram.android/com.instagram.android.activity.MainTabActivity}'),
    { pkg: 'com.instagram.android', activity: 'com.instagram.android.activity.MainTabActivity' },
  );
  assert.deepEqual(parseFocus('mCurrentFocus=Window{1 u0 com.app/.Main}'), { pkg: 'com.app', activity: 'com.app.Main' });
  assert.equal(parseFocus('mCurrentFocus=Window{1 u0 NotificationShade}'), null);
  assert.deepEqual(
    parseFocus('    topResumedActivity=ActivityRecord{70055778 u0 com.android.settings/.Settings$WifiSettingsActivity t329}'),
    { pkg: 'com.android.settings', activity: 'com.android.settings.Settings$WifiSettingsActivity' },
  );
});

test('processo: CPU (utime+stime) e RSS', () => {
  // Nome com espaço e parênteses não quebra a leitura.
  const stat = '3158 (com.android (ui)) S 1 1 0 0 -1 1077952832 100 0 0 0 1500 250 0 0 20 0 50 0 1000 0 0';
  assert.equal(parseProcStat(stat), 1750);
  assert.equal(parseVmRss('Name:\tsystemui\nVmRSS:\t  360112 kB\n'), 360112);
});

test('gfxinfo', () => {
  const out = parseGfxinfo(
    'Total frames rendered: 217675\nJanky frames: 4164 (1.91%)\nJanky frames (legacy): 98751 (45.37%)\n90th percentile: 23ms\n',
  );
  assert.deepEqual(out, { frames: 217675, janky: 4164, p90Ms: 23 });
  assert.equal(parseGfxinfo('No process found'), null);
});

test('tela: override vale mais que o físico', () => {
  assert.deepEqual(parseWm('Physical size: 1080x2352\n', 'Physical density: 390\n'), { width: 1080, height: 2352, density: 390 });
  assert.deepEqual(parseWm('Physical size: 1080x2352\nOverride size: 720x1568\n', 'Physical density: 390\nOverride density: 320'), {
    width: 720,
    height: 1568,
    density: 320,
  });
});

test('logcat threadtime', () => {
  assert.deepEqual(parseLogLine('11-17 19:20:01.123  1234  1250 I ActivityManager: Start proc 4321:com.app'), {
    time: '11-17 19:20:01.123',
    pid: 1234,
    tid: 1250,
    level: 'I',
    tag: 'ActivityManager',
    message: 'Start proc 4321:com.app',
  });
  assert.equal(parseLogLine('11-17 19:20:01.123  1  2 E ReactNativeJS: ')?.message, '');
  assert.equal(parseLogLine('--------- beginning of main'), null);
});

test('pacotes e diskstats', () => {
  assert.deepEqual(parsePackageList('package:com.a versionCode:12\npackage:com.b\n'), [
    { pkg: 'com.a', versionCode: 12 },
    { pkg: 'com.b', versionCode: null },
  ]);
  const disk = [
    'Data-Free: 85211868K / 113105400K total = 75% free',
    'App Size: 9823485952',
    'App Data Size: 2384584704',
    'Videos Size: 0',
    'System Size: 15132631040',
    'Package Names: ["com.a","com.b"]',
    'App Sizes: [100,200]',
    'App Data Sizes: [10,20]',
    'Cache Sizes: [1,2]',
  ].join('\n');
  const storage = parseDiskstats(disk);
  assert.equal(storage.totalBytes, 113105400 * 1024);
  assert.equal(storage.freeBytes, 85211868 * 1024);
  assert.deepEqual(
    storage.breakdown.map((b) => b.key),
    ['apps', 'appData'],
  );
  assert.deepEqual(parseDiskstatsPackages(disk).get('com.b'), { app: 200, data: 20, cache: 2 });
});

test('várias saídas numa ida só', () => {
  const command = sectionsCommand({ a: 'echo 1', b: 'echo 2' });
  assert.match(command, /echo '@@a'/);
  assert.deepEqual([...parseSections('@@a\n1\n@@b\n2\nmais\n').entries()], [
    ['a', '1'],
    ['b', '2\nmais'],
  ]);
});

test('aspas para o shell do aparelho', () => {
  assert.equal(quote("meuapp://x?a=1&b='2'"), "'meuapp://x?a=1&b='\\''2'\\'''");
});

test('parseTop usa o último quadro e lê núcleos, tamanhos e nomes com espaço', () => {
  const frame = (cpu: string) => `Tasks: 770 total,   1 running
800%cpu 213%user  10%nice 158%sys 397%idle
  PID  PPID USER        [%CPU] RES S NAME
11712  1577 u0_a363     ${cpu} 244M S com.instagram.android
12756     1 shell        12.9 8.8M S adbd
  301     2 root          0.0    0 S [kworker/u16:2]
`;
  const { cores, processes } = parseTop(`${frame('0.0')}\n${frame('216')}`);
  assert.equal(cores, 8);
  assert.equal(processes.length, 3);
  assert.deepEqual(processes[0], { pid: 11712, ppid: 1577, user: 'u0_a363', cpu: 216, rssKb: 244 * 1024, state: 'S', name: 'com.instagram.android' });
  assert.equal(processes[1]?.rssKb, 8.8 * 1024);
  assert.equal(processes[2]?.name, '[kworker/u16:2]');
});

test('parseProcNet decodifica IPv4, IPv6 mapeado, estados e UID', () => {
  const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   1: 6F64A8C0:8C62 8DB56BB1:01BB 01 00000001:00000000 00:00000000 00000003 10363        0 0 1 0000000000000000`;
  const [s] = parseProcNet(tcp, false);
  assert.deepEqual(s, { localIp: '192.168.100.111', localPort: 0x8c62, remoteIp: '177.107.181.141', remotePort: 443, state: 'ESTABLISHED', uid: 10363 });

  const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00007064A8C0:D161 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10214        0 1787088
   1: B80D0120000000000000000001000000:01BB 00000000000000000000000000000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 1`;
  const [mapped, v6] = parseProcNet(tcp6, false);
  assert.equal(mapped?.localIp, '192.168.100.112');
  assert.equal(mapped?.remoteIp, '::');
  assert.equal(mapped?.state, 'LISTEN');
  assert.equal(v6?.localIp, '2001:db8::1');
  assert.equal(parseProcNet(tcp6, true)[1]?.state, 'UNCONN');
});

test('parseUidPackages junta pacotes que dividem UID', () => {
  const map = parseUidPackages('package:com.whatsapp uid:10250\npackage:a.b uid:1000\npackage:c.d uid:1000\n');
  assert.equal(map.get(10250), 'com.whatsapp');
  assert.equal(map.get(1000), 'a.b, c.d');
});

test('parseListing lê tipo, link, tamanho, data e ignora . e ..', () => {
  const text = ['0\t4096|1700000000|drwxrwx--x|directory\t.', '1\t4096|1700000000|lrwxrwxrwx|directory\tsdcard', '0\t12|1700000001|-rw-rw----|regular file\tnota com espaço.txt', '0\t0|0|crw-rw-rw-|character special file\tnull'].join('\n');
  const entries = parseListing(text);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { name: 'sdcard', link: true, sizeBytes: 4096, modifiedAt: 1_700_000_000_000, mode: 'lrwxrwxrwx', kind: 'dir' });
  assert.equal(entries[1]?.name, 'nota com espaço.txt');
  assert.equal(entries[1]?.kind, 'file');
  assert.equal(entries[2]?.kind, 'other');
});

test('parseCoreStats e parseCoreFreqs separam por núcleo', () => {
  const stats = parseCoreStats('cpu  10 0 10 80 0 0 0\ncpu0 5 0 5 40 0 0 0\ncpu1 5 0 5 40 0 0 0\n');
  assert.deepEqual([...stats.keys()], [0, 1]);
  const freqs = parseCoreFreqs('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq:2000000\n/sys/devices/system/cpu/cpu7/cpufreq/scaling_cur_freq:614400\n');
  assert.equal(freqs.get(0), 2000);
  assert.equal(freqs.get(7), 614.4);
});

test('parseThermal lê só a HAL atual, traduz nomes e descarta -127', () => {
  const text = `Cached temperatures:
\tTemperature{mValue=99.0, mType=0, mName=CPU, mStatus=0}
Current temperatures from HAL:
\tTemperature{mValue=48.542, mType=0, mName=CPU, mStatus=0}
\tTemperature{mValue=33.0, mType=2, mName=BATTERY, mStatus=0}
\tTemperature{mValue=-127.0, mType=4, mName=USB_PORT, mStatus=0}
\tTemperature{mValue=38.7, mType=5, mName=POWER_AMPLIFIER, mStatus=0}
Current cooling devices from HAL:
\tCoolingDevice{mValue=0, mType=2, mName=battery}`;
  assert.deepEqual(parseThermal(text), [
    { name: 'CPU', c: 48.542 },
    { name: 'Bateria', c: 33 },
    { name: 'Rádio (amplificador)', c: 38.7 },
  ]);
});
