// A refused selection delivery must not be acknowledged as a committed attachment or written to a fallback draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, useRef, useState, act } from 'react';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
const drafts: any = {};
mockSource('src/store/core.ts', {
  get: () => ({ drafts }),
  setDraft: (id: string, value: unknown) => (drafts[id] = value),
  toast: () => undefined,
});
let machine = false;
let picked: string | null = null;
mockSource('src/lib/hostChats.ts', { onMachineNow: () => machine });
mockSource('src/store/projects.ts', { newChatHostPick: () => picked });
const { useSelectionAttachments } = await import('../src/components/composer/useSelectionAttachments.ts');
const { attachToComposer } = await import('../src/session/composerAttach.ts');
let accept = false,
  items: any[];
function Probe() {
  const [attachments, setAttachments] = useState<any[]>([]);
  items = attachments;
  const field = useRef({ focus() {} });
  useSelectionAttachments('c', setAttachments, field, () => accept);
  return h('i');
}
test('refusal returns false without committing a receipt; a supported image later commits once', async () => {
  const m = await mount(h(Probe));
  try {
    let result: boolean | undefined;
    await act(async () => {
      result = attachToComposer('c', { kind: 'file', path: '/local', name: 'local' });
    });
    assert.equal(result, false);
    assert.equal(items.length, 0);
    assert.deepEqual(drafts, {});
    accept = true;
    await m.render(h(Probe));
    await act(async () => {
      result = attachToComposer('c', { kind: 'image', path: '/image.png', name: 'image' });
    });
    assert.equal(result, true);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'image');
  } finally {
    await m.unmount();
  }
});

test('Reply in a machine chat retains the quote and annotation when its composer is closed', () => {
  machine = true;
  const attachment = { kind: 'selection' as const, path: '', name: 'Annotation', text: 'quoted reply', annotation: 'check this' };
  assert.equal(attachToComposer('machine-chat', attachment), true);
  assert.deepEqual(drafts['machine-chat'], { text: '', attachments: [attachment] });
});

test('the machine composer refuses unrelated local files and accepts selected text', () => {
  picked = 'box';
  const file = { kind: 'file' as const, path: '/local', name: 'local' };
  assert.equal(attachToComposer(null, file), false);
  assert.equal(drafts.home, undefined);
  const quote = { kind: 'selection' as const, path: '', name: 'Selection', text: 'quoted passage' };
  assert.equal(attachToComposer(null, quote), true);
  assert.deepEqual(drafts.home, { text: '', attachments: [quote] });
});
