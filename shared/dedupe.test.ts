import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Channel } from './types.ts';
import { findDuplicates } from './dedupe.ts';

let nextId = 1;
const ch = (number: number, name: string, scrambled?: boolean): Channel => ({ id: nextId++, number, name, numberSource: 'exact', scrambled });

test('HD olan tutulur, eşit kalitede listede önce gelen kalır', () => {
  const list = [ch(3, 'TRT 1'), ch(1, 'TRT1 HD'), ch(2, 'TRT1 HD'), ch(4, 'TRT1'), ch(5, 'ATV')];
  const order = [2, 3, 1, 4, 5];
  const [g, ...rest] = findDuplicates(list, order);
  assert.equal(rest.length, 0);
  assert.equal(g.keep.number, 1);
  assert.deepEqual(g.remove.map((c) => c.number).sort(), [2, 3, 4]);
});

test('şifresiz kopya, kalitesi düşük olsa da tutulur', () => {
  const list = [ch(10, 'BEIN SPORTS 1 HD', true), ch(11, 'BEIN SPORTS 1')];
  const [g] = findDuplicates(list);
  assert.equal(g.keep.name, 'BEIN SPORTS 1');
});

test('SD eki ve sondaki boşluk aynı kanal sayılır, farklı kanallar ayrı kalır', () => {
  const list = [ch(1, 'TGRT HABER HD'), ch(2, 'TGRT HABER SD'), ch(3, 'DIYANET TV '), ch(4, 'DIYANET TV HD'), ch(5, 'TV 4 HD'), ch(6, 'TV 41')];
  const groups = findDuplicates(list);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.keep.name), ['TGRT HABER HD', 'DIYANET TV HD']);
});
