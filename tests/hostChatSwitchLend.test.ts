// The key this Mac lends with a message to a machine follows the agent the message runs on, not the one the chat's id names (electron/host/remoteCredentials.cjs, remoteSendDelivery.cjs, wiring.cjs `kindOfChat`): after a switch from Claude Code to Codex on a machine that has only lent keys, the next send lends the Codex key (A), the held choice counts before the Host has settled it (W), and a chat that never switched is lent as before (B).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withCredentials, NO_ORG } = require('../electron/host/remoteCredentials.cjs');
const { deliverRemote } = require('../electron/host/remoteSendDelivery.cjs');
const { kindOfChat } = require('../electron/host/wiring.cjs');

const CHAT = 'claude:3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c';
const KEYS: Record<string, string> = {
  claude: 'sk-ant-claude-0000000000000000',
  codex: 'sk-openai-codex-00000000000000',
  gemini: 'AIza-gemini-0000000000000000',
};

/** A machine's connection that records what it is told, wrapped as the app wraps it. */
function machine() {
  const told: any[] = [];
  const remote: any = {
    modelKey: async (p: any) => void told.push(['modelKey', p.harness, p.key]),
    send: async (chatId: string, item: any, opts: any) => (told.push(['send', chatId, item, opts]), { result: {} }),
    permit: async () => undefined,
    switchTo: async (chatId: string, pick: any) => (told.push(['switchTo', chatId, pick.harness]), { pending: { harness: pick.harness } }),
  };
  const host = withCredentials(remote, { forHarness: (h: string) => KEYS[h] ?? null, hasFor: (h: string) => h in KEYS }, NO_ORG);
  return { host, told };
}

/** One queued message delivered through the outbox's own delivery code. */
async function deliver(host: any, kindOf?: (chatId: string) => string | undefined, held: string | null = null) {
  const entry = {
    chatId: CHAT,
    key: 'key-lend-00000001',
    epoch: 3,
    state: 'queued',
    options: { item: { text: 'hello', attachments: [], opts: {} } },
  };
  await deliverRemote(entry, { hostId: 'm1', epoch: 3, folder: '/srv' }, host, {
    checks: { validate: async () => undefined },
    subscribed: async () => undefined,
    disposed: () => false,
    outbox: { pending: () => [{ key: entry.key, state: 'queued' }] },
    ownerOf: () => ({ hostId: 'm1', epoch: 3, folder: '/srv' }),
    state: () => ({ get: () => (held ? { pendingSwitch: { harness: held } } : undefined) }),
    projection: { remember: () => undefined, forget: () => undefined },
    hostFor: () => host,
    ...(kindOf ? { kindOf } : {}),
  });
}

test('A: a chat that switched from Claude Code to Codex is lent the Codex key with its next message, and the key rides no further than this Mac', async () => {
  const m = machine();
  await deliver(m.host, () => 'codex');
  assert.deepEqual(
    m.told.map((t) => t.slice(0, 3).map((x: any) => (typeof x === 'object' ? undefined : x))),
    [
      ['modelKey', 'codex', KEYS.codex],
      ['send', CHAT, undefined],
    ],
  );
  // the item the Host connection takes names the agent for the lending only; the wire call picks its own fields
  assert.equal(m.told[1][2].lendAs, 'codex');
});

test('A: a chat that switched to a basic agent is lent that agent’s key, and one with no key lends nothing', async () => {
  const m = machine();
  await deliver(m.host, () => 'acp:gemini');
  assert.deepEqual(m.told[0], ['modelKey', 'gemini', KEYS.gemini]);
  const none = machine();
  await deliver(none.host, () => 'acp:kimi');
  assert.equal(none.told.filter((t) => t[0] === 'modelKey').length, 0);
});

test('B: a chat that never switched is lent the key its id names, as before', async () => {
  const m = machine();
  await deliver(m.host);
  assert.deepEqual(m.told[0], ['modelKey', 'claude', KEYS.claude]);
  assert.equal('lendAs' in m.told[1][2], false);
});

test('W: a held switch moves the key to lend (this message settles it) but never the picks: the mode and model are applied to the agent the chat is on now', async () => {
  const m = machine();
  await deliver(m.host, () => 'acp:gemini', 'codex');
  assert.deepEqual(m.told[0], ['modelKey', 'codex', KEYS.codex]);
  assert.equal(m.told[1][2].lendAs, 'codex');
  const { remotePicks } = require('../electron/host/remotePicks.cjs');
  // the chat is on a basic agent with a held switch to Claude Code: its picks name the basic agent, which has no permission mode to set
  const live = {
    chats: { get: () => ({ meta: { config: { hostAgent: 'acp:kimi' } } }) },
    controller: { state: { get: () => ({ pendingSwitch: { harness: 'claude' } }) }, ref: () => ({ kind: 'acp:host-claude' }) },
  };
  const kind = kindOfChat(live, CHAT);
  assert.equal(kind, 'acp:kimi');
  const picks = remotePicks({ chatId: CHAT, hostId: 'm1', opts: {}, kind });
  assert.equal('hostMode' in picks, false);
});

test('W: the agent a chat runs on now is the one its Host last said, then this Mac\u2019s own reading', () => {
  const chat = (config: object) => ({ get: () => ({ meta: { config } }) });
  assert.equal(
    kindOfChat({ chats: chat({ hostAgent: 'codex' }), controller: { ref: () => ({ kind: 'acp:host-claude' }) } }, CHAT),
    'codex',
  );
  assert.equal(kindOfChat({ chats: chat({}), controller: { ref: () => ({ kind: 'acp:host-claude' }) } }, CHAT), 'claude');
  assert.equal(kindOfChat({ chats: chat({}), controller: { ref: () => ({ kind: 'acp:host-codex' }) } }, CHAT), 'codex');
  assert.equal(kindOfChat({ chats: chat({}), controller: { ref: () => ({ kind: 'acp:kimi' }) } }, CHAT), 'acp:kimi');
  assert.equal(kindOfChat({ chats: chat({}), controller: { ref: () => ({ kind: 'codex' }) } }, CHAT), 'codex');
  assert.equal(kindOfChat({ chats: chat({}), controller: { ref: () => ({ kind: 'nonsense' }) } }, CHAT), undefined);
  assert.equal(kindOfChat({}, CHAT), undefined);
});

test('A: the agent a chat is moved to gets its key before the Host is asked, so a signed-out agent with a lent key is ready when the Host judges it', async () => {
  const m = machine();
  await m.host.switchTo(CHAT, { harness: 'codex' }, { key: 'k' });
  assert.deepEqual(m.told, [
    ['modelKey', 'codex', KEYS.codex],
    ['switchTo', CHAT, 'codex'],
  ]);
  // a basic agent is lent its own key; one with no key lent is just asked
  const acp = machine();
  await acp.host.switchTo(CHAT, { harness: 'acp:gemini' });
  assert.deepEqual(acp.told[0], ['modelKey', 'gemini', KEYS.gemini]);
  const none = machine();
  await none.host.switchTo(CHAT, { harness: 'acp:kimi' });
  assert.deepEqual(none.told, [['switchTo', CHAT, 'acp:kimi']]);
});
