import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel } from '../shared/types.ts';
import { compareRows, mergeScrambled } from './executor.ts';

const ch = (id: number, number: number, name: string): Channel => ({ id, number, name, numberSource: 'exact' });

// TV'de görülen durum: 69 boş, 70'i iki kanal kullanıyor
const channels = [ch(4504, 68, 'DOST TV'), ch(4507, 70, 'DT61420UHD REPLACEMENT'), ch(4508, 70, 'DT9502R'), ch(4509, 71, 'DT9505R')];

test('aynı numaralı iki kanal ekran karşılaştırmasında fark sayılmaz', () => {
  const rows = channels.map((c) => ({ number: String(c.number), name: c.name, scrambled: false }));
  assert.deepEqual(compareRows(rows, channels), []);
  assert.equal(compareRows(rows.slice(0, 2), channels).length, 2);
});

test('şifreli bilgisi aynı numaralı kanallara adlarıyla işlenir', () => {
  const rows = [
    { number: '70', name: 'DT61420UHD REPLACEMENT', scrambled: false },
    { number: '70', name: 'DT9502R', scrambled: true },
  ];
  const { channels: out, matched } = mergeScrambled(channels, rows);
  assert.equal(matched, 2);
  assert.equal(out.find((c) => c.id === 4508)!.scrambled, true);
  assert.equal(out.find((c) => c.id === 4507)!.scrambled, false);
});
