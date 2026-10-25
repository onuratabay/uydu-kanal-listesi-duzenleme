import { useState } from 'react';
import type { ScreenSummary } from '../shared/types.ts';
import type { DuplicateGroup } from '../shared/dedupe.ts';
import { api } from './api.ts';

interface Props {
  groups: DuplicateGroup[];
  removeIds: number[];
  onClose: () => void;
  onStarted: () => void;
  notify: (text: string, kind?: 'ok' | 'warn' | 'error') => void;
}

function verdict(s: ScreenSummary): { ok: boolean; text: string } {
  if (s.kind === 'message') return { ok: false, text: 'TV\'de bir onay penceresi açık. Kumandadan GERİ ile kapatın.' };
  if (s.kind !== 'delete') return { ok: false, text: '"Kanalları sil" ekranı açık değil.' };
  if ((s.deleteCount ?? 0) > 0) return { ok: false, text: `Ekranda zaten ${s.deleteCount} kanal işaretli. GERİ ile çıkıp ekranı yeniden açın.` };
  return { ok: true, text: `Hazır: "Kanalları sil" ekranı açık, işaretli kanal yok, odak ${s.focusedNumber ?? '?'} numarada.` };
}

export function DeleteModal({ groups, removeIds, onClose, onStarted, notify }: Props) {
  const [screen, setScreen] = useState<ScreenSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const v = screen ? verdict(screen) : null;
  const shown = groups.filter((g) => g.remove.some((c) => removeIds.includes(c.id)));

  const check = async () => {
    setChecking(true);
    try {
      setScreen(await api.screen());
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.remove(removeIds);
      onStarted();
    } catch (e) {
      notify((e as Error).message, 'error');
      setStarting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Çift kanalları TV'den sil">
        <h2>Çift kanalları TV'den sil</h2>
        <p>
          <b>{removeIds.length}</b> kopya kanal TV listesinden silinecek (LiveTV kanalı gizler). Her grupta şifresiz ve en
          yüksek kaliteli olan, eşitlikte listende önce gelen kalır. Silinen kanalları geri getirmek için TV'de yeniden
          kanal taraması gerekebilir; liste silmeden önce <code>data/</code> klasörüne kaydedilir.
        </p>
        <ul className="dedupe-preview">
          {shown.slice(0, 12).map((g) => (
            <li key={g.keep.id}>
              <b>{g.keep.number} {g.keep.name}</b> kalır · silinecek:{' '}
              {g.remove.filter((c) => removeIds.includes(c.id)).map((c) => `${c.number} ${c.name}`).join(', ')}
            </li>
          ))}
          {shown.length > 12 && <li className="muted">… ve {shown.length - 12} grup daha</li>}
        </ul>

        <div className="steps">
          <div className="step">
            <span className="step-no">1</span>
            <div>
              <b>TV'de silme ekranını açın</b>
              <p className="muted">Canlı TV → kanal listesi → bir kanala uzun bas → <i>Sil</i>. Hiçbir kanalı işaretlemeyin, kumandaya dokunmayın.</p>
            </div>
          </div>
          <div className="step">
            <span className="step-no">2</span>
            <div>
              <b>Ekranı kontrol edin</b>
              <div className="row-actions">
                <button className="btn" onClick={() => void check()} disabled={checking}>{checking ? 'Okunuyor…' : 'TV ekranını kontrol et'}</button>
              </div>
              {v && <p className={`note ${v.ok ? 'ok' : 'warn'}`}>{v.text}</p>}
            </div>
          </div>
          <div className="step">
            <span className="step-no">3</span>
            <div>
              <b>Nasıl çalışır</b>
              <p className="muted">
                Kanallar tek tek işaretlenir ve her işaret ekrandan doğrulanır. Onaydan önce TV'nin gösterdiği sayı {removeIds.length} ile
                karşılaştırılır. Bir uyuşmazlıkta ekrandan çıkılır ve hiçbir kanal silinmez. Tahmini süre: ~{Math.max(1, Math.round((removeIds.length * 8) / 60))} dk.
              </p>
            </div>
          </div>
        </div>

        <label className="confirm danger-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          {removeIds.length} kanalın TV listesinden silineceğini anlıyorum ve onaylıyorum.
        </label>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Vazgeç</button>
          <button className="btn primary danger-fill" disabled={!confirmed || !v?.ok || starting} onClick={() => void start()}>
            {starting ? 'Başlatılıyor…' : `Onaylıyorum, ${removeIds.length} kanalı sil`}
          </button>
        </div>
      </div>
    </div>
  );
}
