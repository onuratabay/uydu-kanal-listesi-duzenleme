/**
 * Sıralamayı TV'ye, LiveTV'nin kendi "Kanalları yeniden düzenle" ekranı üzerinden uygular.
 *
 * Bir taşıma (LiveTV kaynak kodundan çıkarılan akış, platform "aow"):
 *   1. Kaynak kanala gidilir (taşıma modu KAPALIYKEN; YUKARI/AŞAĞI yalnızca gezinmedir)
 *   2. OK  -> kanal "tutulur" (taşıma modu açılır)
 *   3. SAĞ -> sağdaki "taşı" butonu, OK -> numara diyaloğu açılır
 *   4. Hedef numara rakam tuşlarıyla yazılır, "Tamam" seçilir
 *      -> LiveTV sortChannel(kaynakIndeks, hedefIndeks) çalıştırır
 *   5. Liste yenilenir; ekrandaki satırlar beklenen yeni sırayla karşılaştırılır
 *
 * Güvenlik: taşıma modu açıkken YUKARI/AŞAĞI gönderilmez (TV'de bu tuşlar kanalı
 * kaydırır). Her adımdan sonra ekran okunur; beklenmeyen bir durumda taşıma modu
 * değişiklik yapmadan kapatılır (kaynak = hedef iken OK) ve işlem durdurulur.
 */
import type { Channel, Move, ScreenRowInfo } from '../shared/types.ts';
import { applyMove, minimumMoves, MovePlanner } from '../shared/planner.ts';
import { KEY, pressKeys, sleep } from './adb.ts';
import { dumpScreen, type ChannelRow, type ScreenState } from './uiDump.ts';

export class AbortError extends Error {}
export class StopRequested extends Error {}

export interface Hooks {
  log(level: 'info' | 'warn' | 'error' | 'ok', text: string): void;
  progress(p: { phase: string; done: number; total: number; current?: Move | null; message?: string }): void;
  /** Taşımalar arasında çağrılır: duraklatıldıysa bekler, durdurulduysa StopRequested fırlatır. */
  checkpoint(): Promise<void>;
  journal(move: Move): Promise<void>;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleUpperCase('tr');

/**
 * TV ekranındaki listenin modeli: i. konumdaki kanal ve (konuma bağlı) numarası.
 * TV bazen bir kanalın numarasını güncellemeyip iki kanala aynı numarayı bırakabiliyor;
 * bu yüzden bir numara birden fazla konuma karşılık gelebilir ve satırlar adla ayırt edilir.
 */
interface ListModel {
  ids: number[];
  names: string[];
  numbers: number[];
  indexesByNumber: Map<string, number[]>;
}

function makeModel(channels: Channel[]): ListModel {
  const sorted = [...channels].sort((a, b) => a.number! - b.number!);
  const indexesByNumber = new Map<string, number[]>();
  sorted.forEach((c, i) => indexesByNumber.set(String(c.number), [...(indexesByNumber.get(String(c.number)) ?? []), i]));
  return {
    ids: sorted.map((c) => c.id),
    names: sorted.map((c) => c.name),
    numbers: sorted.map((c) => c.number!),
    indexesByNumber,
  };
}

function moved(model: ListModel, from: number, to: number): ListModel {
  return { ...model, ids: applyMove(model.ids, from, to), names: applyMove(model.names, from, to) };
}

/** Ekrandaki satırın modeldeki konumu (numara + ad eşleşmeli). */
function indexOfRow(row: ChannelRow, model: ListModel): number | null {
  const hit = (model.indexesByNumber.get(row.number) ?? []).find((i) => norm(model.names[i]) === norm(row.name));
  return hit ?? null;
}

function rowsMatch(rows: ChannelRow[], model: ListModel): boolean {
  return rows.length > 0 && rows.every((r) => indexOfRow(r, model) !== null);
}

function focusIndex(s: ScreenState, model: ListModel): number | null {
  const row = s.rows.find((r) => r.focused);
  return row ? indexOfRow(row, model) : null;
}

const keys = (code: number, count: number) => Array.from({ length: count }, () => code);

async function press(codes: number[], settleMs = 300): Promise<void> {
  await pressKeys(codes);
  await sleep(settleMs);
}

function describe(s: ScreenState): string {
  if (s.kind === 'dialog') return 'numara diyaloğu açık';
  if (s.kind === 'message') return `onay penceresi açık (${s.messageText ?? ''})`;
  if (s.kind === 'delete') return 'kanal silme ekranı';
  if (s.kind === 'other') return `başka bir ekran (${s.pkg || 'bilinmiyor'})`;
  return s.moving ? 'yeniden düzenleme ekranı, taşıma modu AÇIK' : 'yeniden düzenleme ekranı';
}

/** Taşıma modunu değişiklik yapmadan kapatır. */
export async function cancelMoving(log: Hooks['log']): Promise<ScreenState> {
  let s = await dumpScreen();
  if (s.kind === 'dialog') {
    await press([KEY.BACK], 600);
    s = await dumpScreen();
  }
  if (s.kind === 'rearrange' && s.moving) {
    // Kaynak ve hedef aynıyken OK, LiveTV'de sıralama yapmadan taşıma modunu kapatır.
    if (s.floatFocused) await press([KEY.LEFT]);
    await press([KEY.CENTER], 600);
    s = await dumpScreen();
  }
  if (s.moving) throw new AbortError("Taşıma modu kapatılamadı. TV'de kumandayla OK'a bir kez basın.");
  log('info', 'Taşıma modu değişiklik yapılmadan kapatıldı');
  return s;
}

const isList = (s: ScreenState) => s.kind === 'rearrange' || s.kind === 'delete';

async function ensureFocus(s: ScreenState): Promise<ScreenState> {
  if (s.rows.some((r) => r.focused) || s.moving || !isList(s)) return s;
  // Odak listenin kendisindeyse: AŞAĞI+YUKARI odaklı satırı geri getirir (net hareket yok).
  await press([KEY.DOWN, KEY.UP]);
  return dumpScreen();
}

async function requireIdleRearrange(): Promise<ScreenState> {
  const s = await dumpScreen();
  if (s.kind === 'dialog') throw new AbortError("TV'de numara diyaloğu açık. Kumandadan GERİ ile kapatın.");
  if (s.kind !== 'rearrange') {
    throw new AbortError(
      "TV'de \"Kanalları yeniden düzenle\" ekranı açık değil. Canlı TV → OK (kanal listesi) → Düzenle → Kanalları yeniden düzenle.",
    );
  }
  if (s.moving) throw new AbortError("TV'de bir kanal taşıma modunda. Kumandadan OK'a basarak bırakın (yerinden oynatmadan).");
  return ensureFocus(s);
}

async function navigateTo(target: number, model: ListModel, start: ScreenState, log: Hooks['log']): Promise<ScreenState> {
  let s = start;
  const n = model.ids.length;
  let pressed = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (!isList(s) || s.moving) throw new AbortError(`Gezinme sırasında beklenmeyen durum: ${describe(s)}`);
    const f = focusIndex(s, model);
    if (f === null) {
      if (s.rows.some((r) => r.focused)) {
        throw new AbortError('Ekrandaki odaklı kanal okunan listeyle uyuşmuyor. Listeyi TV\'den yeniden okuyun.');
      }
      s = await ensureFocus(s);
      continue;
    }
    if (f === target) {
      if (!pressed) return s;
      // Liste kayarken döküm ara bir konumu gösterebiliyor; odak yerinde kaldı mı tekrar bak.
      await sleep(500);
      const again = await dumpScreen();
      if (focusIndex(again, model) === target) return again;
      s = again;
      pressed = false;
      continue;
    }
    // Liste uçlarda sarar (sondan AŞAĞI → başa), bu yüzden kısa yön seçilir.
    const down = (target - f + n) % n;
    const up = (f - target + n) % n;
    const codes = down <= up ? keys(KEY.DOWN, down) : keys(KEY.UP, up);
    await press(codes, 250 + Math.min(codes.length, 120) * 6);
    pressed = true;
    s = await dumpScreen();
  }
  log('warn', `Hedef konuma (${target + 1}) ulaşılamadı`);
  throw new AbortError('Kaynak kanala gidilemedi');
}

/** Bir taşımayı uygular ve doğrular. Başarılıysa yeni ekran durumunu döndürür. */
async function performMove(move: Move, model: ListModel, log: Hooks['log']): Promise<ScreenState> {
  const fromNumber = String(model.numbers[move.fromIndex]);
  const digits = String(move.toNumber);
  const fail = async (reason: string): Promise<never> => {
    log('warn', reason);
    await cancelMoving(log);
    throw new AbortError(reason);
  };

  // 1) Kanalı tut
  await press([KEY.CENTER], 400);
  let s = await dumpScreen();
  if (s.kind === 'rearrange' && !s.moving) {
    await press([KEY.CENTER], 500);
    s = await dumpScreen();
  }
  if (s.kind !== 'rearrange' || !s.moving) await fail(`Kanal tutulamadı (${describe(s)})`);
  const held = s.rows.find((r) => r.moveIcon) ?? s.rows.find((r) => r.focused);
  if (!held || held.number !== fromNumber || norm(held.name) !== norm(move.name)) {
    await fail(`Yanlış kanal tutuldu: beklenen ${fromNumber} ${move.name}, ekranda ${held ? `${held.number} ${held.name}` : 'yok'}`);
  }

  // 2) "Taşı" butonu → numara diyaloğu
  await press([KEY.RIGHT], 350);
  s = await dumpScreen();
  if (!s.floatFocused) await fail('Taşı butonuna geçilemedi');
  await press([KEY.CENTER], 700);
  s = await dumpScreen();
  if (s.kind !== 'dialog') await fail('Numara diyaloğu açılmadı');

  // 3) Numara + "Tamam" butonuna geçiş (diyalog açıkken YUKARI/AŞAĞI yalnızca tuş takımında gezinir)
  await press(digits.split('').map((d) => KEY.digit(Number(d))), 300);
  await press([KEY.DOWN, KEY.DOWN, KEY.RIGHT], 350);
  s = await dumpScreen();
  for (let i = 0; i < 3 && s.kind === 'dialog' && s.focusedId !== 'input_number_view_action_right'; i++) {
    await press([KEY.DOWN, KEY.RIGHT], 350);
    s = await dumpScreen();
  }
  if (s.kind !== 'dialog') {
    // Diyalog beklenmedik şekilde kapandıysa tuşların listeye gitmiş olma ihtimali var: hemen dur.
    throw new AbortError("Numara diyaloğu beklenmedik şekilde kapandı. TV'deki listeyi kontrol edip yeniden okuyun.");
  }
  if (s.dialogValue !== digits) await fail(`Numara yanlış yazıldı (beklenen ${digits}, ekranda "${s.dialogValue}")`);
  if (s.focusedId !== 'input_number_view_action_right') await fail('Diyalogda "Tamam" butonuna geçilemedi');

  // 4) Onayla
  await press([KEY.CENTER], 900);

  // 5) Doğrula: ekrandaki satırlar yeni sırayla eşleşmeli
  const expected = moved(model, move.fromIndex, move.toIndex);
  for (let poll = 0; poll < 12; poll++) {
    s = await dumpScreen();
    if (s.kind === 'dialog') {
      if (poll >= 2) await fail(`TV ${digits} numaralı hedefi kabul etmedi`);
    } else if (s.kind === 'rearrange' && !s.moving) {
      const isNew = rowsMatch(s.rows, expected);
      const isOld = rowsMatch(s.rows, model);
      if (isNew && !isOld) return s;
      if (isNew && isOld && poll >= 2) {
        log('warn', 'Görünen satırlar eski ve yeni sırada aynı; taşıma son doğrulama okumasında kontrol edilmeli');
        return s;
      }
      if (!isNew && !isOld && poll >= 3) {
        throw new AbortError('TV listesi beklenen hâlde değil. İşlem durduruldu; listeyi yeniden okuyun.');
      }
    } else if (s.kind === 'other') {
      throw new AbortError('Yeniden düzenleme ekranı kapandı');
    }
    await sleep(700);
  }
  throw new AbortError('Taşıma doğrulanamadı (zaman aşımı)');
}

export interface ApplyParams {
  channels: Channel[];
  desired: number[];
  maxMoves?: number;
  verifyScan: boolean;
}

export interface ApplyResult {
  done: number;
  remaining: number;
  order: number[];
}

export async function applyOrder(p: ApplyParams, hooks: Hooks): Promise<ApplyResult> {
  if (p.channels.some((c) => c.number === null)) {
    throw new AbortError('Numarası bilinmeyen kanallar var; bu durumda TV\'ye uygulama yapılamaz.');
  }
  let model = makeModel(p.channels);

  hooks.progress({ phase: 'TV ekranı kontrol ediliyor', done: 0, total: 0 });
  let s = await requireIdleRearrange();
  if (!rowsMatch(s.rows, model)) {
    throw new AbortError('TV ekranındaki kanallar okunan listeyle uyuşmuyor. Önce listeyi TV\'den yeniden okuyun.');
  }
  if (p.verifyScan) {
    const rows = await scanScreen(hooks);
    const diff = compareRows(rows, p.channels);
    if (diff.length) throw new AbortError(`Ekran taraması okunan listeyle uyuşmuyor: ${diff.slice(0, 5).join(' · ')}`);
    hooks.log('ok', `Ekran taraması okunan listeyle birebir aynı (${rows.length} kanal)`);
    s = await requireIdleRearrange();
  }

  const names = new Map(p.channels.map((c) => [c.id, c.name]));
  const planner = new MovePlanner(model.ids, p.desired, model.numbers, names);
  const needed = minimumMoves(model.ids, p.desired);
  const total = p.maxMoves ? Math.min(p.maxMoves, needed) : needed;
  hooks.log('info', `Gereken taşıma sayısı: ${needed}${p.maxMoves ? ` (bu çalıştırmada en fazla ${p.maxMoves})` : ''}`);

  let focus = focusIndex(s, model) ?? 0;
  let done = 0;
  for (;;) {
    await hooks.checkpoint();
    if (p.maxMoves && done >= p.maxMoves) break;
    const move = planner.next(focus);
    if (!move) break;
    hooks.progress({ phase: 'Kanallar taşınıyor', done, total, current: move });
    hooks.log('info', `${move.name}: ${model.numbers[move.fromIndex]} → ${move.toNumber}`);
    s = await navigateTo(move.fromIndex, model, s, hooks.log);
    s = await performMove(move, model, hooks.log);
    planner.commit(move);
    model = moved(model, move.fromIndex, move.toIndex);
    await hooks.journal(move);
    done++;
    hooks.log('ok', `✓ ${move.name} artık ${move.toNumber} numarada`);
    s = await ensureFocus(s);
    focus = focusIndex(s, model) ?? move.fromIndex;
  }
  hooks.progress({ phase: 'Bitti', done, total, current: null });
  return { done, remaining: planner.remaining, order: [...planner.order] };
}

/**
 * "Kanalları yeniden düzenle" listesini ekrandan baştan sona okur (yalnızca gezinme).
 * Liste her zaman numaraya göre artan sırada olduğundan satırlar numaraya göre birleştirilir.
 */
export async function scanScreen(hooks: Pick<Hooks, 'log' | 'progress' | 'checkpoint'>): Promise<ScreenRowInfo[]> {
  let s = await requireIdleRearrange();
  // Anahtar numara + ad: aynı numarayı kullanan iki farklı kanal da kaydedilir.
  const seen = new Map<string, { number: number; name: string; scrambled: boolean }>();
  const startRow = s.rows.find((r) => r.focused);
  if (!startRow) throw new AbortError('Odaklı kanal bulunamadı');
  const startNumber = Number(startRow.number);
  let prevFocus = startNumber;
  let wrapped = false;
  let lastStep = 0;
  let singleStep = false;
  for (let iter = 0; iter < 600; iter++) {
    await hooks.checkpoint();
    if (s.kind !== 'rearrange' || s.moving) throw new AbortError(`Tarama sırasında beklenmeyen durum: ${describe(s)}`);
    const nums = s.rows.map((r) => Number(r.number));
    // Eşit numara sıra hatası değildir (TV bazen iki kanala aynı numarayı bırakıyor).
    if (nums.some((v, i) => i > 0 && v < nums[i - 1]) && !wrapped) {
      hooks.log('warn', 'Ekrandaki satırlar numara sırasında değil');
    }
    for (const r of s.rows) seen.set(`${r.number}|${norm(r.name)}`, { number: Number(r.number), name: r.name, scrambled: r.scrambled });
    hooks.progress({ phase: 'Ekrandan okunuyor', done: seen.size, total: 0, message: `${seen.size} kanal görüldü` });
    const f = Number(s.rows.find((r) => r.focused)?.number ?? NaN);
    if (Number.isNaN(f)) {
      s = await ensureFocus(s);
      continue;
    }
    if (f < prevFocus && !wrapped) {
      if (lastStep > 1) {
        // Çok satırlı adım listenin sonundan başa sardı; arada son satırlar atlanmış olabilir.
        // Aynı sayıda YUKARI ile geri dön (liste ters yönde de sarar) ve sonu tek tek oku.
        await press(keys(KEY.UP, lastStep), 350);
        s = await dumpScreen();
        singleStep = true;
        lastStep = 0;
        continue;
      }
      wrapped = true;
      singleStep = false;
    }
    if (wrapped && f >= startNumber) break;
    prevFocus = f;
    lastStep = singleStep ? 1 : Math.max(1, s.rows.length - 2);
    await press(keys(KEY.DOWN, lastStep), 350);
    s = await dumpScreen();
  }
  if (!wrapped) throw new AbortError('Ekran taraması tamamlanamadı');
  return [...seen.values()]
    .sort((a, b) => a.number - b.number)
    .map((r) => ({ number: String(r.number), name: r.name, scrambled: r.scrambled }));
}

const rowKey = (number: string | number | null, name: string) => `${number}|${norm(name)}`;

/** Ekran taramasındaki kilit ikonlarını, numara ve adı eşleşen kanallara işler. */
export function mergeScrambled(channels: Channel[], rows: ScreenRowInfo[]): { channels: Channel[]; matched: number } {
  const byKey = new Map(rows.map((r) => [rowKey(r.number, r.name), r]));
  let matched = 0;
  const out = channels.map((c) => {
    const r = c.number === null ? undefined : byKey.get(rowKey(c.number, c.name));
    if (!r) return c;
    matched++;
    return { ...c, scrambled: r.scrambled };
  });
  return { channels: out, matched };
}

export function compareRows(rows: ScreenRowInfo[], channels: Channel[]): string[] {
  const diff: string[] = [];
  const listed = new Set(channels.filter((c) => c.number !== null).map((c) => rowKey(c.number, c.name)));
  const screen = new Set(rows.map((r) => rowKey(r.number, r.name)));
  for (const r of rows) if (!listed.has(rowKey(r.number, r.name))) diff.push(`${r.number} ${r.name}: okunan listede bu numarayla yok`);
  for (const c of channels) {
    if (c.number !== null && !screen.has(rowKey(c.number, c.name))) diff.push(`${c.number} ${c.name}: ekranda bu numarayla görülmedi`);
  }
  return diff;
}

export interface DeleteParams {
  channels: Channel[];
  removeIds: number[];
}

/**
 * Seçimleri iptal ederek silme ekranından çıkar. LiveTV kanalları yalnızca onay penceresinde
 * "Tamam"a basılınca siler; ekrandan GERİ ile çıkmak işaretleri atar, hiçbir kanal silinmez.
 */
async function abandonDelete(log: Hooks['log']): Promise<void> {
  try {
    let s = await dumpScreen();
    if (s.kind === 'message') {
      await press([KEY.BACK], 700);
      s = await dumpScreen();
    }
    if (s.kind === 'delete' && ((s.deleteCount ?? 0) > 0 || s.rows.some((r) => r.checked))) {
      await press([KEY.BACK], 900);
    }
    log('warn', 'Silme ekranından çıkıldı; işaretler atıldı, hiçbir kanal silinmedi');
  } catch (e) {
    log('error', `Silme ekranından çıkılamadı: ${(e as Error).message}. TV'de GERİ tuşuna basın, ONAYLAMAYIN.`);
  }
}

/**
 * Kanalları LiveTV'nin "Kanalları sil" ekranından siler (LiveTV kanalı gizler: browsable=0).
 * Her işaretleme ekrandan doğrulanır; onaydan önce sil butonundaki ve onay penceresindeki sayı
 * silinecek kanal sayısıyla karşılaştırılır.
 */
export async function deleteChannels(p: DeleteParams, hooks: Omit<Hooks, 'journal'>): Promise<{ deleted: number }> {
  if (p.channels.some((c) => c.number === null)) throw new AbortError('Numarası bilinmeyen kanallar var; silme yapılamaz.');
  const model = makeModel(p.channels);
  const remove = new Set(p.removeIds);
  const targets = model.ids.map((id, i) => (remove.has(id) ? i : -1)).filter((i) => i >= 0);
  if (targets.length !== remove.size) throw new AbortError('Silinecek kanalların bir kısmı okunan listede yok');
  if (!targets.length) return { deleted: 0 };
  const targetSet = new Set(targets);
  const label = (i: number) => `${model.numbers[i]} ${model.names[i]}`;

  hooks.progress({ phase: 'TV ekranı kontrol ediliyor', done: 0, total: targets.length });
  let s = await dumpScreen();
  if (s.kind !== 'delete') {
    throw new AbortError('TV\'de "Kanalları sil" ekranı açık değil. Kanal listesi → bir kanala uzun bas → Sil.');
  }
  if ((s.deleteCount ?? 0) > 0 || s.rows.some((r) => r.checked)) {
    throw new AbortError('Silme ekranında zaten işaretli kanal var. Ekrandan GERİ ile çıkıp yeniden açın.');
  }
  if (!rowsMatch(s.rows, model)) {
    throw new AbortError("TV ekranındaki kanallar okunan listeyle uyuşmuyor. Önce TV'den yeniden okuyun.");
  }

  let marked = 0;
  try {
    s = await ensureFocus(s);
    for (const idx of targets) {
      await hooks.checkpoint();
      hooks.progress({ phase: 'Silinecek kanallar işaretleniyor', done: marked, total: targets.length, message: label(idx) });
      s = await navigateTo(idx, model, s, hooks.log);
      if (s.rows.find((r) => r.focused)?.checked) throw new AbortError(`${label(idx)} beklenmedik şekilde zaten işaretli`);
      await press([KEY.CENTER], 400);
      s = await dumpScreen();
      const row = s.rows.find((r) => r.focused);
      const stray = s.rows.filter((r) => r.checked && !targetSet.has(indexOfRow(r, model) ?? -1));
      if (s.kind !== 'delete' || !row || indexOfRow(row, model) !== idx || !row.checked || s.deleteCount !== marked + 1 || stray.length) {
        throw new AbortError(`İşaretleme doğrulanamadı: ${label(idx)} (ekrandaki sayı ${s.deleteCount ?? '-'})`);
      }
      marked++;
      hooks.log('ok', `☑ ${label(idx)} işaretlendi (${marked}/${targets.length})`);
    }

    hooks.progress({ phase: 'Silme onaylanıyor', done: marked, total: targets.length });
    if (s.deleteCount !== targets.length) throw new AbortError(`Sil butonu ${s.deleteCount} kanal gösteriyor, beklenen ${targets.length}`);
    await press([KEY.RIGHT], 400);
    s = await dumpScreen();
    if (!s.deleteFloatFocused) throw new AbortError('Sil butonuna geçilemedi');
    await press([KEY.CENTER], 900);
    s = await dumpScreen();
    if (s.kind !== 'message' || !s.messageText?.includes(String(targets.length))) {
      throw new AbortError(`Onay penceresi beklenen sayıyı göstermiyor: "${s.messageText ?? describe(s)}"`);
    }
    for (const code of [KEY.LEFT, KEY.RIGHT, KEY.RIGHT]) {
      if (s.focusedId === 'message_dialog_button_ok') break;
      await press([code], 350);
      s = await dumpScreen();
      if (s.kind !== 'message') throw new AbortError('Onay penceresi beklenmedik şekilde kapandı');
    }
    if (s.focusedId !== 'message_dialog_button_ok') throw new AbortError('Onay penceresinde "Tamam" seçilemedi');
  } catch (e) {
    await abandonDelete(hooks.log);
    throw e;
  }

  hooks.log('info', `Onay penceresi: "${s.messageText}" — Tamam'a basılıyor`);
  await press([KEY.CENTER], 2000);
  for (let poll = 0; poll < 20; poll++) {
    s = await dumpScreen();
    if (s.kind !== 'message' && !(s.kind === 'delete' && (s.deleteCount ?? 0) > 0)) break;
    await sleep(1000);
  }
  hooks.progress({ phase: 'Bitti', done: targets.length, total: targets.length });
  return { deleted: targets.length };
}
