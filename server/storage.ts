import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfo, ChannelSnapshot, Move } from '../shared/types.ts';

const ROOT = process.cwd();
export const BACKUP_DIR = path.join(ROOT, 'backups');
const DATA_DIR = path.join(ROOT, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'taslak.json');
const SAFE_NAME = /^kanal-(yedek|hedef)-[\w.-]+\.json$/;

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function toCsv(snapshot: ChannelSnapshot, order?: number[]): string {
  const byId = new Map(snapshot.channels.map((c) => [c.id, c]));
  const list = order ? order.map((id) => byId.get(id)!).filter(Boolean) : snapshot.channels;
  const esc = (s: string) => (/[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = ['sira;mevcut_numara;kanal_adi;kanal_id;numara_kaynagi'];
  list.forEach((c, i) => lines.push([i + 1, c.number ?? '', esc(c.name), c.id, c.numberSource].join(';')));
  return '﻿' + lines.join('\n') + '\n';
}

/** Okunan listeyi (veya hedef sırayı) JSON + CSV olarak kaydeder. */
export async function saveBackup(snapshot: ChannelSnapshot, kind: 'yedek' | 'hedef', order?: number[]): Promise<string> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const base = `kanal-${kind}-${stamp()}`;
  const body = kind === 'hedef' ? { ...snapshot, order } : snapshot;
  await writeFile(path.join(BACKUP_DIR, `${base}.json`), JSON.stringify(body, null, 2), 'utf8');
  await writeFile(path.join(BACKUP_DIR, `${base}.csv`), toCsv(snapshot, order), 'utf8');
  return `${base}.json`;
}

export async function listBackups(): Promise<BackupInfo[]> {
  await mkdir(BACKUP_DIR, { recursive: true });
  const files = (await readdir(BACKUP_DIR)).filter((f) => SAFE_NAME.test(f)).sort().reverse();
  const out: BackupInfo[] = [];
  for (const file of files) {
    try {
      const data = JSON.parse(await readFile(path.join(BACKUP_DIR, file), 'utf8')) as ChannelSnapshot & { order?: number[] };
      out.push({
        file,
        readAt: data.readAt,
        count: data.order?.length ?? data.channels.length,
        label: file.startsWith('kanal-hedef') ? 'TV\'ye uygulanan hedef sıra' : 'TV\'den okunan liste',
      });
    } catch {
      // bozuk dosyaları listede gösterme
    }
  }
  return out;
}

export async function loadBackup(file: string): Promise<ChannelSnapshot & { order?: number[] }> {
  if (!SAFE_NAME.test(file)) throw new Error('Geçersiz yedek adı');
  return JSON.parse(await readFile(path.join(BACKUP_DIR, file), 'utf8'));
}

export async function latestSnapshot(): Promise<ChannelSnapshot | null> {
  const first = (await listBackups()).find((b) => b.file.startsWith('kanal-yedek'));
  return first ? loadBackup(first.file) : null;
}

export interface Draft {
  basedOn: string;
  order: number[];
  savedAt: string;
}

export async function saveDraft(d: Omit<Draft, 'savedAt'>): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DRAFT_FILE, JSON.stringify({ ...d, savedAt: new Date().toISOString() }, null, 2), 'utf8');
}

export async function loadDraft(): Promise<Draft | null> {
  try {
    return JSON.parse(await readFile(DRAFT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Her başarılı taşıma tek satır olarak günlüğe yazılır (yarıda kalan işlemleri izlemek için). */
export function createJournal(): (move: Move) => Promise<void> {
  const file = path.join(DATA_DIR, `islem-gunlugu-${stamp()}.jsonl`);
  return async (move) => {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(file, JSON.stringify({ at: new Date().toISOString(), ...move }) + '\n', 'utf8');
  };
}

/** TV'den silinecek kanalların listesi, silmeden önce kaydedilir (geri kurulum için başvuru). */
export async function saveDeletionList(channels: { id: number; number: number | null; name: string }[]): Promise<string> {
  await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `silinen-kanallar-${stamp()}.json`);
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), channels }, null, 2), 'utf8');
  return path.relative(ROOT, file);
}
