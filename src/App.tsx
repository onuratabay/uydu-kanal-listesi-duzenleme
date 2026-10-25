import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { BackupInfo, ChannelSnapshot, JobStatus, LogEntry, ScanResult } from '../shared/types.ts';
import { minimumMoves } from '../shared/planner.ts';
import { api, subscribe, type DeviceInfo } from './api.ts';
import { ApplyModal } from './ApplyModal.tsx';
import { DeleteModal } from './DeleteModal.tsx';
import { findDuplicates } from '../shared/dedupe.ts';
import { ChannelList, type RowData } from './ChannelList.tsx';
import {
  applySort, moveBlock, normName, nudge, orderFromImport, parseImport, PRIORITY_PRESET, SORT_LABELS, type SortKind,
} from './sorting.ts';

const IDLE_JOB: JobStatus = {
  kind: null, state: 'idle', phase: '', done: 0, total: 0, message: '', startedAt: null, finishedAt: null, current: null,
};
const SECONDS_PER_MOVE = 30;
const JOB_TITLES = { read: "TV'den okuma", scan: 'Ekrandan doğrulama', apply: "TV'ye uygulama", delete: "TV'den silme" } as const;
const STATE_LABELS: Record<JobStatus['state'], string> = {
  idle: 'Boşta', running: 'Çalışıyor', paused: 'Duraklatıldı', stopping: 'Durduruluyor…',
  done: 'Tamamlandı', error: 'Hata', stopped: 'Durduruldu',
};

const sameOrder = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const isPermutation = (order: number[], ids: number[]) =>
  order.length === ids.length && new Set(order).size === order.length && ids.every((id) => order.includes(id));

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function formatDuration(sec: number) {
  if (sec < 60) return `${Math.round(sec)} sn`;
  const m = Math.round(sec / 60);
  return m < 60 ? `~${m} dk` : `~${Math.floor(m / 60)} sa ${m % 60} dk`;
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function App() {
  const [snapshot, setSnapshot] = useState<ChannelSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [order, setOrder] = useState<number[]>([]);
  const [past, setPast] = useState<number[][]>([]);
  const [future, setFuture] = useState<number[][]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [job, setJob] = useState<JobStatus>(IDLE_JOB);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' | 'error' } | null>(null);
  const [modal, setModal] = useState<null | 'apply' | 'priority' | 'delete'>(null);
  /** Çift kanal temizliğinde TV'den silinmek üzere işaretlenen kanallar. */
  const [removal, setRemoval] = useState<Set<number>>(new Set());
  const [onlySelected, setOnlySelected] = useState(false);
  const [hideScrambled, setHideScrambled] = useState(() => {
    try {
      return localStorage.getItem('tvkm-hide-scrambled') !== '0';
    } catch {
      return true;
    }
  });
  const [gotoNumber, setGotoNumber] = useState('');
  const [priorityText, setPriorityText] = useState(() => {
    try {
      return localStorage.getItem('tvkm-priority') ?? PRIORITY_PRESET;
    } catch {
      return PRIORITY_PRESET;
    }
  });
  const anchor = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const orderRef = useRef(order);
  orderRef.current = order;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const notify = useCallback((text: string, kind: 'ok' | 'warn' | 'error' = 'ok') => {
    setToast({ text, kind });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 5000);
  }, []);

  const commit = useCallback((next: number[]) => {
    const prev = orderRef.current;
    if (sameOrder(prev, next)) return;
    setPast((p) => [...p.slice(-99), prev]);
    setFuture([]);
    setOrder(next);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      setFuture((f) => [orderRef.current, ...f]);
      setOrder(p[p.length - 1]);
      return p.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setPast((p) => [...p, orderRef.current]);
      setOrder(f[0]);
      return f.slice(1);
    });
  }, []);

  const snapshotRef = useRef<ChannelSnapshot | null>(null);

  /**
   * Yeni bir TV okuması geldiğinde hedef sıra, kullanıcı düzenleme yapmadıysa TV'nin güncel sırasına
   * sıfırlanır; aksi hâlde eski TV sırası yanlışlıkla "hedef" olarak kalır ve uygulanırsa TV'yi geri alır.
   */
  const adoptSnapshot = useCallback((snap: ChannelSnapshot, draft?: { basedOn: string; order: number[] } | null) => {
    const ids = snap.channels.map((c) => c.id);
    const prev = snapshotRef.current;
    snapshotRef.current = snap;
    setSnapshot(snap);
    const current = orderRef.current;
    let next = ids;
    if (draft) {
      if (draft.basedOn === snap.readAt && isPermutation(draft.order, ids)) next = draft.order;
    } else if (prev && !isPermutation(current, ids) && ids.every((id) => current.includes(id))) {
      // Kanal silindiyse hedef sıra korunur, yalnızca silinenler çıkarılır.
      next = current.filter((id) => ids.includes(id));
    } else if (prev && isPermutation(current, ids)) {
      const prevBaseline = prev.channels.map((c) => c.id);
      const edited = !sameOrder(current, prevBaseline);
      if (prev.readAt === snap.readAt || edited) next = current;
      if (prev.readAt !== snap.readAt && edited) {
        setToast({ text: 'Yeni okuma yüklendi; yaptığınız düzenlemeler korundu', kind: 'warn' });
      }
    }
    setOrder(next);
    setSelected((s) => new Set([...s].filter((id) => ids.includes(id))));
    setRemoval((s) => new Set([...s].filter((id) => ids.includes(id))));
  }, []);

  const refreshBackups = useCallback(() => api.backups().then(setBackups).catch(() => undefined), []);

  // İlk yükleme
  useEffect(() => {
    void (async () => {
      const [snap, draft] = await Promise.all([api.snapshot().catch(() => null), api.draft().catch(() => null)]);
      if (snap) adoptSnapshot(snap, draft ?? { basedOn: '', order: [] });
      setLoaded(true);
      refreshBackups();
      api.lastScan().then(setScan).catch(() => undefined);
    })();
  }, [adoptSnapshot, refreshBackups]);

  // Sunucu olayları
  useEffect(
    () =>
      subscribe((ev) => {
        if (ev.type === 'job') setJob(ev.status);
        else if (ev.type === 'log') setLogs((l) => [...l.slice(-299), ev.entry]);
        else if (ev.type === 'snapshot') {
          adoptSnapshot(ev.snapshot);
          refreshBackups();
        } else if (ev.type === 'scan') setScan(ev.result);
      }),
    [adoptSnapshot, refreshBackups],
  );

  const busy = job.state === 'running' || job.state === 'paused' || job.state === 'stopping';

  // Cihaz durumu
  useEffect(() => {
    let alive = true;
    const poll = () => api.status().then((s) => alive && setDevice(s.device)).catch(() => alive && setDevice(null));
    poll();
    const t = window.setInterval(() => !busy && poll(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [busy]);

  // İş bitince bildirim
  const lastState = useRef(job.state);
  useEffect(() => {
    if (lastState.current !== job.state && ['done', 'error', 'stopped'].includes(job.state) && job.message) {
      notify(job.message, job.state === 'done' ? 'ok' : job.state === 'error' ? 'error' : 'warn');
    }
    lastState.current = job.state;
  }, [job.state, job.message, notify]);

  // Taslağı sunucuya kaydet
  useEffect(() => {
    if (!snapshot || !order.length) return;
    const t = window.setTimeout(() => void api.saveDraft(snapshot.readAt, order).catch(() => undefined), 800);
    return () => window.clearTimeout(t);
  }, [order, snapshot]);

  useEffect(() => {
    try {
      localStorage.setItem('tvkm-priority', priorityText);
      localStorage.setItem('tvkm-hide-scrambled', hideScrambled ? '1' : '0');
    } catch {
      // tarayıcı depolaması kapalıysa bu tercihler yalnızca bu oturumda kalır
    }
  }, [priorityText, hideScrambled]);

  const byId = useMemo(() => new Map((snapshot?.channels ?? []).map((c) => [c.id, c])), [snapshot]);
  const baseline = useMemo(() => (snapshot?.channels ?? []).map((c) => c.id), [snapshot]);
  const numbers = useMemo(() => (snapshot?.channels ?? []).map((c) => c.number), [snapshot]);

  const rows: RowData[] = useMemo(
    () =>
      order.map((id, i) => {
        const c = byId.get(id)!;
        return {
          id, name: c.name, index: i, newNumber: numbers[i] ?? null, oldNumber: c.number,
          numberSource: c.numberSource, scrambled: c.scrambled, removing: removal.has(id),
        };
      }),
    [order, byId, numbers, removal],
  );

  const duplicateGroups = useMemo(() => (snapshot ? findDuplicates(snapshot.channels, order) : []), [snapshot, order]);
  const scrambledKnown = !!snapshot?.scrambledCheckedAt;
  const scrambledCount = useMemo(() => (snapshot?.channels ?? []).filter((c) => c.scrambled).length, [snapshot]);
  const hiding = hideScrambled && scrambledKnown;

  const visibleRows = useMemo(() => {
    const base = hiding ? rows.filter((r) => !r.scrambled) : rows;
    const q = query.trim();
    if (!q) return base;
    const nq = normName(q);
    return base.filter((r) => (nq && normName(r.name).includes(nq)) || String(r.newNumber) === q || String(r.oldNumber) === q);
  }, [rows, query, hiding]);
  const visibleRef = useRef(visibleRows);
  visibleRef.current = visibleRows;

  const changedCount = useMemo(() => order.filter((id, i) => id !== baseline[i]).length, [order, baseline]);
  const moveCount = useMemo(() => (order.length === baseline.length ? minimumMoves(baseline, order) : 0), [order, baseline]);
  const unknownCount = snapshot?.channels.filter((c) => c.number === null).length ?? 0;

  // Seçim
  const rangeIds = (from: number, to: number) => {
    const ids = visibleRef.current.map((r) => r.id);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  };
  const onRowClick = useCallback((id: number, e: MouseEvent) => {
    setSelected((s) => {
      if (e.shiftKey && anchor.current !== null) {
        return new Set([...(e.metaKey || e.ctrlKey ? s : []), ...rangeIds(anchor.current, id)]);
      }
      anchor.current = id;
      if (e.metaKey || e.ctrlKey) {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }
      return s.size === 1 && s.has(id) ? new Set() : new Set([id]);
    });
  }, []);
  const onToggle = useCallback((id: number, e: MouseEvent) => {
    setSelected((s) => {
      if (e.shiftKey && anchor.current !== null) return new Set([...s, ...rangeIds(anchor.current, id)]);
      anchor.current = id;
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const onDragEnd = useCallback(
    (activeId: number, overId: number) => {
      const cur = orderRef.current;
      const sel = selectedRef.current;
      const moving = sel.has(activeId) ? sel : new Set([activeId]);
      if (moving.has(overId)) return;
      const rest = cur.filter((id) => !moving.has(id));
      const overIdx = rest.indexOf(overId);
      const insertAt = cur.indexOf(activeId) < cur.indexOf(overId) ? overIdx + 1 : overIdx;
      commit(moveBlock(cur, moving, insertAt));
    },
    [commit],
  );

  // Toplu işlemler
  const requireSelection = () => {
    if (!selected.size) {
      notify('Önce en az bir kanal seçin', 'warn');
      return false;
    }
    return true;
  };
  const toTop = () => requireSelection() && commit(moveBlock(order, selected, 0));
  const toBottom = () => requireSelection() && commit(moveBlock(order, selected, order.length));
  const step = (dir: -1 | 1) => requireSelection() && commit(nudge(order, selected, dir));
  const toNumber = () => {
    if (!requireSelection()) return;
    const n = Number(gotoNumber);
    if (!Number.isInteger(n) || n < 1) return notify('Geçerli bir kanal numarası yazın', 'warn');
    let k = numbers.findIndex((x) => x !== null && x >= n);
    if (k < 0) k = order.length;
    commit(moveBlock(order, selected, k));
    const landed = numbers[Math.min(k, order.length - selected.size)];
    if (landed !== n) notify(`${n} numarası listede yok; seçim ${landed} numarasından başlatıldı`, 'warn');
  };
  const runSort = (kind: SortKind) => {
    if (onlySelected && !requireSelection()) return;
    const keywords = priorityText.split('\n').map((s) => s.trim()).filter(Boolean);
    commit(applySort(order, byId, kind, { onlyIds: onlySelected ? selected : undefined, keywords }));
    notify(`${SORT_LABELS[kind]} uygulandı${onlySelected ? ' (yalnızca seçililer)' : ''}`);
  };
  const selectAllVisible = () => setSelected(new Set(visibleRef.current.map((r) => r.id)));
  const markDuplicates = () => {
    const ids = duplicateGroups.flatMap((g) => g.remove.map((c) => c.id));
    setRemoval(new Set(ids));
    notify(ids.length ? `${duplicateGroups.length} çift grupta ${ids.length} kopya silinmek üzere işaretlendi` : 'Çift kanal bulunamadı', ids.length ? 'ok' : 'warn');
  };

  // Klavye kısayolları
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (modal) setModal(null);
        else setSelected(new Set());
        return;
      }
      if (typing || modal) return;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAllVisible();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedRef.current.size) {
        e.preventDefault();
        commit(nudge(orderRef.current, selectedRef.current, e.key === 'ArrowUp' ? -1 : 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal, undo, redo, commit]);

  // İçe / dışa aktarma
  const exportCsv = () => {
    const lines = ['sira;yeni_numara;kanal_adi;kanal_id;eski_numara;sifreli'];
    rows.forEach((r, i) =>
      lines.push(
        [i + 1, r.newNumber ?? '', `"${r.name.replace(/"/g, '""')}"`, r.id, r.oldNumber ?? '', r.scrambled === undefined ? '' : r.scrambled ? 'evet' : 'hayir'].join(';'),
      ),
    );
    download('kanal-sirasi.csv', '﻿' + lines.join('\n') + '\n', 'text/csv;charset=utf-8');
  };
  const exportJson = () => {
    const body = { readAt: snapshot?.readAt, order, channels: rows.map((r) => ({ id: r.id, name: r.name, newNumber: r.newNumber, oldNumber: r.oldNumber })) };
    download('kanal-sirasi.json', JSON.stringify(body, null, 2), 'application/json');
  };
  const importFile = async (file: File) => {
    if (!snapshot) return;
    try {
      const { order: next, matched, unmatched } = orderFromImport(parseImport(await file.text()), snapshot.channels);
      commit(next);
      notify(
        `${matched} kanal içe aktarılan sıraya göre dizildi${unmatched.length ? `, ${unmatched.length} satır eşleşmedi` : ''}; kalanlar sona eklendi`,
        unmatched.length ? 'warn' : 'ok',
      );
    } catch (e) {
      notify(`İçe aktarılamadı: ${(e as Error).message}`, 'error');
    }
  };
  const loadBackupOrder = async (b: BackupInfo) => {
    if (!snapshot) return;
    try {
      const data = await api.backup(b.file);
      const byIdOld = new Map(data.channels.map((c) => [c.id, c]));
      const entries = (data.order ?? data.channels.map((c) => c.id)).map((id) => ({ id, name: byIdOld.get(id)?.name }));
      const { order: next, matched, unmatched } = orderFromImport(entries, snapshot.channels);
      commit(next);
      notify(`Yedekteki sıra yüklendi (${matched} kanal${unmatched.length ? `, ${unmatched.length} eşleşmedi` : ''})`, unmatched.length ? 'warn' : 'ok');
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };

  const startRead = () => api.read().catch((e) => notify((e as Error).message, 'error'));
  const startScan = () => api.scan().catch((e) => notify((e as Error).message, 'error'));

  const progressPct = job.total > 0 ? Math.min(100, (job.done / job.total) * 100) : busy ? undefined : 100;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="2" y="4" width="20" height="13" rx="2.5" fill="currentColor" />
            <rect x="8" y="19" width="8" height="2" rx="1" fill="currentColor" />
          </svg>
          <div>
            <h1>TV Kanal Yöneticisi</h1>
            <p>Xiaomi TV · uydu kanal listesi</p>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`pill ${device?.connected ? 'ok' : 'bad'}`} title={device?.error ?? device?.activity}>
            <i />
            {device === null ? 'Kontrol ediliyor…' : device.connected ? `${device.model} · ${device.serial}` : 'TV bağlı değil'}
          </span>
          <button className="btn primary" onClick={startRead} disabled={busy || !device?.connected}>
            {snapshot ? "TV'den yeniden oku" : "TV'den oku"}
          </button>
        </div>
      </header>

      {!loaded ? (
        <div className="center muted">Yükleniyor…</div>
      ) : !snapshot ? (
        <section className="welcome card">
          <h2>Kanal listesini okuyarak başlayın</h2>
          <p>
            Okuma, TV'deki LiveTV uygulamasının arama servisinden yapılır ve <b>salt okumadır</b>: TV'de hiçbir şey
            değişmez. 370 kanal için yaklaşık 3–4 dakika sürer ve sonuç otomatik olarak <code>backups/</code> klasörüne
            yedeklenir.
          </p>
          <button className="btn primary big" onClick={startRead} disabled={busy || !device?.connected}>
            TV'den oku
          </button>
          {busy && <JobCard job={job} pct={progressPct} />}
        </section>
      ) : (
        <main className="layout">
          <section className="card list-card">
            <div className="toolbar">
              <div className="search">
                <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M13 13l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Kanal ara (ad veya numara)…"
                  aria-label="Kanal ara"
                />
                {query && (
                  <button className="clear" onClick={() => setQuery('')} aria-label="Aramayı temizle">
                    ×
                  </button>
                )}
              </div>
              <div className="tool-group">
                <button className="btn" onClick={undo} disabled={!past.length || busy} title="Geri al (⌘Z)">↶</button>
                <button className="btn" onClick={redo} disabled={!future.length || busy} title="Yinele (⇧⌘Z)">↷</button>
                <button className="btn" onClick={() => commit(baseline)} disabled={!changedCount || busy}>Sıfırla</button>
              </div>
            </div>

            <div className="toolbar secondary">
              <div className="tool-group">
                <span className="sel-count">{selected.size ? `${selected.size} seçili` : 'Seçim yok'}</span>
                <button className="link" onClick={selectAllVisible}>{query ? 'Görünenleri seç' : 'Tümünü seç'}</button>
                {selected.size > 0 && <button className="link" onClick={() => setSelected(new Set())}>Seçimi kaldır</button>}
              </div>
              <div className="tool-group">
                <button className="btn" onClick={toTop} disabled={busy} title="Seçilileri en üste taşı">⇈ En üste</button>
                <button className="btn" onClick={() => step(-1)} disabled={busy} title="Bir yukarı (⌥↑)">↑</button>
                <button className="btn" onClick={() => step(1)} disabled={busy} title="Bir aşağı (⌥↓)">↓</button>
                <button className="btn" onClick={toBottom} disabled={busy} title="Seçilileri en alta taşı">⇊ En alta</button>
                <form
                  className="goto"
                  onSubmit={(e) => {
                    e.preventDefault();
                    toNumber();
                  }}
                >
                  <input value={gotoNumber} onChange={(e) => setGotoNumber(e.target.value.replace(/\D/g, ''))} placeholder="No" inputMode="numeric" aria-label="Hedef kanal numarası" />
                  <button className="btn" disabled={busy}>Numaraya taşı</button>
                </form>
              </div>
            </div>

            <div className="toolbar secondary">
              <div className="tool-group">
                <select
                  className="select"
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    const v = e.target.value as SortKind | 'edit' | 'dedupe';
                    if (v === 'edit') setModal('priority');
                    else if (v === 'dedupe') markDuplicates();
                    else if (v) runSort(v);
                  }}
                  aria-label="Otomatik sırala"
                >
                  <option value="">Otomatik sırala…</option>
                  {(Object.keys(SORT_LABELS) as SortKind[]).map((k) => (
                    <option key={k} value={k}>{SORT_LABELS[k]}</option>
                  ))}
                  <option value="dedupe">Çift kanallarda HD ve şifresiz olan kalsın (diğerlerini sil)</option>
                  <option value="edit">Öncelik listesini düzenle…</option>
                </select>
                <label className="inline-check">
                  <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
                  Yalnızca seçililere uygula
                </label>
                <label
                  className={`inline-check${scrambledKnown ? '' : ' disabled'}`}
                  title={scrambledKnown ? 'Şifreli kanallar yalnızca bu listede gizlenir, TV\'de silinmez' : 'Şifreli bilgisi için önce "Ekrandan oku ve karşılaştır" çalıştırın'}
                >
                  <input type="checkbox" checked={hiding} disabled={!scrambledKnown} onChange={(e) => setHideScrambled(e.target.checked)} />
                  Şifreli kanalları gizle{scrambledKnown ? ` (${scrambledCount})` : ''}
                </label>
              </div>
              <div className="tool-group">
                <button className="link" onClick={() => fileInput.current?.click()}>İçe aktar</button>
                <button className="link" onClick={exportCsv}>CSV</button>
                <button className="link" onClick={exportJson}>JSON</button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".csv,.json,.txt"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importFile(f);
                    e.target.value = '';
                  }}
                />
              </div>
            </div>

            <div className="list-head">
              <span />
              <span />
              <span>No</span>
              <span>Kanal</span>
              <span />
              <span>Değişim</span>
            </div>
            <div className="list-scroll">
              <ChannelList
                rows={visibleRows}
                selected={selected}
                query={query}
                disabled={busy}
                onRowClick={onRowClick}
                onToggle={onToggle}
                onDragEnd={onDragEnd}
              />
            </div>
            <div className="list-foot muted">
              {visibleRows.length} / {rows.length} kanal{hiding && scrambledCount ? ` (${scrambledCount} şifreli gizli)` : ''} · Satıra tıkla: seç · ⌘/Ctrl+tık: ekle · ⇧+tık: aralık · tutamaçtan sürükle
            </div>
          </section>

          <aside className="side">
            <section className="card summary">
              <h3>Değişiklik özeti</h3>
              <dl>
                <div><dt>Toplam kanal</dt><dd>{rows.length}</dd></div>
                <div>
                  <dt>Şifreli kanal</dt>
                  <dd className={scrambledKnown ? '' : 'muted'}>{scrambledKnown ? `${scrambledCount}${hiding ? ' (gizli)' : ''}` : 'henüz okunmadı'}</dd>
                </div>
                <div><dt>Yeri değişen</dt><dd className={changedCount ? 'accent' : ''}>{changedCount}</dd></div>
                <div><dt>TV'de gereken taşıma</dt><dd className={moveCount ? 'accent' : ''}>{moveCount}</dd></div>
                <div><dt>Tahmini süre</dt><dd>{moveCount ? formatDuration(moveCount * SECONDS_PER_MOVE) : '—'}</dd></div>
              </dl>
              <button className="btn primary block" disabled={!moveCount || busy || unknownCount > 0 || !device?.connected} onClick={() => setModal('apply')}>
                TV'ye uygula…
              </button>
              {removal.size > 0 && (
                <div className="removal-box">
                  <p className="note warn">{removal.size} çift kanal TV'den silinmek üzere işaretli (üstü çizili).</p>
                  <div className="row-actions">
                    <button className="btn danger" disabled={busy || !device?.connected} onClick={() => setModal('delete')}>Çift kanalları TV'den sil…</button>
                    <button className="link" onClick={() => setRemoval(new Set())}>İşaretleri kaldır</button>
                  </div>
                </div>
              )}
              {unknownCount > 0 && <p className="note warn">{unknownCount} kanalın numarası bilinmiyor; uygulama kapalı. Listeyi yeniden okuyun.</p>}
              <p className="note muted">
                Okuma: {formatTime(snapshot.readAt)} · {snapshot.device}
              </p>
              {snapshot.warnings.length > 0 && (
                <details className="warnings">
                  <summary>{snapshot.warnings.length} uyarı</summary>
                  <ul>{snapshot.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
                </details>
              )}
            </section>

            {(job.kind || busy) && <JobCard job={job} pct={progressPct} />}

            <section className="card">
              <h3>TV ekranından doğrula</h3>
              <p className="note muted">
                TV'de "Kanalları yeniden düzenle" ekranı açıkken listeyi kumandayla baştan sona gezip okur (yalnızca gezinme, ~3 dk).
                Şifreli kanallar da bu taramada, satırdaki kilit ikonundan tespit edilir.
              </p>
              <button className="btn block" onClick={startScan} disabled={busy || !device?.connected}>Ekrandan oku ve karşılaştır</button>
              {scan && (
                <p className={`note ${scan.matchesSnapshot ? 'ok' : 'warn'}`}>
                  {formatTime(scan.scannedAt)}: {scan.rows.length} kanal,{' '}
                  {scan.matchesSnapshot ? 'okunan listeyle birebir aynı ✓' : `${scan.differences.length} fark (günlüğe bakın)`}
                </p>
              )}
            </section>

            <section className="card">
              <h3>Yedekler</h3>
              <p className="note muted">Her okuma ve her uygulama öncesi hedef sıra <code>backups/</code> klasörüne JSON + CSV olarak kaydedilir.</p>
              <ul className="backups">
                {backups.slice(0, 8).map((b) => (
                  <li key={b.file}>
                    <div>
                      <b>{formatTime(b.readAt)}</b>
                      <span className="muted">{b.label} · {b.count} kanal</span>
                    </div>
                    <button className="link" onClick={() => void loadBackupOrder(b)} disabled={busy}>Bu sırayı yükle</button>
                  </li>
                ))}
                {!backups.length && <li className="muted">Henüz yedek yok</li>}
              </ul>
            </section>

            <section className="card log-card">
              <h3>Günlük</h3>
              <ul className="log">
                {[...logs].reverse().slice(0, 120).map((l, i) => (
                  <li key={`${l.at}-${i}`} className={l.level}>
                    <time>{new Date(l.at).toLocaleTimeString('tr-TR')}</time>
                    <span>{l.text}</span>
                  </li>
                ))}
                {!logs.length && <li className="muted">Kayıt yok</li>}
              </ul>
            </section>
          </aside>
        </main>
      )}

      {modal === 'apply' && snapshot && (
        <ApplyModal order={order} onClose={() => setModal(null)} onStarted={() => setModal(null)} notify={notify} />
      )}

      {modal === 'delete' && snapshot && (
        <DeleteModal
          groups={duplicateGroups}
          removeIds={[...removal]}
          onClose={() => setModal(null)}
          onStarted={() => setModal(null)}
          notify={notify}
        />
      )}

      {modal === 'priority' && (
        <div className="modal-backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Öncelik listesi">
            <h2>Öncelik listesi</h2>
            <p className="muted">
              Her satıra bir kanal adı yazın. "Öncelik listesine göre" sıralamada eşleşen kanallar bu sırayla en üste
              gelir, diğerleri mevcut sıralarını korur. Büyük/küçük harf, boşluk ve HD/UHD eki önemsenmez; sonuna{' '}
              <code>*</code> koyarsanız ön ek olarak eşleşir (ör. <code>TRT*</code>).
            </p>
            <textarea value={priorityText} onChange={(e) => setPriorityText(e.target.value)} rows={14} />
            <div className="modal-actions">
              <button className="link" onClick={() => setPriorityText(PRIORITY_PRESET)}>Varsayılan listeyi yükle</button>
              <span className="spacer" />
              <button className="btn" onClick={() => setModal(null)}>Kapat</button>
              <button className="btn primary" onClick={() => { setModal(null); runSort('priority'); }}>Kaydet ve sırala</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}

function JobCard({ job, pct }: { job: JobStatus; pct: number | undefined }) {
  const active = job.state === 'running' || job.state === 'paused' || job.state === 'stopping';
  const canControl = active && (job.kind === 'apply' || job.kind === 'scan' || job.kind === 'delete');
  const remaining = job.kind === 'apply' && job.total ? (job.total - job.done) * SECONDS_PER_MOVE : 0;
  return (
    <section className={`card job ${job.state}`}>
      <div className="job-head">
        <h3>{job.kind ? JOB_TITLES[job.kind] : 'İşlem'}</h3>
        <span className={`badge ${job.state}`}>{STATE_LABELS[job.state]}</span>
      </div>
      <p className="phase">{job.phase}{job.total > 0 && ` · ${job.done}/${job.total}`}</p>
      <div className={`progress${pct === undefined ? ' indeterminate' : ''}`}>
        <div style={{ width: `${pct ?? 30}%` }} />
      </div>
      {job.current && (
        <p className="current">
          <b>{job.current.name}</b> → {job.current.toNumber}
        </p>
      )}
      {remaining > 0 && active && <p className="note muted">Kalan süre: {formatDuration(remaining)}</p>}
      {job.message && !active && <p className={`note ${job.state === 'done' ? 'ok' : 'warn'}`}>{job.message}</p>}
      {canControl && (
        <div className="job-actions">
          {job.state === 'paused' ? (
            <button className="btn" onClick={() => void api.resume()}>Devam et</button>
          ) : (
            <button className="btn" onClick={() => void api.pause()} disabled={job.state === 'stopping'}>Duraklat</button>
          )}
          <button className="btn danger" onClick={() => void api.stop()} disabled={job.state === 'stopping'}>Durdur</button>
        </div>
      )}
      {canControl && <p className="note muted">Duraklatma ve durdurma, o anki taşıma tamamlandıktan sonra gerçekleşir.</p>}
    </section>
  );
}
