/**
 * Kanal listesini root gerektirmeden okur.
 *
 * TvProvider ve MediaTek veritabanları izinle korunuyor; ancak LiveTV'nin sistem arama
 * sağlayıcısı (com.mitv.livetv.system_search) izinsiz dışa açık ve şu filtreyle arıyor:
 *   displayNumber == sorgu  VEYA  ad/açıklama sorguyu içeriyor (büyük/küçük harf duyarsız)
 * Sonuç satırları kanal adını ve TvProvider _id değerini veriyor (numarayı vermiyor).
 * Bu yüzden her numara (1, 2, 3, ...) tek tek sorgulanır: adında o numara geçmeyen bir
 * kanal dönerse, o kanalın numarası budur. Adı kendi numarasını içeren kanallar eleme
 * yöntemiyle çözülür. Bu işlem salt okumadır, TV'de hiçbir şeyi değiştirmez.
 */
import type { Channel, ChannelSnapshot } from '../shared/types.ts';
import { runScript, sleep } from './adb.ts';

const SEARCH_URI = 'content://com.mitv.livetv.system_search/search_suggest_query/';
const ROW_RX =
  /^Q(\d+)\|Row: \d+ suggest_text_1=(.*?), suggest_text_2=(.*?), suggest_result_card_image=.*?suggest_intent_data=content:\/\/android\.media\.tv\/channel\/(\d+),/;

export interface SearchRow {
  tag: number;
  name: string;
  description: string;
  id: number;
}

export function parseSearchOutput(out: string): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const line of out.split('\n')) {
    const m = ROW_RX.exec(line);
    if (!m) continue;
    const description = m[3] === 'NULL' ? '' : m[3];
    rows.push({ tag: Number(m[1]), name: m[2], description, id: Number(m[4]) });
  }
  return rows;
}

export function buildQueryScript(terms: readonly string[], parallel: number): string {
  const lines: string[] = [];
  terms.forEach((term, i) => {
    const uri = `${SEARCH_URI}${encodeURIComponent(term)}?limit=100000&action=2`;
    lines.push(`(content query --uri "${uri}" 2>&1 | sed "s/^/Q${i}|/") &`);
    if ((i + 1) % parallel === 0) lines.push('wait');
  });
  lines.push('wait');
  return lines.join('\n') + '\n';
}

/** Terimleri TV'de paralel sorgular; terim → satırlar. */
async function search(terms: readonly string[], parallel = 12): Promise<Map<string, SearchRow[]>> {
  const out = await runScript(buildQueryScript(terms, parallel));
  const result = new Map<string, SearchRow[]>(terms.map((t) => [t, []]));
  for (const row of parseSearchOutput(out)) result.get(terms[row.tag])?.push(row);
  return result;
}

const contains = (haystack: string, needle: string) => haystack.toLowerCase().includes(needle.toLowerCase());

export interface Resolution {
  channels: Channel[];
  warnings: string[];
}

/**
 * numberResults: numara → o numara sorgusunun satırları.
 * extraRows: harf sorgularından gelen ek satırlar (numara taramasında görünmeyen kanalları yakalamak için).
 */
export function resolveNumbers(numberResults: ReadonlyMap<number, SearchRow[]>, extraRows: readonly SearchRow[] = []): Resolution {
  const warnings: string[] = [];
  const names = new Map<number, string>();
  const exactByNumber = new Map<number, Set<number>>();
  const candidates = new Map<number, Set<number>>();

  for (const [n, rows] of numberResults) {
    const term = String(n);
    for (const row of rows) {
      names.set(row.id, row.name);
      if (contains(row.name, term) || contains(row.description, term)) {
        if (!candidates.has(row.id)) candidates.set(row.id, new Set());
        candidates.get(row.id)!.add(n);
      } else {
        if (!exactByNumber.has(n)) exactByNumber.set(n, new Set());
        exactByNumber.get(n)!.add(row.id);
      }
    }
  }
  for (const row of extraRows) if (!names.has(row.id)) names.set(row.id, row.name);

  const numberOf = new Map<number, { number: number; source: Channel['numberSource'] }>();
  const used = new Set<number>();
  for (const [n, ids] of [...exactByNumber].sort((a, b) => a[0] - b[0])) {
    if (ids.size > 1) {
      warnings.push(`${n} numarasını birden fazla kanal kullanıyor: ${[...ids].map((i) => names.get(i)).join(', ')}`);
    }
    for (const id of ids) {
      const prev = numberOf.get(id);
      if (prev) {
        warnings.push(`"${names.get(id)}" hem ${prev.number} hem ${n} numarasıyla eşleşti; ${prev.number} kullanıldı`);
        continue;
      }
      numberOf.set(id, { number: n, source: 'exact' });
      used.add(n);
    }
  }

  // Adı kendi numarasını içeren kanallar: aday numaralardan kullanılmayan tek numara kalana kadar ele.
  // Aynı tek adayı birden fazla kanal paylaşıyorsa hiçbiri atanmaz (keyfi seçim yapılmaz).
  let progressed = true;
  while (progressed) {
    progressed = false;
    const claims = new Map<number, number[]>();
    for (const [id, cands] of candidates) {
      if (numberOf.has(id)) continue;
      const free = [...cands].filter((n) => !used.has(n));
      if (free.length === 1) claims.set(free[0], [...(claims.get(free[0]) ?? []), id]);
    }
    for (const [n, ids] of claims) {
      if (ids.length !== 1) continue;
      numberOf.set(ids[0], { number: n, source: 'inferred' });
      used.add(n);
      progressed = true;
    }
  }

  const channels: Channel[] = [];
  for (const [id, name] of names) {
    const found = numberOf.get(id);
    if (found) {
      channels.push({ id, name, number: found.number, numberSource: found.source });
      continue;
    }
    channels.push({ id, name, number: null, numberSource: 'unknown' });
    const free = [...(candidates.get(id) ?? [])].filter((n) => !used.has(n));
    warnings.push(
      free.length
        ? `"${name}" kanalının numarası kesinleşmedi (olası: ${free.join(', ')})`
        : `"${name}" kanalının numarası bulunamadı`,
    );
  }
  channels.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity) || a.id - b.id);
  return { channels, warnings };
}

export interface ReadProgress {
  phase: string;
  done: number;
  total: number;
}

export async function readChannels(device: string, onProgress: (p: ReadProgress) => void): Promise<ChannelSnapshot> {
  onProgress({ phase: 'LiveTV arama servisi hazırlanıyor', done: 0, total: 1 });
  let warm = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    warm = (await search(['a'], 1)).get('a')!.length;
    if (warm > 0) break;
    await sleep(3000);
  }
  if (warm === 0) {
    throw new Error("LiveTV kanal listesi boş döndü. TV'de Canlı TV uygulamasını bir kez açıp tekrar deneyin.");
  }

  const numberResults = new Map<number, SearchRow[]>();
  const CHUNK = 60;
  const GAP = 120;
  let maxSeen = 0;
  for (let start = 1; start <= Math.min(maxSeen + GAP, 9999); start += CHUNK) {
    const nums = Array.from({ length: CHUNK }, (_, i) => start + i);
    const res = await search(nums.map(String));
    for (const n of nums) {
      const rows = res.get(String(n)) ?? [];
      numberResults.set(n, rows);
      if (rows.some((r) => !contains(r.name, String(n)) && !contains(r.description, String(n)))) maxSeen = Math.max(maxSeen, n);
    }
    onProgress({ phase: 'Kanal numaraları taranıyor', done: start + CHUNK - 1, total: Math.max(maxSeen + GAP, start + CHUNK - 1) });
  }

  // Güvenlik ağı: numara taramasında görünmeyen kanal var mı? (ör. çok büyük numaralı kanallar)
  const seenIds = new Set([...numberResults.values()].flat().map((r) => r.id));
  const chars = new Set('abcdefghijklmnopqrstuvwxyz'.split(''));
  for (const rows of numberResults.values()) {
    for (const r of rows) for (const ch of r.name.toLowerCase()) if (/\p{L}/u.test(ch)) chars.add(ch);
  }
  onProgress({ phase: 'Eksik kanal kontrolü (harf taraması)', done: 0, total: chars.size });
  const charResults = await search([...chars]);
  const extraRows = [...charResults.values()].flat().filter((r) => !seenIds.has(r.id));

  const { channels, warnings } = resolveNumbers(numberResults, extraRows);
  onProgress({ phase: 'Tamamlandı', done: 1, total: 1 });
  return { readAt: new Date().toISOString(), device, channels, warnings };
}
