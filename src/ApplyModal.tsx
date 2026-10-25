import { useEffect, useState } from 'react';
import type { ScreenSummary } from '../shared/types.ts';
import { api, type PlanResult } from './api.ts';

const SECONDS_PER_MOVE = 30;

interface Props {
  order: number[];
  onClose: () => void;
  onStarted: () => void;
  notify: (text: string, kind?: 'ok' | 'warn' | 'error') => void;
}

function screenVerdict(s: ScreenSummary): { ok: boolean; text: string } {
  if (s.kind === 'dialog') return { ok: false, text: 'Numara diyaloğu açık. Kumandadan GERİ ile kapatın.' };
  if (s.kind !== 'rearrange') return { ok: false, text: '"Kanalları yeniden düzenle" ekranı açık değil.' };
  if (s.moving) return { ok: false, text: 'Bir kanal taşıma modunda (tutulmuş). Aşağıdaki düğmeyle değişiklik yapmadan bırakabilirsiniz.' };
  return { ok: true, text: `Hazır: "${s.title}" ekranı açık, odak ${s.focusedNumber ?? '?'} numarada.` };
}

export function ApplyModal({ order, onClose, onStarted, notify }: Props) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState('');
  const [screen, setScreen] = useState<ScreenSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [mode, setMode] = useState<'test' | 'all'>('test');
  const [verifyScan, setVerifyScan] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api.plan(order).then(setPlan).catch((e) => setPlanError((e as Error).message));
  }, [order]);

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

  const release = async () => {
    try {
      await api.releaseMove();
      await check();
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  };

  const start = async () => {
    setStarting(true);
    try {
      await api.apply(order, { maxMoves: mode === 'test' ? 1 : undefined, verifyScan });
      onStarted();
    } catch (e) {
      notify((e as Error).message, 'error');
      setStarting(false);
    }
  };

  const verdict = screen ? screenVerdict(screen) : null;
  const moves = plan?.count ?? 0;
  const runMoves = mode === 'test' ? Math.min(1, moves) : moves;
  const seconds = runMoves * SECONDS_PER_MOVE + (verifyScan ? 200 : 0);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="TV'ye uygula">
        <h2>Sıralamayı TV'ye uygula</h2>

        {planError && <p className="note error">{planError}</p>}
        {!plan && !planError && <p className="muted">Taşıma planı hesaplanıyor…</p>}
        {plan && (
          <>
            <p>
              Hedef sıraya ulaşmak için TV'de <b>{plan.count}</b> taşıma gerekiyor (en az sayıda). Taşımalar TV'nin kendi
              "Kanalları yeniden düzenle" ekranında, numara girerek yapılır; her taşımadan sonra ekran okunup sonuç
              doğrulanır. Beklenmeyen bir durumda işlem güvenli şekilde durur.
            </p>
            <ol className="move-preview">
              {plan.moves.slice(0, 8).map((m) => (
                <li key={`${m.channelId}-${m.fromIndex}`}>
                  <b>{m.name}</b> → {m.toNumber} numaraya
                </li>
              ))}
              {plan.count > 8 && <li className="muted">… ve {plan.count - 8} taşıma daha</li>}
            </ol>
            <p className="note muted">
              Numaralar o adımdaki hedeftir; sonraki taşımalar kanalları kaydırdığı için son numaralar listede gördüğünüz gibi olur.
            </p>
          </>
        )}

        <div className="steps">
          <div className="step">
            <span className="step-no">1</span>
            <div>
              <b>TV'de düzenleme ekranını açın</b>
              <p className="muted">
                Canlı TV → OK (kanal listesi) → Menü / Düzenle → <i>Kanalları yeniden düzenle</i>. Bu sırada
                kumandaya dokunmayın; ilerlemeyi scrcpy ile izleyebilirsiniz.
              </p>
            </div>
          </div>
          <div className="step">
            <span className="step-no">2</span>
            <div>
              <b>Ekranı kontrol edin</b>
              <div className="row-actions">
                <button className="btn" onClick={() => void check()} disabled={checking}>
                  {checking ? 'Okunuyor…' : 'TV ekranını kontrol et'}
                </button>
                {screen?.moving && screen.kind !== 'other' && (
                  <button className="btn" onClick={() => void release()}>Taşıma modunu değişiklik yapmadan kapat</button>
                )}
              </div>
              {verdict && <p className={`note ${verdict.ok ? 'ok' : 'warn'}`}>{verdict.text}</p>}
            </div>
          </div>
          <div className="step">
            <span className="step-no">3</span>
            <div>
              <b>Seçenekler</b>
              <label className="radio">
                <input type="radio" checked={mode === 'test'} onChange={() => setMode('test')} />
                Önce yalnızca <b>1 taşıma</b> yap (deneme — önerilir)
              </label>
              <label className="radio">
                <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} />
                Tüm taşımaları uygula ({moves})
              </label>
              <label className="radio">
                <input type="checkbox" checked={verifyScan} onChange={(e) => setVerifyScan(e.target.checked)} />
                Başlamadan önce TV listesini ekrandan baştan sona doğrula (~3 dk, önerilir)
              </label>
              <p className="note muted">Tahmini süre: {Math.max(1, Math.round(seconds / 60))} dk</p>
            </div>
          </div>
        </div>

        <label className="confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          TV'deki kanal sıralamasının değiştirileceğini anlıyorum ve onaylıyorum.
        </label>

        <div className="modal-actions">
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Vazgeç</button>
          <button
            className="btn primary"
            disabled={!confirmed || !plan || !moves || !verdict?.ok || starting}
            onClick={() => void start()}
            title={!verdict?.ok ? 'Önce TV ekranını kontrol edin' : undefined}
          >
            {starting ? 'Başlatılıyor…' : mode === 'test' ? 'Onaylıyorum, 1 taşıma yap' : `Onaylıyorum, ${moves} taşımayı uygula`}
          </button>
        </div>
      </div>
    </div>
  );
}
