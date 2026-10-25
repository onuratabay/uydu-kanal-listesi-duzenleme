import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildQueryScript, parseSearchOutput, resolveNumbers, type SearchRow } from './reader.ts';

const row = (tag: number, id: number, name: string): SearchRow => ({ tag, id, name, description: '' });

test('numara sorgusundan tam eşleşme ve eleme ile çözüm', () => {
  const results = new Map<number, SearchRow[]>([
    [1, [row(1, 10, 'TRT 1'), row(1, 11, 'KANAL 1')]],
    [2, [row(2, 12, 'ATV'), row(2, 13, 'TV 2')]],
    [3, [row(3, 13, 'TV 2')]],
    [4, [row(4, 14, 'TV 4')]],
  ]);
  const { channels, warnings } = resolveNumbers(results);
  const byId = new Map(channels.map((c) => [c.id, c]));
  assert.equal(byId.get(12)!.number, 2);
  assert.equal(byId.get(12)!.numberSource, 'exact');
  assert.equal(byId.get(13)!.number, 3);
  assert.equal(byId.get(14)!.number, 4);
  assert.equal(byId.get(14)!.numberSource, 'inferred');
  // 10 ve 11 ikisi de yalnızca 1'e aday: çözülemez
  assert.equal(byId.get(10)!.numberSource, 'unknown');
  assert.equal(warnings.length, 2);
});

test('sorgu betiği terimleri kodlar ve paralel gruplar', () => {
  const script = buildQueryScript(['a b', '5', 'ç'], 2);
  assert.match(script, /search_suggest_query\/a%20b\?limit=100000&action=2/);
  assert.match(script, /search_suggest_query\/%C3%A7\?/);
  assert.equal(script.split('\n').filter((l) => l === 'wait').length, 2);
});

test('kaydedilmiş ilk okuma verisi çözülebiliyor', { skip: !existsSync('test-fixtures/numara-sorgulari.txt') }, () => {
  const raw = readFileSync('test-fixtures/numara-sorgulari.txt', 'utf8');
  const results = new Map<number, SearchRow[]>();
  for (let n = 1; n <= 420; n++) results.set(n, []);
  for (const r of parseSearchOutput(raw)) results.get(r.tag)!.push(r);
  const { channels } = resolveNumbers(results);
  assert.equal(channels.length, 370);
  assert.ok(channels.every((c) => c.number !== null));
  const numbers = channels.map((c) => c.number!);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.equal(channels.find((c) => c.name === 'EUROSTAR')!.number, 77);
  assert.equal(channels.find((c) => c.name === 'GONCA TV')!.number, 85);
});
