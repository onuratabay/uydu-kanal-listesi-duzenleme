/** Tek bir TV kanalı. `id`, Android TvProvider'daki kanal satırının _id değeridir. */
export interface Channel {
  id: number;
  name: string;
  /** TV'deki görünen kanal numarası (display_number). Bilinmiyorsa null. */
  number: number | null;
  /**
   * exact    : numara sorgusu kanalı doğrudan döndürdü
   * inferred : kanal adı numarayı içerdiği için eleme yöntemiyle bulundu
   * unknown  : numara tespit edilemedi
   */
  numberSource: 'exact' | 'inferred' | 'unknown';
  /** TV ekranındaki kilit ikonundan okunur. undefined: henüz ekrandan taranmadı. */
  scrambled?: boolean;
}

export interface ChannelSnapshot {
  readAt: string;
  device: string;
  /** Şifreli bilgisinin TV ekranından en son okunduğu zaman. */
  scrambledCheckedAt?: string;
  /** Numaraya göre artan sırada. Numarası bilinmeyenler sondadır. */
  channels: Channel[];
  warnings: string[];
}

/** TV'deki "Kanalları yeniden düzenle" ekranında tek bir taşıma işlemi. */
export interface Move {
  channelId: number;
  name: string;
  fromIndex: number;
  toIndex: number;
  /** Numara diyaloğuna yazılacak hedef kanal numarası. */
  toNumber: number;
}

export type JobKind = 'read' | 'scan' | 'apply' | 'delete';
export type JobState = 'idle' | 'running' | 'paused' | 'stopping' | 'done' | 'error' | 'stopped';

export interface JobStatus {
  kind: JobKind | null;
  state: JobState;
  phase: string;
  done: number;
  total: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  current?: Move | null;
}

export interface LogEntry {
  at: string;
  level: 'info' | 'warn' | 'error' | 'ok';
  text: string;
}

export interface ScreenRowInfo {
  number: string;
  name: string;
  scrambled: boolean;
}

export interface ScreenSummary {
  activity: string;
  kind: 'rearrange' | 'delete' | 'dialog' | 'message' | 'other';
  title: string;
  moving: boolean;
  rows: ScreenRowInfo[];
  focusedNumber: string | null;
  /** "Kanalları sil" ekranında işaretli kanal sayısı. */
  deleteCount: number | null;
}

export interface BackupInfo {
  file: string;
  readAt: string;
  count: number;
  label: string;
}

export interface ScanResult {
  scannedAt: string;
  rows: ScreenRowInfo[];
  matchesSnapshot: boolean;
  differences: string[];
}

export type ServerEvent =
  | { type: 'job'; status: JobStatus }
  | { type: 'log'; entry: LogEntry }
  | { type: 'snapshot'; snapshot: ChannelSnapshot }
  | { type: 'scan'; result: ScanResult };
