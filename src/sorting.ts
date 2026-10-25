import type { Channel } from '../shared/types.ts';

const collator = new Intl.Collator('tr', { sensitivity: 'base', numeric: true });

/** Büyük harf, boşluk ve noktalama olmadan: "TRT 1 HD" → "TRT1HD" */
export const normName = (s: string) => s.toLocaleUpperCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');

const QUALITY_SUFFIX = /(UHD|FHD|HD|4K|SD)$/;
const baseName = (s: string) => normName(s).replace(QUALITY_SUFFIX, '');

export const isHd = (name: string) => /(^|[^A-Z])(HD|UHD|FHD|4K)([^A-Z]|$)/i.test(name);
export const isTechnical = (name: string) =>
  /(SSU|TEST|REPLACEMENT|UPDATE|OTA\b|^DT\d|^HM\d|SAGEM)/i.test(name);

export type SortKind = 'name-asc' | 'name-desc' | 'original' | 'hd-first' | 'scrambled-last' | 'technical-last' | 'priority';

export const SORT_LABELS: Record<SortKind, string> = {
  'name-asc': 'İsme göre (A → Z)',
  'name-desc': 'İsme göre (Z → A)',
  original: "TV'deki mevcut sıraya dön",
  'hd-first': 'HD / UHD kanallar önce',
  'scrambled-last': 'Şifreli kanalları sona at',
  'technical-last': 'Test / güncelleme (SSU) kanallarını sona at',
  priority: 'Öncelik listesine göre',
};

export const PRIORITY_PRESET = [
  'TRT 1', 'ATV', 'KANAL D', 'SHOW TV', 'STAR TV', 'NOW', 'TV8', 'KANAL 7', 'BEYAZ TV', 'TV 360',
  'TRT 2', 'TRT HABER', 'NTV', 'CNN TÜRK', 'HABERTÜRK', 'HALK TV', 'SÖZCÜ TV', 'TELE 1', 'A HABER',
  'TGRT HABER', '24', 'ÜLKE TV', 'TRT SPOR', 'TRT SPOR YILDIZ', 'A SPOR', 'TRT ÇOCUK', 'TRT BELGESEL',
  'TRT MÜZİK', 'TRT AVAZ', 'TRT KURDİ', 'TRT WORLD', 'TRT ARABİ',
].join('\n');

/** Bir anahtar kelime kanala uyuyor mu? Sonunda * varsa ön ek olarak eşleşir; HD/UHD eki yok sayılır. */
export function matchesKeyword(name: string, keyword: string): boolean {
  const kw = keyword.trim();
  if (!kw) return false;
  if (kw.endsWith('*')) return normName(name).startsWith(normName(kw.slice(0, -1)));
  return baseName(name) === baseName(kw) || normName(name) === normName(kw);
}

function sortChannels(list: Channel[], kind: SortKind, keywords: string[]): Channel[] {
  const out = [...list];
  switch (kind) {
    case 'name-asc':
      return out.sort((a, b) => collator.compare(a.name, b.name));
    case 'name-desc':
      return out.sort((a, b) => collator.compare(b.name, a.name));
    case 'original':
      return out.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));
    case 'hd-first':
      return out.sort((a, b) => Number(isHd(b.name)) - Number(isHd(a.name)));
    case 'scrambled-last':
      return out.sort((a, b) => Number(!!a.scrambled) - Number(!!b.scrambled));
    case 'technical-last':
      return out.sort((a, b) => Number(isTechnical(a.name)) - Number(isTechnical(b.name)));
    case 'priority': {
      const rank = (c: Channel) => {
        const i = keywords.findIndex((k) => matchesKeyword(c.name, k));
        return i < 0 ? Infinity : i;
      };
      return out.sort((a, b) => rank(a) - rank(b));
    }
  }
}

/**
 * Sıralamayı tüm listeye ya da yalnızca seçili kanallara uygular.
 * Seçim varsa: seçili kanallar kendi aralarında sıralanır ve yine kendi konumlarına yerleşir.
 */
export function applySort(
  order: number[],
  byId: Map<number, Channel>,
  kind: SortKind,
  opts: { onlyIds?: Set<number>; keywords?: string[] } = {},
): number[] {
  const keywords = opts.keywords ?? [];
  if (!opts.onlyIds?.size) return sortChannels(order.map((id) => byId.get(id)!), kind, keywords).map((c) => c.id);
  const slots = order.map((id, i) => (opts.onlyIds!.has(id) ? i : -1)).filter((i) => i >= 0);
  const sorted = sortChannels(slots.map((i) => byId.get(order[i])!), kind, keywords);
  const out = [...order];
  slots.forEach((slot, k) => (out[slot] = sorted[k].id));
  return out;
}

/** `ids` kümesini (mevcut göreli sıralarıyla) kalan listede `insertAt` konumuna taşır. */
export function moveBlock(order: number[], ids: Set<number>, insertAt: number): number[] {
  const block = order.filter((id) => ids.has(id));
  const rest = order.filter((id) => !ids.has(id));
  const at = Math.max(0, Math.min(insertAt, rest.length));
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/** Seçili kanalları birer konum yukarı/aşağı kaydırır. */
export function nudge(order: number[], ids: Set<number>, dir: -1 | 1): number[] {
  const out = [...order];
  const idx = out.map((id, i) => (ids.has(id) ? i : -1)).filter((i) => i >= 0);
  if (dir === 1) idx.reverse();
  for (const i of idx) {
    const j = i + dir;
    if (j < 0 || j >= out.length || ids.has(out[j])) continue;
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** CSV/JSON içe aktarımından sıra oluşturur: önce kanal_id, yoksa ada göre eşleştirir. */
export function orderFromImport(
  entries: { id?: number; name?: string }[],
  channels: Channel[],
): { order: number[]; matched: number; unmatched: string[] } {
  const remaining = new Map(channels.map((c) => [c.id, c]));
  const order: number[] = [];
  const unmatched: string[] = [];
  for (const e of entries) {
    let hit: Channel | undefined = e.id !== undefined ? remaining.get(e.id) : undefined;
    if (!hit && e.name) hit = [...remaining.values()].find((c) => normName(c.name) === normName(e.name!));
    if (hit) {
      order.push(hit.id);
      remaining.delete(hit.id);
    } else if (e.name || e.id !== undefined) {
      unmatched.push(e.name ?? String(e.id));
    }
  }
  const matched = order.length;
  for (const c of channels) if (remaining.has(c.id)) order.push(c.id);
  return { order, matched, unmatched };
}

export function parseImport(text: string): { id?: number; name?: string }[] {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) return data.map((x) => (typeof x === 'number' ? { id: x } : { id: x.id, name: x.name }));
    if (Array.isArray(data.order)) return data.order.map((id: number) => ({ id }));
    if (Array.isArray(data.channels)) return data.channels.map((c: { id: number; name: string }) => ({ id: c.id, name: c.name }));
    throw new Error('JSON biçimi tanınmadı');
  }
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  const sep = lines[0].includes(';') ? ';' : lines[0].includes(',') ? ',' : '\t';
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const idCol = header.findIndex((h) => h === 'kanal_id' || h === 'id');
  const nameCol = header.findIndex((h) => h === 'kanal_adi' || h === 'name' || h === 'ad');
  if (idCol < 0 && nameCol < 0) return lines.map((l) => ({ name: l.trim() }));
  return lines.slice(1).map((line) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const id = idCol >= 0 && cells[idCol] ? Number(cells[idCol]) : undefined;
    return { id: Number.isFinite(id) ? id : undefined, name: nameCol >= 0 ? cells[nameCol] : undefined };
  });
}
