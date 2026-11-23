// Cached search rows observe terminal deletion receipts and late aliases without store updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act } from 'react';
import { type } from './support/shell-chrome-kit.ts';
import { searchPaletteKit, thread } from './support/search-palette-kit.ts';

const kit = await searchPaletteKit();
const { store, reset, open, debounce, input, items, item, mount } = kit;
const { deletionVisibility } = await import('../src/store/deletionVisibility.ts');

test('cached remote-only search row disappears immediately after receipt', async () => {
  reset();
  kit.remote = { codex: [thread('cached-main', 'Remote Match'), thread('cached-other', 'Other Match')], claude: [], sage: [] };
  const { host, unmount } = await mount();
  try {
    await open();
    await type(input(host), 'Match');
    await debounce();
    assert.ok(items(host).includes('Remote Match'));
    const stale = item(host, 'Remote Match');
    await act(async () => {
      deletionVisibility.accept({ chatId: 'cached-main', nativeKeys: ['cached-main'], nativeDeleted: true, metadata: 'retained' });
      stale.click();
    });
    assert.equal(store.getState().route, null);
    assert.equal(items(host).includes('Remote Match'), false);
    assert.ok(items(host).includes('Other Match'));
  } finally {
    await unmount();
  }
});

test('stale search alias metadata preserves a live chat until an authoritative additive receipt retires it', async () => {
  reset();
  const id = 'cached-late-main';
  kit.remote = { codex: [thread(id, 'Remote Match'), thread('cached-late-other', 'Other Match')], claude: [], sage: [] };
  const { host, unmount } = await mount();
  try {
    await open();
    await type(input(host), 'Match');
    await debounce();
    await act(async () => {
      deletionVisibility.accept({ chatId: 'terminal-owner', nativeKeys: ['terminal-owner'], nativeDeleted: true, metadata: 'retained' });
      deletionVisibility.filter({ segments: { 'terminal-owner': [{ nativeId: id, harness: 'codex' }] } } as any);
    });
    assert.ok(items(host).includes('Remote Match'));
    await act(async () => item(host, 'Remote Match').click());
    assert.deepEqual(store.getState().route, { name: 'thread', id });
    await act(async () => store.setState({ route: null }));
    await open();
    await type(input(host), 'Match');
    await debounce();
    const stale = item(host, 'Remote Match');
    await act(async () => {
      deletionVisibility.accept({
        chatId: 'terminal-owner',
        nativeKeys: ['terminal-owner'],
        retainedAliasKeys: [id],
        nativeDeleted: true,
        metadata: 'retained',
      });
      stale.click();
    });
    assert.equal(store.getState().route, null);
    assert.equal(items(host).includes('Remote Match'), false);
    assert.ok(items(host).includes('Other Match'));
    await act(async () => {
      // An older original receipt and a duplicate expanded certificate only union terminal identities.
      deletionVisibility.accept({ chatId: 'terminal-owner', nativeKeys: ['terminal-owner'], nativeDeleted: true, metadata: 'retained' });
      deletionVisibility.accept({
        chatId: 'terminal-owner',
        nativeKeys: ['terminal-owner'],
        retainedAliasKeys: [id],
        nativeDeleted: true,
        metadata: 'retained',
      });
    });
    assert.equal(items(host).includes('Remote Match'), false);
    assert.ok(items(host).includes('Other Match'));
  } finally {
    await unmount();
  }
});

test('unrelated remote search rows remain selectable by mouse and keyboard after a deletion', async () => {
  for (const method of ['mouse', 'keyboard']) {
    reset();
    const id = `select-${method}`;
    kit.remote = { codex: [thread(id, 'Selectable Match')], claude: [], sage: [] };
    const { host, unmount } = await mount();
    try {
      await open();
      await type(input(host), 'Match');
      await debounce();
      await act(async () => {
        deletionVisibility.accept({
          chatId: `unrelated-${method}`,
          nativeKeys: [`unrelated-${method}`],
          nativeDeleted: true,
          metadata: 'retained',
        });
      });
      await act(async () => {
        if (method === 'mouse') item(host, 'Selectable Match').click();
        else input(host).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      assert.deepEqual(store.getState().route, { name: 'thread', id });
      assert.equal(store.getState().threads[id].title, 'Selectable Match');
    } finally {
      await unmount();
    }
  }
});

test('a terminal receipt prevents a stale keyboard-selected search row from navigating', async () => {
  reset();
  kit.remote = { codex: [thread('keyboard-terminal', 'Keyboard Match')], claude: [], sage: [] };
  const { host, unmount } = await mount();
  try {
    await open();
    await type(input(host), 'Match');
    await debounce();
    await act(async () => {
      deletionVisibility.accept({
        chatId: 'keyboard-terminal',
        nativeKeys: ['keyboard-terminal'],
        nativeDeleted: true,
        metadata: 'retained',
      });
      input(host).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    assert.equal(store.getState().route, null);
    assert.equal(store.getState().searchOpen, true);
    assert.equal(items(host).includes('Keyboard Match'), false);
  } finally {
    await unmount();
  }
});

test('receipt applied synchronously while closing the palette still prevents the selected row from opening', async () => {
  reset();
  const id = 'close-reentrant-terminal';
  kit.remote = { codex: [thread(id, 'Reentrant Match')], claude: [], sage: [] };
  const { host, unmount } = await mount();
  let unsubscribe = () => {};
  try {
    await open();
    await type(input(host), 'Match');
    await debounce();
    let applied = false;
    unsubscribe = store.subscribe(() => {
      if (!store.getState().searchOpen && !applied) {
        applied = true;
        deletionVisibility.accept({ chatId: id, nativeKeys: [id], nativeDeleted: true, metadata: 'retained' });
      }
    });
    await act(async () => item(host, 'Reentrant Match').click());
    assert.equal(applied, true);
    assert.equal(store.getState().route, null);
    assert.equal(store.getState().threads[id], undefined);
  } finally {
    unsubscribe();
    await unmount();
  }
});

test('current segment ownership remaps cached matches and blocks stale mouse/keyboard selection', async () => {
  for (const method of ['mouse', 'keyboard']) {
    reset();
    const alias = `claude:alias-${method}`;
    const root = `canonical-${method}`;
    kit.remote = { codex: [], claude: [thread(alias, 'Alias Match')], sage: [] };
    const { host, unmount } = await mount();
    try {
      await open();
      await type(input(host), 'Match');
      await debounce();
      const stale = item(host, 'Alias Match');
      await act(async () => {
        store.setState({
          segments: { [root]: [{ nativeId: root }, { nativeId: alias }] },
          threads: { [root]: thread(root, 'Canonical discussion') },
        });
        if (method === 'mouse') stale.click();
        else input(host).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      assert.equal(store.getState().route, null);
      assert.ok(items(host).includes('Canonical discussion'));
      assert.equal(items(host).includes('Alias Match'), false);
      const canonical = item(host, 'Canonical discussion');
      await act(async () => {
        store.setState({ threads: {} });
        if (method === 'mouse') canonical.click();
        else input(host).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      assert.equal(store.getState().route, null);
      assert.equal(items(host).includes('Canonical discussion'), false);
      await act(async () => store.setState({ threads: { [root]: thread(root, 'Canonical discussion') } }));
      await act(async () => item(host, 'Canonical discussion').click());
      assert.deepEqual(store.getState().route, { name: 'thread', id: root });
    } finally {
      await unmount();
    }
  }
});

test('ordinary local search selection remains available before any remote result', async () => {
  reset();
  const { host, unmount } = await mount();
  try {
    await open();
    await act(async () => item(host, 'Alpha fix').click());
    assert.deepEqual(store.getState().route, { name: 'thread', id: 'a' });
  } finally {
    await unmount();
  }
});
