// Per-tab panel storage has one worker owner: accepted writes serialize with closure/replacement and retain drafts across retries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PanelState, bindingKey, composerKey } from '../electron/chrome-extension/src/panelState.mjs';
import { PanelTab } from '../electron/chrome-extension/src/panelTab.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { tick } from './support/extension-background/fixture.ts';
const logs = () => {
  const seen: [string, unknown][] = [];
  return { seen, log: (what: string, e: unknown) => seen.push([what, e]) };
};
const stateOf = (chrome: any) => new PanelState(chrome);
const forgetTab = (chrome: any, id: number, log: any) =>
  stateOf(chrome)
    .forget(id)
    .catch((e: any) => log('forget a closed tab’s chat', e));
const replaceTab = (chrome: any, added: number, removed: number, log: any) =>
  stateOf(chrome)
    .replace(added, removed)
    .then(
      () => true,
      (e: any) => {
        log('keep a replaced tab’s chat', e);
        return false;
      },
    );
test('a closed tab’s chat is forgotten; a replaced tab’s chat moves to the tab that replaced it', async () => {
  const chrome: any = fakeChromeApi();
  const { seen, log } = logs();
  await chrome.storage.session.set({ [bindingKey(3)]: { id: 'c1', title: 'One' }, [bindingKey(4)]: { id: 'c2', title: 'Two' } });
  forgetTab(chrome, 3, log);
  await tick();
  assert.equal(chrome.store.session[bindingKey(3)], undefined);
  await replaceTab(chrome, 40, 4, log);
  assert.deepEqual(chrome.store.session[bindingKey(40)], { id: 'c2', title: 'Two' });
  assert.equal(chrome.store.session[bindingKey(4)], undefined);
  // nothing kept for the old tab: nothing to move
  await replaceTab(chrome, 50, 5, log);
  assert.equal(chrome.store.session[bindingKey(50)], undefined);
  chrome.fail['storage.session.remove'] = new Error('gone');
  forgetTab(chrome, 40, log);
  await chrome.storage.session.set({ [bindingKey(6)]: { id: 'c3' } }).catch(() => {});
  await replaceTab(chrome, 60, 6, log);
  await tick();
  assert.deepEqual(
    seen.map(([w]) => w),
    ['forget a closed tab’s chat', 'keep a replaced tab’s chat'],
  );
});

test('drafts follow replacement and closure, and a retired panel cannot write its dead binding', async () => {
  const { draftKey } = await import('../electron/chrome-extension/src/panelTab.mjs');
  const chrome: any = fakeChromeApi();
  await chrome.storage.session.set({ [bindingKey(1)]: { id: 'old', title: 'Old' }, [draftKey(1)]: 'selected text' });
  await replaceTab(chrome, 2, 1, () => {});
  assert.equal(chrome.store.session[draftKey(1)], undefined);
  assert.equal(chrome.store.session[draftKey(2)], 'selected text');
  forgetTab(chrome, 2, () => {});
  await tick();
  assert.equal(chrome.store.session[draftKey(2)], undefined);
  const own = new PanelTab({ chrome, search: '?tabId=1', log: () => {} });
  own.retire(99);
  own.retire(1);
  own.bind({ id: 'late', title: 'Late' });
  assert.equal(chrome.store.session[bindingKey(1)], undefined);
});

test('invalid draft targets are ignored and non-Error Chrome failures retain a readable reply', async () => {
  const { ContextMenu } = await import('../electron/chrome-extension/src/contextMenu.mjs');
  const chrome: any = fakeChromeApi();
  const menu = new ContextMenu({ chrome, notify: () => {}, log: () => {} });
  assert.equal(await menu.take(Number.NaN), '');
  assert.equal(await menu.take(-1), '');
  const { background, ask } = await import('./support/extension-background/fixture.ts');
  const w = await background();
  try {
    w.chrome.fail['tabs.create'] = 'Chrome refused';
    const r = await ask(w.chrome, { type: 'download' });
    assert.equal((r as any).error, 'Chrome refused');
  } finally {
    w.warn.mock.restore();
    w.bg.client.dispose();
  }
});

test('accepted chat and composer writes settle before replacement; later old-panel writes are refused', async () => {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  const set = chrome.storage.session.set;
  let release: any;
  let first = true;
  chrome.storage.session.set = async (value: any) => {
    if (first) {
      first = false;
      await new Promise((r) => {
        release = r;
      });
    }
    await set(value);
  };
  const binding = state.bind(1, { id: 'chat', title: 'Chat' });
  const draft = state.keep(1, 'Unsent text');
  await tick();
  const replacing = state.replace(2, 1);
  assert.throws(() => state.bind(1, { id: 'late' }), /replaced/);
  release();
  await Promise.all([binding, draft, replacing]);
  assert.deepEqual(chrome.store.session[bindingKey(2)], { id: 'chat', title: 'Chat' });
  assert.equal(chrome.store.session[composerKey(2)], 'Unsent text');
  assert.equal(chrome.store.session[composerKey(1)], undefined);
  assert.equal(chrome.store.session[bindingKey(1)], undefined);
  await state.bind(2, null, false);
  assert.equal(chrome.store.session[bindingKey(2)], undefined, 'system recovery does not persist a user New choice');
});

test('a rejected write does not poison subsequent writes, and closing retires all three keys', async () => {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  chrome.fail['storage.session.set'] = new Error('quota');
  await assert.rejects(state.keep(1, 'First'), /quota/);
  delete chrome.fail['storage.session.set'];
  await state.keep(1, 'Retry');
  await state.keep(1, 'Selected', true);
  await state.bind(1, null);
  await state.forget(1);
  assert.deepEqual(chrome.store.session, {});
  assert.throws(() => state.keep(1, 'late'), /closed/);
  assert.equal(await state.take(1), '');
  assert.throws(() => state.bind(Number.NaN, null), /closed/);
});

test('a panel retries a failed composer write, but an older failure cannot erase a newer draft acknowledgement', async () => {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  const seen: unknown[] = [];
  chrome.reply = async (m: any) => {
    try {
      await state.keep(m.tabId, m.text);
      return {};
    } catch (e: any) {
      return { error: e.message };
    }
  };
  const own = new PanelTab({ chrome, search: '?tabId=1', log: (_w, e) => seen.push(e) });
  own.draftReady = true;
  chrome.fail['storage.session.set'] = new Error('quota');
  own.keepDraft('Retry me');
  own.flushDraft();
  await tick();
  assert.equal(seen.length, 1);
  delete chrome.fail['storage.session.set'];
  own.keepDraft('Retry me');
  own.flushDraft();
  await tick();
  assert.equal(chrome.store.session[composerKey(1)], 'Retry me');
  let fail: any;
  chrome.reply = (m: any) =>
    m.text === 'Old'
      ? new Promise((r) => {
          fail = r;
        })
      : Promise.resolve({});
  own.keepDraft('Old');
  own.flushDraft();
  await tick();
  own.keepDraft('New');
  own.flushDraft();
  await tick();
  fail({ error: 'Old failed' });
  await tick();
  assert.equal(own.lastDraft, 'New');
});

test('a failed replacement is repaired before a new write, so recovery cannot overwrite that write', async () => {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  await state.bind(1, { id: 'old' });
  await state.keep(1, 'Old draft');
  chrome.fail['storage.session.set'] = new Error('quota');
  await assert.rejects(state.replace(2, 1), /quota/);
  await assert.rejects(state.repair(2), /quota/);
  delete chrome.fail['storage.session.set'];
  await state.bind(2, { id: 'new' });
  await state.keep(2, 'New draft');
  await state.repair(2);
  assert.equal(chrome.store.session[composerKey(2)], 'New draft');
  assert.equal(chrome.store.session[bindingKey(2)].id, 'new');
  assert.equal(chrome.store.session[composerKey(1)], undefined);
  assert.throws(() => state.keep(2, 'x'.repeat(100_001)), /too long/);
  chrome.fail['storage.session.set'] = new Error('quota');
  await assert.rejects(state.replace(3, 2), /quota/);
  delete chrome.fail['storage.session.set'];
  await state.keep(3, 'A newer draft');
  assert.equal(chrome.store.session[composerKey(3)], 'A newer draft');
});

test('panel restoration propagates failed repairs; replacing a chosen chat preserves it and retires old draft timers', async () => {
  const chrome: any = fakeChromeApi();
  const writes: any[] = [];
  chrome.reply = async (m: any) => {
    writes.push(m);
    return { error: 'Repair unavailable' };
  };
  const own = new PanelTab({ chrome, search: '?tabId=1', log: () => {} });
  await assert.rejects(own.bound(), /Repair unavailable/);
  await assert.rejects(own.draft(), /Repair unavailable/);
  chrome.reply = async (m: any) => {
    writes.push(m);
    return undefined;
  };
  await own.bound();
  await own.draft();
  own.bind({ id: 'chosen', title: 'Chosen' });
  own.keepDraft('Not yet flushed');
  own.retire(1);
  own.flushDraft();
  own.follow(2);
  own.flushDraft();
  await tick();
  assert.ok(writes.some((m) => m.type === 'panelBind' && m.tabId === 2 && m.chat.id === 'chosen'));
  assert.equal(
    writes.some((m) => m.type === 'panelDraft'),
    false,
  );
});

test('replacement repairs survive worker restart, chain through earlier replacements, and close removes every pending source', async () => {
  const chrome: any = fakeChromeApi();
  let state = new PanelState(chrome);
  await state.bind(1, { id: 'chat' });
  await state.keep(1, 'Unsent');
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async (value: any) => {
    if (Object.keys(value).some((k) => k.startsWith('panelChat:'))) throw new Error('data write unavailable');
    return set(value);
  };
  await assert.rejects(state.replace(2, 1), /data write unavailable/);
  state = new PanelState(chrome);
  await assert.rejects(state.repair(2), /data write unavailable/);
  chrome.storage.session.set = set;
  await state.repair(2);
  assert.equal(chrome.store.session[bindingKey(2)].id, 'chat');
  assert.equal(chrome.store.session[composerKey(2)], 'Unsent');
  assert.equal(chrome.store.session['panelMove:2'], undefined);
  chrome.fail['storage.session.set'] = new Error('quota');
  await assert.rejects(state.replace(3, 2), /quota/);
  delete chrome.fail['storage.session.set'];
  const configure = chrome.sidePanel.setOptions;
  chrome.sidePanel.setOptions = async (o: any) => {
    assert.equal(o.tabId, 4, 'a chained intermediate target is already gone');
    return configure(o);
  };
  await state.replace(4, 3);
  chrome.sidePanel.setOptions = configure;
  assert.equal(chrome.store.session[composerKey(4)], 'Unsent');
  assert.equal(chrome.store.session[composerKey(2)], undefined);
  chrome.storage.session.set = async (value: any) => {
    if (Object.keys(value).some((k) => k.startsWith('panelChat:'))) throw new Error('data write unavailable');
    return set(value);
  };
  await assert.rejects(state.replace(5, 4), /data write unavailable/);
  state = new PanelState(chrome);
  await state.forget(5);
  assert.deepEqual(chrome.store.session, {});
});

test('replacing an unrelated tab never enables its side panel; an opened empty panel does follow replacement', async () => {
  const chrome: any = fakeChromeApi();
  const state = new PanelState(chrome);
  await state.replace(2, 1);
  assert.equal(chrome.log.filter((l: any) => l[0] === 'sidePanel.setOptions').length, 0);
  await state.repair(3, true);
  await state.replace(4, 3);
  assert.deepEqual(
    chrome.log.filter((l: any) => l[0] === 'sidePanel.setOptions').map((l: any) => l[1].tabId),
    [4],
  );
  await state.forget(4);
  assert.deepEqual(chrome.store.session, {});
});
