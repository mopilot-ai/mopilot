// ⇧⌘N for a user whose new chats run on a basic harness: the temporary chat runs on Claude Code, so it is refused, with
// why, while Claude Code can't run here (src/store/chats.ts temporaryChatBlocked; App.tsx reads it).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, resetAll } from './support/store-harness.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const claude = (state: string) => set({ claude: { status: { state } as any, models: [] } });

beforeEach(() => {
  resetState();
  resetAll();
});

test('a temporary chat is refused while the harness it would run on cannot run, and allowed otherwise', () => {
  claude('signin');
  // new chats on Codex or Claude Code: nothing to refuse
  assert.equal(S.temporaryChatBlocked(), null);
  set({
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    basicListed: true,
  });
  assert.equal(S.temporaryChatBlocked(), 'Temporary chats need Claude Code. Sign in to it or install it first');
  // still being looked for: it may yet run
  claude('detecting');
  assert.equal(S.temporaryChatBlocked(), null);
  for (const state of ['ready', 'apikey']) {
    claude(state);
    assert.equal(S.temporaryChatBlocked(), null, state);
  }
});

test('a temporary chat set up before the harness it runs on stopped running is refused at send, and the text is kept', async () => {
  set({
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
    basicListed: true,
  });
  claude('ready');
  set({ newChatTemporary: true });
  claude('signin');
  assert.equal(await S.createChatThread('hi'), null);
  // sendMessage resolves false, so the composer keeps what was typed
  assert.equal(await S.sendMessage(null, 'hi'), false);
  assert.deepEqual(
    st().toasts.map((t: any) => [t.text, t.kind]),
    [
      ['Temporary chats need Claude Code. Sign in to it or install it first', 'error'],
      ['Temporary chats need Claude Code. Sign in to it or install it first', 'error'],
    ],
  );
  assert.equal(st().newChatTemporary, true, 'still a temporary chat once Claude Code is signed in');
});
