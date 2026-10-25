/**
 * TV ekranını `uiautomator dump` ile okur ve LiveTV'nin "Kanalları yeniden düzenle"
 * ekranının durumunu çıkarır. Kimlikler LiveTV 3.3.143 kaynaklarından alınmıştır.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ScreenSummary } from '../shared/types.ts';
import { shell, sleep } from './adb.ts';

export type Bounds = [number, number, number, number];

interface UiNode {
  id: string;
  cls: string;
  text: string;
  pkg: string;
  bounds: Bounds;
  focused: boolean;
  selected: boolean;
  checked: boolean;
  children: UiNode[];
}

export interface ChannelRow {
  number: string;
  name: string;
  bounds: Bounds;
  focused: boolean;
  moveIcon: boolean;
  /** Kilit ikonu görünür mü (LiveTV şifresiz kanallarda ikonu GONE yapar, dökümde hiç yer almaz). */
  scrambled: boolean;
  /** "Kanalları sil" ekranında satırın işaret kutusu işaretli mi. */
  checked: boolean;
}

export interface ScreenState {
  /** rearrange: Kanalları yeniden düzenle · delete: Kanalları sil · dialog: numara diyaloğu · message: onay penceresi */
  kind: 'rearrange' | 'delete' | 'dialog' | 'message' | 'other';
  pkg: string;
  title: string;
  /** Ekranda tam görünen kanal satırları, yukarıdan aşağıya. */
  rows: ChannelRow[];
  /** Taşıma modu açık mı (bir kanal "tutulmuş" durumda). */
  moving: boolean;
  floatFocused: boolean;
  /** Numara diyaloğundaki yazılı değer. */
  dialogValue: string | null;
  focusedId: string;
  /** Sil butonundaki seçili kanal sayısı; buton görünmüyorsa null. */
  deleteCount: number | null;
  deleteFloatFocused: boolean;
  /** Onay penceresinin metni (ör. "3 kanal silinsin mi?"). */
  messageText: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => name === 'node',
});

function toNode(raw: Record<string, unknown>): UiNode {
  const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(String(raw.bounds ?? '')) ?? [];
  const rid = String(raw['resource-id'] ?? '');
  return {
    id: rid.includes('/') ? rid.slice(rid.indexOf('/') + 1) : rid,
    cls: String(raw.class ?? ''),
    text: String(raw.text ?? ''),
    pkg: String(raw.package ?? ''),
    bounds: [Number(b[1] ?? 0), Number(b[2] ?? 0), Number(b[3] ?? 0), Number(b[4] ?? 0)],
    focused: raw.focused === 'true',
    selected: raw.selected === 'true',
    checked: raw.checked === 'true',
    children: ((raw.node as Record<string, unknown>[] | undefined) ?? []).map(toNode),
  };
}

function findAll(root: UiNode, pred: (n: UiNode) => boolean, out: UiNode[] = []): UiNode[] {
  if (pred(root)) out.push(root);
  for (const c of root.children) findAll(c, pred, out);
  return out;
}

const findId = (root: UiNode, id: string) => findAll(root, (n) => n.id === id)[0];

export function parseScreen(xml: string): ScreenState {
  const doc = parser.parse(xml) as { hierarchy?: { node?: Record<string, unknown>[] } };
  const roots = (doc.hierarchy?.node ?? []).map(toNode);
  const root: UiNode = {
    id: '', cls: '', text: '', pkg: roots[0]?.pkg ?? '', bounds: [0, 0, 0, 0],
    focused: false, selected: false, checked: false, children: roots,
  };

  const rows: ChannelRow[] = [];
  const FRAMES = new Set(['list_item_channel_move_frame', 'list_item_channel_delete_frame']);
  for (const frame of findAll(root, (n) => FRAMES.has(n.id))) {
    const num = findId(frame, 'common_channel_info_number');
    const name = findId(frame, 'common_channel_info_channel_name');
    if (!num?.text || !name) continue;
    rows.push({
      number: num.text.trim(),
      name: name.text.trim(),
      bounds: frame.bounds,
      focused: frame.focused || frame.selected,
      moveIcon: !!findId(frame, 'icon_channel_move'),
      scrambled: !!findId(frame, 'common_channel_info_scrambled'),
      checked: !!findId(frame, 'check_box_channel_delete')?.checked,
    });
  }
  rows.sort((a, b) => a.bounds[1] - b.bounds[1]);

  const float = findId(root, 'float_view_move_frame');
  const done = findId(root, 'input_number_view_action_right');
  const input = findId(root, 'input_number_view_input');
  const focused = findAll(root, (n) => n.focused);
  const messageOk = findId(root, 'message_dialog_button_ok');
  const deleteFloat = findId(root, 'float_view_delete_frame');
  const deleteCountText = findId(root, 'float_view_delete_count')?.text ?? '';
  const kind: ScreenState['kind'] = done
    ? 'dialog'
    : messageOk
      ? 'message'
      : findId(root, 'list_move_channel')
        ? 'rearrange'
        : findId(root, 'list_delete_channel')
          ? 'delete'
          : 'other';

  return {
    deleteCount: deleteFloat ? Number(/\d+/.exec(deleteCountText)?.[0] ?? NaN) : null,
    deleteFloatFocused: !!deleteFloat?.focused,
    messageText: messageOk
      ? [findId(root, 'message_dialog_title')?.text, findId(root, 'message_dialog_content')?.text].filter(Boolean).join(' — ')
      : null,
    kind,
    pkg: root.pkg,
    title: findId(root, 'page_title')?.text ?? '',
    rows,
    moving: !!float || rows.some((r) => r.moveIcon),
    floatFocused: !!float?.focused,
    dialogValue: done ? (input?.text ?? '') : null,
    focusedId: focused[focused.length - 1]?.id ?? '',
  };
}

const REMOTE_XML = '/data/local/tmp/tvkm-ui.xml';

export async function dumpScreen(): Promise<ScreenState> {
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = await shell(`uiautomator dump ${REMOTE_XML} >/dev/null 2>&1; cat ${REMOTE_XML}; rm -f ${REMOTE_XML}`, 30_000);
    const start = out.indexOf('<?xml');
    if (start >= 0 && out.includes('</hierarchy>')) return parseScreen(out.slice(start));
    last = out.slice(0, 200);
    await sleep(600);
  }
  throw new Error(`Ekran okunamadı (uiautomator): ${last}`);
}

export function summarize(s: ScreenState, activity: string): ScreenSummary {
  return {
    activity,
    kind: s.kind,
    title: s.title,
    moving: s.moving,
    rows: s.rows.map((r) => ({ number: r.number, name: r.name, scrambled: r.scrambled })),
    focusedNumber: s.rows.find((r) => r.focused)?.number ?? null,
    deleteCount: s.deleteCount,
  };
}
