// Chat-targeted queue recovery retains drafts when no composer is mounted and preserves existing append callers.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';
const { store: S, resetState } = await loadStore();
beforeEach(() => {
  resetState();
  resetAll();
});
test('prepend recovery preserves original chat draft, attachments, and goal when unmounted', () => {
  const old = { kind: 'file', path: '/old', name: 'old' },
    incoming = { kind: 'file', path: '/new', name: 'new' };
  S.useStore.setState({
    drafts: { origin: { text: 'draft', attachments: [old], goal: true }, other: { text: 'other', attachments: [] } },
  } as any);
  S.giveBackToComposer('origin', 'queued', [incoming] as any, true);
  assert.deepEqual(S.useStore.getState().drafts.origin, { text: 'queued\ndraft', attachments: [incoming, old], goal: true });
  assert.equal(S.useStore.getState().drafts.other.text, 'other');
  S.giveBackToComposer('empty', 'queued', [], true);
  assert.deepEqual(S.useStore.getState().drafts.empty, { text: 'queued', attachments: [] });
});
test('ordinary recovery still appends without replacing existing input or adding duplicate newline', () => {
  for (const text of ['', 'old', 'old\n']) {
    S.useStore.setState({ drafts: { origin: { text, attachments: [] } } });
    S.giveBackToComposer('origin', 'new');
    assert.equal(S.useStore.getState().drafts.origin.text, text ? 'old\nnew' : 'new');
  }
  S.giveBackToComposer('missing', 'new');
  // the new chat's box (null, the Chrome extension's Try it) keeps its saved draft under "home", after what is there
  S.useStore.setState({ drafts: { ...S.useStore.getState().drafts, home: { text: 'mine', attachments: [] } } });
  S.giveBackToComposer(null, 'sample');
  assert.equal(S.useStore.getState().drafts.home.text, 'mine\nsample');
  assert.equal(S.useStore.getState().drafts.missing.text, 'new');
});

test('a mounted composer acknowledgement owns recovery without duplicating the saved draft', () => {
  S.useStore.setState({ drafts: { origin: { text: 'stored', attachments: [] } } });
  let received: any;
  const take = (event: Event) => {
    received = (event as CustomEvent).detail;
    received.handled = true;
  };
  window.addEventListener('composer-insert', take);
  try {
    S.giveBackToComposer('origin', 'queued', [], true);
    assert.equal(received.threadId, 'origin');
    assert.equal(received.prepend, true);
    assert.equal(S.useStore.getState().drafts.origin.text, 'stored');
  } finally {
    window.removeEventListener('composer-insert', take);
  }
});

test('a receiver that retires without acknowledging falls back once to the original saved draft', () => {
  const attachment = { kind: 'file', path: '/queued', name: 'queued' };
  S.useStore.setState({ drafts: { origin: { text: 'latest', attachments: [], goal: true } } });
  let offers = 0;
  const retired = () => {
    offers++;
  };
  window.addEventListener('composer-insert', retired);
  try {
    S.giveBackToComposer('origin', 'queued', [attachment] as any, true);
    assert.equal(offers, 1);
    assert.deepEqual(S.useStore.getState().drafts.origin, { text: 'queued\nlatest', attachments: [attachment], goal: true });
  } finally {
    window.removeEventListener('composer-insert', retired);
  }
});
