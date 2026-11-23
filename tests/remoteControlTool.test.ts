// The set_remote_control tool (electron/capabilities/tools/remoteControl.cjs): the calling session only, Claude Code
// only (Codex and ACP chats are told they have no link and nothing changes), and a result only for what the session reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const {
  registerRemoteControlTool,
  UNSUPPORTED,
  NOT_RUNNING,
  NOT_SELF,
  ON,
  OFF,
} = require('../electron/capabilities/tools/remoteControl.cjs');

function setup(over: { view?: any; kinds?: Record<string, string> } = {}) {
  const controls: any[] = [];
  const api: { failWith?: unknown } = {};
  const kinds: Record<string, string> = { top: 'claude', kid: 'claude', other: 'claude', cx: 'codex', ac: 'acp', ...over.kinds };
  const r = new Registry();
  r.setApprover(async () => true);
  const dispose = registerRemoteControlTool(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    refOf: (id: string) => ({ kind: kinds[id], key: `${kinds[id]}:${id}` }),
    claude: {
      control: async (key: string, method: string, arg: any) => {
        if (api.failWith) throw api.failWith;
        controls.push([key, method, arg]);
        return 'view' in over ? over.view : { state: arg.on ? 'on' : 'off', url: 'https://claude.ai/code/session_a', error: null };
      },
    },
  });
  const call = async (args: any, chat = 'top', segment = 'seg') => {
    const res = await r.invoke(chat, segment, 'set_remote_control', args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error?.message ?? res.error, code: res.error?.code };
  };
  return {
    r,
    controls,
    call,
    dispose,
    set failWith(e: unknown) {
      api.failWith = e;
    },
  };
}

test('it is an act tool that asks the user, and removing it removes it', () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [['set_remote_control', 'act']],
  );
  t.dispose();
  assert.deepEqual(t.r.list(), []);
});

test('self turns the link on and off; the result never carries the page address', async () => {
  const t = setup();
  assert.deepEqual(await t.call({ enabled: true }), { remote_control: 'on', said: ON });
  assert.deepEqual(await t.call({ enabled: false, session_id: 'self' }), { remote_control: 'off', said: OFF });
  assert.deepEqual(await t.call({ enabled: true, session_id: ' SELF ' }), { remote_control: 'on', said: ON });
  assert.deepEqual(t.controls, [
    ['claude:top', 'remoteControl', { on: true }],
    ['claude:top', 'remoteControl', { on: false }],
    ['claude:top', 'remoteControl', { on: true }],
  ]);
  assert.ok(!ON.includes('http'));
});

test('it changes the session it is called from; naming another session is refused', async () => {
  const t = setup();
  assert.equal((await t.call({ enabled: true, session_id: 'kid' })).error, NOT_SELF);
  assert.equal((await t.call({ enabled: true, session_id: 'kid-handle' })).error, NOT_SELF);
  assert.equal((await t.call({ enabled: true, session_id: '   ' })).remote_control, 'on');
  assert.equal(t.controls.length, 1);
  assert.equal(t.controls[0][0], 'claude:top');
  assert.match(NOT_SELF, /Nothing changed/);
});

test('Codex and ACP chats are told they cannot be linked, and nothing is asked of them', async () => {
  const t = setup();
  assert.equal((await t.call({ enabled: true }, 'cx')).error, UNSUPPORTED.codex);
  assert.equal((await t.call({ enabled: false }, 'ac')).error, UNSUPPORTED.acp);
  const odd = setup({ kinds: { top: 'future' } });
  assert.equal((await odd.call({ enabled: true })).error, UNSUPPORTED.acp);
  assert.deepEqual([...t.controls, ...odd.controls], []);
  assert.match(UNSUPPORTED.codex, /Nothing changed/);
});

test('a session that is not running, a login that cannot, and a connect that failed are errors with what to do next', async () => {
  assert.equal((await setup({ view: null }).call({ enabled: true })).error, NOT_RUNNING);
  const unavailable = await setup({ view: { state: 'unavailable', error: 'Remote Control needs a login.' } }).call({ enabled: true });
  assert.equal(unavailable.error, 'Remote Control needs a login. Nothing changed. Tell the user.');
  const failed = await setup({ view: { state: 'error', error: 'network down' } }).call({ enabled: true });
  assert.equal(failed.error, 'Remote Control did not connect: network down. It is off. Tell the user.');
  const silent = await setup({ view: { state: 'error', error: null } }).call({ enabled: true });
  assert.match(silent.error, /no answer/);
  // turning it off reports off whatever the leftover state says
  assert.equal((await setup({ view: { state: 'error', error: 'x' } }).call({ enabled: false })).remote_control, 'off');
  // not a bare boolean: the registry checks the type, and a non-true value means off
  assert.equal((await setup().call({ enabled: 'yes' })).error, 'argument enabled must be boolean');
});

test('a call from a segment that owns no chat is refused', async () => {
  const t = setup();
  assert.match((await t.call({ enabled: true }, 'top', 'someone-else')).error, /does not own this chat segment/);
  assert.deepEqual(t.controls, []);
});

test('a request the session could not carry out is an error saying what may be true', async () => {
  const t = setup();
  t.failWith = new Error('Remote Control did not disconnect in time');
  assert.equal(
    (await t.call({ enabled: false })).error,
    'Remote Control could not be turned off: Remote Control did not disconnect in time. It may still be on. Tell the user.',
  );
  t.failWith = 'plain';
  assert.match((await t.call({ enabled: true })).error, /could not be turned on: plain\. It may still be off/);
});

test('a link that waits for the network or a sign-in is recorded, and the model is told it comes up by itself', async () => {
  for (const state of ['offline', 'signin']) {
    const res = await setup({ view: { state, url: null, error: 'x' } }).call({ enabled: true });
    assert.equal(res.remote_control, state);
    assert.match(res.said, /connects by itself/);
  }
});
