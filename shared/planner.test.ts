import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, MovePlanner, minimumMoves, planMoves } from './planner.ts';

function shuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function runPlan(current: number[], desired: number[]) {
  const numbers = current.map((_, i) => i + 1);
  const moves = planMoves(current, desired, numbers);
  let list = current;
  for (const m of moves) {
    assert.equal(list[m.fromIndex], m.channelId);
    assert.notEqual(m.fromIndex, m.toIndex);
    assert.equal(m.toNumber, numbers[m.toIndex]);
    list = applyMove(list, m.fromIndex, m.toIndex);
  }
  return { list, moves };
}

test('tek kanalı en başa almak tek taşıma', () => {
  const current = [1, 2, 3, 4, 5, 6];
  const desired = [5, 1, 2, 3, 4, 6];
  const { list, moves } = runPlan(current, desired);
  assert.deepEqual(list, desired);
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0].fromIndex, moves[0].toIndex], [4, 0]);
});

test('ilk kanalı sona göndermek tek taşıma', () => {
  const current = Array.from({ length: 50 }, (_, i) => i);
  const desired = [...current.slice(1), 0];
  const { list, moves } = runPlan(current, desired);
  assert.deepEqual(list, desired);
  assert.equal(moves.length, 1);
});

test('değişiklik yoksa taşıma yok', () => {
  const current = [3, 1, 2];
  assert.equal(runPlan(current, [...current]).moves.length, 0);
});

test('rastgele sıralamalar hedefe ulaşır ve en az taşıma sayısını aşmaz', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const n = 5 + (seed * 7) % 120;
    const current = shuffle(Array.from({ length: n }, (_, i) => 1000 + i), seed);
    const desired = shuffle(current, seed * 31 + 7);
    const { list, moves } = runPlan(current, desired);
    assert.deepEqual(list, desired, `seed ${seed}`);
    assert.ok(moves.length <= minimumMoves(current, desired), `seed ${seed}`);
  }
});

test('odak konumu ne olursa olsun planlayıcı hedefe ulaşır', () => {
  const current = shuffle(Array.from({ length: 80 }, (_, i) => i), 5);
  const desired = shuffle(current, 9);
  const numbers = current.map((_, i) => i * 2 + 1);
  const planner = new MovePlanner(current, desired, numbers);
  let focus = 79;
  let guard = 0;
  for (let m = planner.next(focus); m; m = planner.next(focus)) {
    planner.commit(m);
    focus = (focus * 13 + 7) % 80;
    assert.ok(guard++ < 200);
  }
  assert.deepEqual(planner.order, desired);
});

test('yinelenen numaralar hedef olarak seçilmez ve hedefe yine ulaşılır', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const current = shuffle(Array.from({ length: 60 }, (_, i) => i), seed);
    const desired = shuffle(current, seed + 100);
    // TV'deki gibi: bir numara boş (21), bir sonraki iki kez (22, 22)
    const numbers = current.map((_, i) => (i < 20 ? i + 1 : i === 20 ? 22 : i + 1));
    const dups = new Set(numbers.filter((n, i) => numbers.indexOf(n) !== i));
    assert.ok(dups.has(22));
    const planner = new MovePlanner(current, desired, numbers);
    let unreachable = 0;
    let guard = 0;
    for (let m = planner.next(0); m; m = planner.next(m.fromIndex)) {
      assert.equal(m.toNumber, numbers[m.toIndex]);
      if (!planner.isReachable(m.toIndex)) unreachable++;
      planner.commit(m);
      assert.ok(guard++ < 200);
    }
    assert.deepEqual(planner.order, desired);
    // İki adımlı çözümle ikinci kopyanın konumu neredeyse hiç hedef olmaz; kalan nadir durumda TV sonrası doğrulama işlemi durdurur.
    assert.ok(unreachable <= 1, `seed ${seed}: ${unreachable} ulaşılamaz hedef`);
  }
});

test('geçersiz girişler reddedilir', () => {
  assert.throws(() => new MovePlanner([1, 2], [1, 3], [1, 2]));
  assert.throws(() => new MovePlanner([1, 1], [1, 1], [1, 2]));
  assert.throws(() => new MovePlanner([1, 2], [1, 2], [1]));
});
