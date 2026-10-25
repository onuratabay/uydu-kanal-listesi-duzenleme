import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ADB = process.env.ADB_PATH ?? 'adb';
/** TV_SERIAL verilmezse bağlı Xiaomi TV otomatik seçilir (DHCP ile IP değişebiliyor). */
let serial = process.env.TV_SERIAL ?? '192.168.1.35:5555';
const fixedSerial = !!process.env.TV_SERIAL;
export const tvSerial = () => serial;

export const KEY = {
  BACK: 4,
  UP: 19,
  DOWN: 20,
  LEFT: 21,
  RIGHT: 22,
  CENTER: 23,
  digit: (d: number) => 7 + d,
} as const;

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`adb ${args.slice(0, 3).join(' ')} başarısız: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}

export const adb = (args: string[], timeoutMs = 60_000) => run(['-s', serial, ...args], timeoutMs);
export const shell = (script: string, timeoutMs = 60_000) => adb(['shell', script], timeoutMs);

/** Uzun betikleri komut satırı sınırına takılmadan çalıştırmak için önce TV'ye kopyalar. */
export async function runScript(script: string, timeoutMs = 600_000): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tvkm-'));
  const local = path.join(dir, 'job.sh');
  const remote = '/data/local/tmp/tvkm-job.sh';
  try {
    await writeFile(local, script, 'utf8');
    await adb(['push', local, remote], 30_000);
    return await shell(`sh ${remote}; rm -f ${remote}`, timeoutMs);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface DeviceInfo {
  connected: boolean;
  serial: string;
  model: string;
  android: string;
  activity: string;
  error?: string;
}

export async function deviceInfo(): Promise<DeviceInfo> {
  try {
    const devices = await run(['devices', '-l'], 10_000);
    const online = devices.split('\n').filter((l) => /\sdevice\s/.test(l));
    if (!online.some((l) => l.startsWith(`${serial} `))) {
      const tv = online.find((l) => l.includes('model:MiTV'));
      if (tv && !fixedSerial) serial = tv.split(/\s+/)[0];
      else await run(['connect', serial], 15_000).catch(() => '');
    }
  } catch {
    // adb devices başarısızsa aşağıdaki komut hatayı raporlar
  }
  const base = { serial, model: '', android: '', activity: '' };
  try {
    const out = await shell(
      'getprop ro.product.model; getprop ro.build.version.release; dumpsys activity activities | grep -m1 topResumedActivity',
      15_000,
    );
    const [model = '', android = '', top = ''] = out.split('\n').map((s) => s.trim());
    const activity = /u0 (\S+)/.exec(top)?.[1] ?? '';
    return { ...base, connected: true, model, android, activity };
  } catch (e) {
    return { ...base, connected: false, error: (e as Error).message };
  }
}

/** Tuşları sırayla gönderir. Uzun dizileri parçalar. */
export async function pressKeys(codes: number[]): Promise<void> {
  for (let i = 0; i < codes.length; i += 40) {
    await shell(`input keyevent ${codes.slice(i, i + 40).join(' ')}`, 30_000);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
