import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parseScreen } from './uiDump.ts';

const SAVED = 'test-fixtures/ekran-yeniden-duzenle.xml';

test('kaydedilmiş "Kanalları yeniden düzenle" ekranı (taşıma modunda) çözümlenir', { skip: !existsSync(SAVED) }, () => {
  const s = parseScreen(readFileSync(SAVED, 'utf8'));
  assert.equal(s.kind, 'rearrange');
  assert.equal(s.title, 'Kanalları yeniden düzenle');
  assert.deepEqual(s.rows.map((r) => r.number), ['77', '80', '81', '82', '83', '84', '85']);
  assert.equal(s.rows[1].name, 'FB TV');
  assert.equal(s.moving, true);
  assert.deepEqual(s.rows.filter((r) => r.moveIcon).map((r) => r.name), ['FREEDOM']);
  assert.equal(s.dialogValue, null);
  assert.ok(s.rows.every((r) => !r.scrambled));
});

test('kilit ikonu olan satır şifreli sayılır', () => {
  const row = (num: string, name: string, extra = '') =>
    node(
      'resource-id="com.mitv.livetv:id/list_item_channel_move_frame" bounds="[90,164][750,284]" focused="false"',
      node('resource-id="com.mitv.livetv:id/common_channel_info_number" text="' + num + '" bounds="[1,1][2,2]" focused="false"') +
        node('resource-id="com.mitv.livetv:id/common_channel_info_channel_name" text="' + name + '" bounds="[1,1][2,2]" focused="false"') +
        extra,
    );
  const lock = node('resource-id="com.mitv.livetv:id/common_channel_info_scrambled" bounds="[3,3][4,4]" focused="false"');
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node(
    'resource-id="com.mitv.livetv:id/list_move_channel" bounds="[0,0][1920,1080]" focused="true"',
    row('10', 'BEIN SPORTS', lock) + row('11', 'TRT 1'),
  )}</hierarchy>`;
  const s = parseScreen(xml);
  assert.deepEqual(s.rows.map((r) => [r.number, r.scrambled]), [['10', true], ['11', false]]);
});

const node = (attrs: string, inner = '') =>
  `<node index="0" text="" class="android.view.View" package="com.mitv.livetv" ${attrs}>${inner}</node>`;

test('numara diyaloğu ve odak çözümlenir', () => {
  const xml = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node(
    'resource-id="" bounds="[0,0][1920,1080]" focused="false"',
    node('resource-id="com.mitv.livetv:id/input_number_view_input" text="125" bounds="[1,1][2,2]" focused="false"') +
      node('resource-id="com.mitv.livetv:id/input_number_view_5" bounds="[1,1][2,2]" focused="false"') +
      node('resource-id="com.mitv.livetv:id/input_number_view_action_right" bounds="[3,3][4,4]" focused="true"'),
  )}</hierarchy>`;
  const s = parseScreen(xml);
  assert.equal(s.kind, 'dialog');
  assert.equal(s.dialogValue, '125');
  assert.equal(s.focusedId, 'input_number_view_action_right');
});
