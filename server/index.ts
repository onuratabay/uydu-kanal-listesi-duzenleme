import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ChannelSnapshot, JobKind, JobStatus, LogEntry, ScanResult, ServerEvent } from '../shared/types.ts';
import { applyMove, planMoves } from '../shared/planner.ts';
import { deviceInfo, sleep, tvSerial } from './adb.ts';
import { applyOrder, cancelMoving, compareRows, deleteChannels, mergeScrambled, scanScreen, StopRequested, type Hooks } from './executor.ts';
import { readChannels } from './reader.ts';
import * as store from './storage.ts';
import { dumpScreen, summarize } from './uiDump.ts';

const PORT = Number(process.env.PORT ?? 4310);
const SECONDS_PER_MOVE = 30;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let snapshot: ChannelSnapshot | null = await store.latestSnapshot();
let lastScan: ScanResult | null = null;
const logs: LogEntry[] = [];
const clients = new Set<Response>();
let job: JobStatus = {
  kind: null, state: 'idle', phase: '', done: 0, total: 0, message: '', startedAt: null, finishedAt: null, current: null,
};
const control = { paused: false, stop: false };

function emit(ev: ServerEvent): void {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(data);
}

function log(level: LogEntry['level'], text: string): void {
  const entry: LogEntry = { at: new Date().toISOString(), level, text };
  logs.push(entry);
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  emit({ type: 'log', entry });
  console.log(`[${level}] ${text}`);
}

function setJob(patch: Partial<JobStatus>): void {
  job = { ...job, ...patch };
  emit({ type: 'job', status: job });
}

const busy = () => job.state === 'running' || job.state === 'paused' || job.state === 'stopping';

function startJob(kind: JobKind, phase: string, fn: () => Promise<string>): void {
  if (busy()) throw new HttpError(409, 'Başka bir işlem sürüyor');
  control.paused = false;
  control.stop = false;
  setJob({ kind, state: 'running', phase, done: 0, total: 0, message: '', startedAt: new Date().toISOString(), finishedAt: null, current: null });
  void (async () => {
    try {
      const message = await fn();
      setJob({ state: 'done', message, finishedAt: new Date().toISOString(), current: null });
      log('ok', message);
    } catch (e) {
      const stopped = e instanceof StopRequested;
      const message = stopped ? 'Kullanıcı tarafından durduruldu' : (e as Error).message;
      setJob({ state: stopped ? 'stopped' : 'error', message, finishedAt: new Date().toISOString(), current: null });
      log(stopped ? 'warn' : 'error', message);
    }
  })();
}

const hooks: Omit<Hooks, 'journal'> = {
  log,
  progress: (p) => setJob({ phase: p.phase, done: p.done, total: p.total, current: p.current ?? null, message: p.message ?? '' }),
  checkpoint: async () => {
    if (control.stop) throw new StopRequested();
    if (control.paused) {
      setJob({ state: 'paused' });
      while (control.paused && !control.stop) await sleep(300);
      if (control.stop) throw new StopRequested();
      setJob({ state: 'running' });
    }
  },
};

function requireSnapshot(): ChannelSnapshot {
  if (!snapshot) throw new HttpError(400, "Önce kanal listesini TV'den okuyun");
  return snapshot;
}

function validateOrder(order: unknown, snap: ChannelSnapshot): number[] {
  if (!Array.isArray(order) || !order.every((x) => Number.isInteger(x))) throw new HttpError(400, 'Geçersiz sıra');
  const ids = new Set(snap.channels.map((c) => c.id));
  if (order.length !== ids.size || new Set(order).size !== order.length || !order.every((id) => ids.has(id))) {
    throw new HttpError(400, 'Sıra, okunan kanal listesiyle aynı kanalları içermiyor');
  }
  return order as number[];
}

/** Uygulamadan sonra numaralar konuma bağlı olarak yeniden dağıtılır (TV'nin yaptığı gibi). */
function renumber(snap: ChannelSnapshot, order: number[]): ChannelSnapshot {
  const byId = new Map(snap.channels.map((c) => [c.id, c]));
  const numbers = snap.channels.map((c) => c.number!).sort((a, b) => a - b);
  return {
    ...snap,
    channels: order.map((id, i) => ({ ...byId.get(id)!, number: numbers[i] })),
    warnings: ["Bu liste TV'ye uygulanan taşımalardan hesaplandı. Kesin doğrulama için TV'den yeniden okuyun."],
  };
}

const app = express();
app.use(express.json({ limit: '5mb' }));
const h = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

app.get('/api/status', h(async (_req, res) => {
  res.json({ device: await deviceInfo(), job, hasSnapshot: !!snapshot });
}));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'job', status: job })}\n\n`);
  for (const entry of logs.slice(-200)) res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.get('/api/snapshot', (_req, res) => {
  if (!snapshot) return res.status(404).json({ error: 'Henüz okuma yok' });
  res.json(snapshot);
});

app.post('/api/read', h(async (_req, res) => {
  startJob('read', 'Bağlanılıyor', async () => {
    const info = await deviceInfo();
    if (!info.connected) throw new Error(`TV'ye bağlanılamadı: ${info.error ?? tvSerial()}`);
    log('info', `Okuma başladı: ${info.model} (Android ${info.android})`);
    const read = await readChannels(`${info.model} (${tvSerial()})`, (p) => setJob({ phase: p.phase, done: p.done, total: p.total }));
    // Şifreli bilgisi yalnızca ekrandan okunabildiği için aynı kanal (aynı _id ve ad) için önceki taramadan taşınır.
    const previous = new Map((snapshot?.channels ?? []).map((c) => [c.id, c]));
    let carried = 0;
    const channels = read.channels.map((c) => {
      const p = previous.get(c.id);
      if (p?.scrambled === undefined || p.name !== c.name) return c;
      carried++;
      return { ...c, scrambled: p.scrambled };
    });
    const snap: ChannelSnapshot = { ...read, channels, scrambledCheckedAt: carried ? snapshot?.scrambledCheckedAt : undefined };
    snapshot = snap;
    const file = await store.saveBackup(snap, 'yedek');
    emit({ type: 'snapshot', snapshot: snap });
    for (const w of snap.warnings) log('warn', w);
    return `${snap.channels.length} kanal okundu ve yedeklendi (backups/${file})`;
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/screen', h(async (_req, res) => {
  if (busy()) throw new HttpError(409, 'Bir işlem sürerken ekran okunmaz');
  // Önce cihaz bilgisi: bağlı TV'nin (IP'si değişmiş olabilir) seçilmesini sağlar.
  const info = await deviceInfo();
  const screen = await dumpScreen();
  res.json(summarize(screen, info.activity));
}));

app.post('/api/scan', h(async (_req, res) => {
  const snap = requireSnapshot();
  startJob('scan', 'Ekrandan okunuyor', async () => {
    const rows = await scanScreen(hooks);
    const differences = compareRows(rows, snap.channels);
    lastScan = { scannedAt: new Date().toISOString(), rows, matchesSnapshot: differences.length === 0, differences };
    emit({ type: 'scan', result: lastScan });
    for (const d of differences.slice(0, 30)) log('warn', d);

    const { channels, matched } = mergeScrambled(snap.channels, rows);
    const scrambledCount = channels.filter((c) => c.scrambled).length;
    if (matched > 0) {
      snapshot = { ...snap, channels, scrambledCheckedAt: lastScan.scannedAt };
      const file = await store.saveBackup(snapshot, 'yedek');
      emit({ type: 'snapshot', snapshot });
      log('info', `Şifreli bilgisi ${matched} kanala işlendi ve yedeklendi (backups/${file})`);
    }
    const summary = `Ekranda ${rows.length} kanal okundu, ${scrambledCount} şifreli kanal bulundu`;
    return differences.length ? `${summary}; okunan listeyle ${differences.length} fark var` : `${summary}; liste birebir aynı`;
  });
  res.status(202).json({ ok: true });
}));

app.get('/api/scan', (_req, res) => res.json(lastScan));

app.post('/api/release-move', h(async (_req, res) => {
  if (busy()) throw new HttpError(409, 'Başka bir işlem sürüyor');
  await cancelMoving(log);
  res.json({ ok: true });
}));

app.post('/api/plan', h(async (req, res) => {
  const snap = requireSnapshot();
  const order = validateOrder(req.body?.order, snap);
  const current = snap.channels.map((c) => c.id);
  const unknown = snap.channels.filter((c) => c.number === null).length;
  const numbers = snap.channels.map((c) => c.number ?? 0);
  const moves = planMoves(current, order, numbers, new Map(snap.channels.map((c) => [c.id, c.name])));
  res.json({ count: moves.length, moves: moves.slice(0, 200), estimatedSeconds: moves.length * SECONDS_PER_MOVE, unknownNumbers: unknown });
}));

app.post('/api/apply', h(async (req, res) => {
  const snap = requireSnapshot();
  if (req.body?.confirm !== true) throw new HttpError(400, 'Uygulama için açık onay gerekli');
  const order = validateOrder(req.body.order, snap);
  const maxMoves = Number.isInteger(req.body.maxMoves) && req.body.maxMoves > 0 ? req.body.maxMoves : undefined;
  const verifyScan = req.body.verifyScan !== false;
  const target = await store.saveBackup(snap, 'hedef', order);
  log('info', `Hedef sıra kaydedildi: backups/${target}`);
  startJob('apply', 'Hazırlanıyor', async () => {
    // Tamamlanan her taşıma burada izlenir; işlem hatayla dursa da TV'nin yeni hâli kaybolmaz.
    let applied = snap.channels.map((c) => c.id);
    let done = 0;
    const writeJournal = store.createJournal();
    const persist = async () => {
      if (!done) return;
      snapshot = renumber(snap, applied);
      // Sunucu yeniden başlarsa eski okumaya dönülmesin diye TV'nin yeni hâli de yedeklenir.
      const file = await store.saveBackup(snapshot, 'yedek');
      log('info', `Uygulama sonrası liste kaydedildi (backups/${file})`);
      emit({ type: 'snapshot', snapshot });
    };
    try {
      const result = await applyOrder(
        { channels: snap.channels, desired: order, maxMoves, verifyScan },
        {
          ...hooks,
          journal: async (move) => {
            applied = applyMove(applied, move.fromIndex, move.toIndex);
            done++;
            await writeJournal(move);
          },
        },
      );
      await persist();
      return result.remaining
        ? `${result.done} taşıma uygulandı, ${result.remaining} kanal hâlâ hedef konumunda değil`
        : `${result.done} taşıma uygulandı; TV listesi hedef sırada`;
    } catch (e) {
      await persist();
      throw new Error(`${(e as Error).message} (${done} taşıma tamamlanmıştı)`, { cause: e });
    }
  });
  res.status(202).json({ ok: true });
}));

app.post('/api/delete', h(async (req, res) => {
  const snap = requireSnapshot();
  if (req.body?.confirm !== true) throw new HttpError(400, 'Silme için açık onay gerekli');
  const ids = req.body.removeIds;
  const known = new Map(snap.channels.map((c) => [c.id, c]));
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
    throw new HttpError(400, 'Silinecek kanal listesi geçersiz');
  }
  const removing = ids.map((id: number) => known.get(id)!);
  const file = await store.saveDeletionList(removing.map((c) => ({ id: c.id, number: c.number, name: c.name })));
  log('info', `Silinecek ${ids.length} kanal kaydedildi: ${file}`);
  startJob('delete', 'Hazırlanıyor', async () => {
    const result = await deleteChannels({ channels: snap.channels, removeIds: ids }, hooks);
    const gone = new Set<number>(ids);
    snapshot = {
      ...snap,
      channels: snap.channels.filter((c) => !gone.has(c.id)),
      warnings: ["Bu liste TV'deki silmeden sonra hesaplandı. Kesin doğrulama için TV'den yeniden okuyun."],
    };
    const backup = await store.saveBackup(snapshot, 'yedek');
    log('info', `Silme sonrası liste kaydedildi (backups/${backup})`);
    emit({ type: 'snapshot', snapshot });
    return `${result.deleted} kanal TV listesinden silindi`;
  });
  res.status(202).json({ ok: true });
}));

app.post('/api/job/pause', (_req, res) => {
  if (job.kind && busy()) control.paused = true;
  res.json({ ok: true });
});
app.post('/api/job/resume', (_req, res) => {
  control.paused = false;
  res.json({ ok: true });
});
app.post('/api/job/stop', (_req, res) => {
  if (busy()) {
    control.stop = true;
    setJob({ state: 'stopping' });
  }
  res.json({ ok: true });
});

app.get('/api/backups', h(async (_req, res) => res.json(await store.listBackups())));
app.get('/api/backups/:file', h(async (req, res) => res.json(await store.loadBackup(String(req.params.file)))));
app.get('/api/draft', h(async (_req, res) => res.json(await store.loadDraft())));
app.put('/api/draft', h(async (req, res) => {
  const { basedOn, order } = req.body ?? {};
  if (typeof basedOn !== 'string' || !Array.isArray(order)) throw new HttpError(400, 'Geçersiz taslak');
  await store.saveDraft({ basedOn, order });
  res.json({ ok: true });
}));

const dist = path.join(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err instanceof HttpError ? err.status : 500).json({ error: err.message });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`TV Kanal Yöneticisi: http://localhost:${PORT}  (TV: ${tvSerial()})`);
  if (snapshot) console.log(`Son yedek yüklendi: ${snapshot.channels.length} kanal (${snapshot.readAt})`);
});
