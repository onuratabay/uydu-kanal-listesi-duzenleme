import type { Move } from './types.ts';

/**
 * TV'nin taşıma işlemi: kanal `fromIndex` konumundan çıkarılır ve `toIndex` konumuna
 * yerleştirilir; aradaki kanallar birer kayar. Kanal numaraları konuma bağlıdır
 * (numbers[i], i. sıradaki kanalın numarasıdır), taşıma numara kümesini değiştirmez.
 */
export function applyMove<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
  const out = [...list];
  const [item] = out.splice(fromIndex, 1);
  out.splice(toIndex, 0, item);
  return out;
}

/** En uzun artan alt dizinin `seq` içindeki indekslerini döndürür. */
export function lisIndices(seq: readonly number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(seq.length).fill(-1);
  for (let i = 0; i < seq.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) {
    out.push(k);
    k = prev[k];
  }
  return out.reverse();
}

function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Hedef sıraya ulaşmak için gereken en az taşıma sayısı (n - LIS). */
export function minimumMoves(current: readonly number[], desired: readonly number[]): number {
  const rank = new Map(desired.map((id, r) => [id, r]));
  const seq = current.map((id) => rank.get(id) ?? -1);
  return current.length - lisIndices(seq).length;
}

/**
 * Mevcut sırayı hedef sıraya en az sayıda "taşı" işlemiyle dönüştürür.
 *
 * Yöntem: Hedefe göre en uzun artan alt dizideki kanallar yerinde kalır ("yerleşmiş").
 * Diğer her kanal, yerleşmiş kanallar arasındaki doğru yerine bir kez taşınır ve
 * yerleşmiş sayılır. Kanalların hangi sırayla işlendiği sonucu değiştirmez; bu yüzden
 * her adımda TV'deki odak konumuna en yakın kanal seçilir (kumanda gezinmesi azalır).
 */
export class MovePlanner {
  private list: number[];
  private readonly rank = new Map<number, number>();
  private readonly settled = new Set<number>();
  private readonly settledRanks: number[] = [];
  private readonly desired: readonly number[];
  private readonly duplicateNumbers: Set<number>;
  private readonly unsettledOnce = new Set<number>();
  private pendingUnsettle: number | null = null;

  constructor(
    current: readonly number[],
    desired: readonly number[],
    private readonly numbers: readonly number[],
    private readonly names: ReadonlyMap<number, string> = new Map(),
  ) {
    if (current.length !== desired.length || numbers.length !== current.length) {
      throw new Error('Mevcut liste, hedef liste ve numara listesi aynı uzunlukta olmalı');
    }
    const currentSet = new Set(current);
    if (currentSet.size !== current.length) throw new Error('Mevcut listede tekrar eden kanal var');
    desired.forEach((id, r) => {
      if (!currentSet.has(id)) throw new Error(`Hedef listedeki kanal TV listesinde yok: ${id}`);
      if (this.rank.has(id)) throw new Error(`Hedef listede tekrar eden kanal var: ${id}`);
      this.rank.set(id, r);
    });
    this.desired = desired;
    this.duplicateNumbers = new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i));
    this.list = [...current];
    const seq = current.map((id) => this.rank.get(id)!);
    for (const i of lisIndices(seq)) this.settle(current[i]);
  }

  get order(): readonly number[] {
    return this.list;
  }

  get remaining(): number {
    return this.list.length - this.settled.size;
  }

  /** Numara diyaloğuyla bu konuma taşınabilir mi (numarasının ilk sahibi bu konum mu)? */
  isReachable(index: number): boolean {
    return !this.duplicateNumbers.has(this.numbers[index]) || this.numbers.indexOf(this.numbers[index]) === index;
  }

  private settle(id: number): void {
    if (this.settled.has(id)) return;
    this.settled.add(id);
    const r = this.rank.get(id)!;
    this.settledRanks.splice(lowerBound(this.settledRanks, r), 0, r);
  }

  /** Sıradaki taşıma; bitti ise null. `focusIndex`: TV'de odaklı satırın konumu. */
  next(focusIndex: number): Move | null {
    for (;;) {
      let best = -1;
      let bestCost = Infinity;
      for (let i = 0; i < this.list.length; i++) {
        if (this.settled.has(this.list[i])) continue;
        // Aşağı yönde gezinmeyi hafifçe tercih et.
        const cost = Math.abs(i - focusIndex) + (i < focusIndex ? 0.5 : 0);
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      if (best < 0) return null;

      const id = this.list[best];
      const r = this.rank.get(id)!;
      const pos = lowerBound(this.settledRanks, r);
      const indexWithout = (other: number) => {
        const i = this.list.indexOf(other);
        return i > best ? i - 1 : i;
      };
      const lo = pos > 0 ? indexWithout(this.desired[this.settledRanks[pos - 1]]) + 1 : 0;
      const hi = pos < this.settledRanks.length
        ? indexWithout(this.desired[this.settledRanks[pos]])
        : this.list.length - 1;

      if (best >= lo && best <= hi) {
        this.settle(id);
        continue;
      }
      let to = best < lo ? lo : hi;
      // TV numara diyaloğu yazılan numaranın İLK sahibinin konumunu hedef alır. Aynı numarayı iki
      // kanal kullanıyorsa ikinci konuma doğrudan gidilemez; geçerli aralıkta ulaşılabilir en yakın
      // konum seçilir. Hiç yoksa hedef olduğu gibi bırakılır ve TV sonrası doğrulama işlemi durdurur.
      if (!this.isReachable(to)) {
        let pick = -1;
        for (let k = lo; k <= hi; k++) {
          if (this.isReachable(k) && (pick < 0 || Math.abs(k - to) < Math.abs(pick - to))) pick = k;
        }
        if (pick >= 0) {
          to = pick;
        } else if (pos < this.settledRanks.length && this.isReachable(hi + 1)) {
          // İki adımlı çözüm: kanalı ardılının hemen arkasına koy, ardılı yerleşmemiş say;
          // ardıl daha sonra kanalın arkasına (ulaşılabilir bir konuma) taşınır.
          const succ = this.desired[this.settledRanks[pos]];
          if (!this.unsettledOnce.has(succ)) {
            this.unsettledOnce.add(succ);
            this.pendingUnsettle = succ;
            to = hi + 1;
          }
        }
      }
      return {
        channelId: id,
        name: this.names.get(id) ?? '',
        fromIndex: best,
        toIndex: to,
        toNumber: this.numbers[to],
      };
    }
  }

  /** TV taşımayı onayladıktan sonra çağrılır. */
  commit(move: Move): void {
    if (this.list[move.fromIndex] !== move.channelId) {
      throw new Error('Planlayıcı durumu taşıma ile uyuşmuyor');
    }
    this.list = applyMove(this.list, move.fromIndex, move.toIndex);
    this.settle(move.channelId);
    if (this.pendingUnsettle !== null) {
      const r = this.rank.get(this.pendingUnsettle)!;
      this.settled.delete(this.pendingUnsettle);
      this.settledRanks.splice(lowerBound(this.settledRanks, r), 1);
      this.pendingUnsettle = null;
    }
  }
}

/** Tüm taşımaları önceden hesaplar (odak her taşımadan sonra kaynak konumda kalır varsayımıyla). */
export function planMoves(
  current: readonly number[],
  desired: readonly number[],
  numbers: readonly number[],
  names?: ReadonlyMap<number, string>,
): Move[] {
  const planner = new MovePlanner(current, desired, numbers, names);
  const moves: Move[] = [];
  let focus = 0;
  for (let m = planner.next(focus); m; m = planner.next(focus)) {
    moves.push(m);
    planner.commit(m);
    focus = m.fromIndex;
  }
  return moves;
}
