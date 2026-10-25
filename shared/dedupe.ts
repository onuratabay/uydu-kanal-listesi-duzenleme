import type { Channel } from './types.ts';

/** Büyük harf, boşluk ve noktalama olmadan: "TRT 1 HD" → "TRT1HD" */
export const normName = (s: string) => s.toLocaleUpperCase('tr').replace(/[^\p{L}\p{N}]+/gu, '');

/** Kalite eki olmadan kanal adı: "TRT1 HD", "TRT 1", "TRT1" → "TRT1" */
export const baseName = (s: string) => normName(s).replace(/(UHD|FHD|HD|SD|4K)$/, '');

/** 2: UHD/4K, 1: HD/FHD, 0: SD veya eksiz */
export function quality(name: string): number {
  const n = normName(name);
  if (/(UHD|4K)$/.test(n)) return 2;
  if (/(FHD|HD)$/.test(n)) return 1;
  return 0;
}

export interface DuplicateGroup {
  keep: Channel;
  remove: Channel[];
}

/**
 * Aynı kanalın kopyalarını bulur (kalite eki hariç aynı ad). Her grupta şifresiz olan, sonra en
 * yüksek kaliteli olan, eşitlikte `order` içinde önce gelen tutulur; diğerleri silinmek üzere döner.
 */
export function findDuplicates(channels: Channel[], order: number[] = channels.map((c) => c.id)): DuplicateGroup[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const groups = new Map<string, Channel[]>();
  for (const c of channels) {
    const key = baseName(c.name);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const out: DuplicateGroup[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const ranked = [...list].sort(
      (a, b) =>
        Number(!!a.scrambled) - Number(!!b.scrambled) ||
        quality(b.name) - quality(a.name) ||
        (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity),
    );
    out.push({ keep: ranked[0], remove: ranked.slice(1) });
  }
  return out.sort((a, b) => (pos.get(a.keep.id) ?? 0) - (pos.get(b.keep.id) ?? 0));
}
