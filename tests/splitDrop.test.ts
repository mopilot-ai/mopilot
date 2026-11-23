// Split view's drop zones (src/lib/splitDrop.ts) and what a drop does (src/components/split/useSplitDrop.ts applyDrop):
// a sidebar chat makes a column at a pane's edge ("Split view") or replaces a pane in its middle ("Open here"); a pane
// dragged by its header moves at an edge ("Move here") or swaps in a middle ("Swap"); a drop that would change nothing
// has no zone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';
import { DROP_LABEL, dropZone, type PaneBox } from '../src/lib/splitDrop.ts';

// the primary pane 0-400, then split panes a 400-800, b 800-1200, each 600 tall; an edge is 100 px (a quarter)
const boxes: PaneBox[] = [
  { target: 'primary', left: 0, right: 400, top: 0, bottom: 600 },
  { target: 'a', left: 400, right: 800, top: 0, bottom: 600 },
  { target: 'b', left: 800, right: 1200, top: 0, bottom: 600 },
];
const chat = { kind: 'chat' as const };
const pane = (chatId: string) => ({ kind: 'pane' as const, chatId });

test('a sidebar chat: an edge makes a column there, a middle opens it there', () => {
  assert.deepEqual(dropZone(boxes, 350, 10, chat), {
    action: { kind: 'split', at: 0 },
    label: DROP_LABEL.split,
    box: { left: 300, right: 400, top: 0, bottom: 600 },
  });
  assert.deepEqual(dropZone(boxes, 410, 10, chat)?.action, { kind: 'split', at: 0 }, 'left of a: before it');
  assert.deepEqual(dropZone(boxes, 1150, 10, chat)?.action, { kind: 'split', at: 2 }, 'right of b: at the end');
  assert.deepEqual(dropZone(boxes, 600, 10, chat), {
    action: { kind: 'here', target: 'a' },
    label: DROP_LABEL.here,
    box: { left: 400, right: 800, top: 0, bottom: 600 },
  });
  // the primary pane has no left edge: a split pane can't go before it
  assert.deepEqual(dropZone(boxes, 20, 10, chat)?.action, { kind: 'here', target: 'primary' });
  assert.equal(dropZone(boxes, 1300, 10, chat), null, 'outside every pane');
  assert.equal(dropZone(boxes, 600, 700, chat), null);
  // a wide pane's edge is at most 120 px
  assert.deepEqual(dropZone([{ target: 'primary', left: 0, right: 2000, top: 0, bottom: 600 }], 1890, 10, chat)?.action, {
    kind: 'split',
    at: 0,
  });
  assert.equal(dropZone([{ target: 'primary', left: 0, right: 2000, top: 0, bottom: 600 }], 1890, 10, chat)?.box.left, 1880);
});

test('a dragged pane: an edge moves it there, another pane’s middle swaps them; its own place is no drop', () => {
  assert.deepEqual(dropZone(boxes, 1150, 10, pane('a')), {
    action: { kind: 'move', to: 1 },
    label: DROP_LABEL.move,
    box: { left: 1100, right: 1200, top: 0, bottom: 600 },
  });
  assert.deepEqual(dropZone(boxes, 410, 10, pane('b'))?.action, { kind: 'move', to: 0 }, 'b before a');
  assert.deepEqual(dropZone(boxes, 350, 10, pane('b'))?.action, { kind: 'move', to: 0 }, 'b right after the primary pane');
  assert.deepEqual(dropZone(boxes, 1000, 10, pane('a')), {
    action: { kind: 'swap', target: 'b' },
    label: DROP_LABEL.swap,
    box: { left: 800, right: 1200, top: 0, bottom: 600 },
  });
  // its own place: either edge next to it, or itself
  assert.equal(dropZone(boxes, 350, 10, pane('a')), null);
  assert.equal(dropZone(boxes, 410, 10, pane('a')), null);
  assert.equal(dropZone(boxes, 750, 10, pane('a')), null);
  assert.equal(dropZone(boxes, 810, 10, pane('a')), null);
  assert.equal(dropZone(boxes, 600, 10, pane('a')), null);
  // the primary pane's middle doesn't take a split pane; a pane no box shows is no drag
  assert.equal(dropZone(boxes, 200, 10, pane('a')), null);
  assert.equal(dropZone(boxes, 1000, 10, pane('z')), null);
});

const { store, resetState } = await loadStore();
const { applyDrop } = await import('../src/components/split/useSplitDrop.ts');
const SV = await import('../src/store/splitView.ts');
const st = () => store.useStore.getState();
const chats = () => st().split.panes.map((p) => p.chatId);

beforeEach(() => {
  resetState();
  resetAll();
  SV.setSplitRoom(3);
  store.useStore.setState({
    route: { name: 'thread', id: 'p' },
    threads: Object.fromEntries(['p', 'a', 'b', 'c'].map((id) => [id, { id, cwd: `/w/${id}` } as any])),
    runtime: Object.fromEntries(['p', 'a', 'b', 'c'].map((id) => [id, { loaded: true, turns: [] } as any])),
  });
});

test('applyDrop: each zone does its one layout change on the layout as it is then', () => {
  applyDrop({ kind: 'split', at: 0 }, 'a');
  applyDrop({ kind: 'split', at: 0 }, 'b');
  assert.deepEqual(chats(), ['b', 'a'], 'the second column went before the first');
  applyDrop({ kind: 'move', to: 1 }, 'b');
  assert.deepEqual(chats(), ['a', 'b']);
  applyDrop({ kind: 'swap', target: 'b' }, 'a');
  assert.deepEqual(chats(), ['b', 'a']);
  applyDrop({ kind: 'here', target: 'a' }, 'c');
  assert.deepEqual(chats(), ['b', 'c']);
  applyDrop({ kind: 'here', target: 'primary' }, 'a');
  assert.deepEqual(st().route, { name: 'thread', id: 'a' });
  // no room: the drop says why, as the menu does
  SV.setSplitRoom(2);
  applyDrop({ kind: 'split', at: 0 }, 'p');
  assert.deepEqual(chats(), ['b', 'c']);
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    [SV.NO_ROOM],
  );
});
