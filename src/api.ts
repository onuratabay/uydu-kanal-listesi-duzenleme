import type { BackupInfo, ChannelSnapshot, JobStatus, Move, ScanResult, ScreenSummary, ServerEvent } from '../shared/types.ts';

export interface DeviceInfo {
  connected: boolean;
  serial: string;
  model: string;
  android: string;
  activity: string;
  error?: string;
}

export interface PlanResult {
  count: number;
  moves: Move[];
  estimatedSeconds: number;
  unknownNumbers: number;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const post = <T>(url: string, body?: unknown) =>
  call<T>(url, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  status: () => call<{ device: DeviceInfo; job: JobStatus; hasSnapshot: boolean }>('/api/status'),
  snapshot: () => call<ChannelSnapshot>('/api/snapshot'),
  read: () => post('/api/read'),
  screen: () => call<ScreenSummary>('/api/screen'),
  scan: () => post('/api/scan'),
  lastScan: () => call<ScanResult | null>('/api/scan'),
  releaseMove: () => post('/api/release-move'),
  plan: (order: number[]) => post<PlanResult>('/api/plan', { order }),
  apply: (order: number[], opts: { maxMoves?: number; verifyScan: boolean }) =>
    post('/api/apply', { order, ...opts, confirm: true }),
  remove: (removeIds: number[]) => post('/api/delete', { removeIds, confirm: true }),
  pause: () => post('/api/job/pause'),
  resume: () => post('/api/job/resume'),
  stop: () => post('/api/job/stop'),
  backups: () => call<BackupInfo[]>('/api/backups'),
  backup: (file: string) => call<ChannelSnapshot & { order?: number[] }>(`/api/backups/${encodeURIComponent(file)}`),
  draft: () => call<{ basedOn: string; order: number[] } | null>('/api/draft'),
  saveDraft: (basedOn: string, order: number[]) =>
    call('/api/draft', { method: 'PUT', body: JSON.stringify({ basedOn, order }) }),
};

export function subscribe(onEvent: (ev: ServerEvent) => void): () => void {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => onEvent(JSON.parse(m.data) as ServerEvent);
  return () => es.close();
}
