// Komut satırından salt okuma testi: npx tsx server/read-cli.ts
import { readChannels } from './reader.ts';
import { saveBackup } from './storage.ts';

const t0 = Date.now();
const snap = await readChannels('MiTV-MZTU0', (p) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${p.phase} ${p.done}/${p.total}`));
const file = await saveBackup(snap, 'yedek');
const unknown = snap.channels.filter((c) => c.numberSource === 'unknown').length;
const inferred = snap.channels.filter((c) => c.numberSource === 'inferred');
console.log(`TOPLAM ${snap.channels.length} kanal, bilinmeyen ${unknown}, eleme ile ${inferred.map((c) => `${c.number}=${c.name}`).join(', ')}`);
console.log('UYARILAR', snap.warnings);
console.log('ILK 10', snap.channels.slice(0, 10).map((c) => `${c.number} ${c.name}`).join(' | '));
console.log(`süre ${((Date.now() - t0) / 1000).toFixed(0)} s, yedek backups/${file}`);
