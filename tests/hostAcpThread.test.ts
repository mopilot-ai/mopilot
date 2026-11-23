// A chat for a machine, renderer side (src/session/harness/acpHost.ts): made by main first, then listed here in the machine's folder.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acpHost.ts');
const { openAcpThread } = await import('../src/session/harness/acp.ts');

const log: any[] = [];
const rec =
  (name: string, ret: any = undefined) =>
  (...args: any[]) => (log.push([name, ...args]), typeof ret === 'function' ? ret(...args) : ret);

beforeEach(() => {
  reset();
  log.length = 0;
});

test("a chat on a machine is made by main first, then listed here in the machine's folder, fresh, with nothing of this Mac unhidden or registered", async () => {
  fx.native.host = { startChat: rec('startChat', async () => ({ chatId: 'x' })) };
  fx.native.acp = { history: rec('history', async () => []) };
  const id = await acp.startHostAcpThread({ host: { id: 'box', path: '/srv/app' }, harness: 'kimi' });
  assert.match(id, /^acp:kimi:/);
  assert.deepEqual(log, [['startChat', { chatId: id, hostId: 'box', folder: '/srv/app', harness: 'kimi', projectId: null }]]);
  assert.equal(called('upsertThread')[0][0].cwd, '/srv/app');
  assert.equal(called('upsertThread')[0][0].projectId, null);
  assert.deepEqual(called('unhideFolder'), []);
  assert.deepEqual(called('rememberChatProject'), [[id, undefined]], 'no project, nothing to keep (the store ignores it)');
  // it has no history until it is sent to
  await openAcpThread(id);
  assert.equal(fx.state.runtime[id].loaded, true);
  assert.equal(log.filter((x) => x[0] === 'history').length, 0);
  // a project's id rides along
  const other = await acp.startHostAcpThread({ host: { id: 'box', path: '/srv/app' }, harness: 'kimi', projectId: 'p' });
  assert.equal((log.at(-1) as any)[1].projectId, 'p');
  assert.equal(called('upsertThread')[1][0].projectId, 'p');
  // the project is kept for the chat, because the machine's folder matches no project root on this Mac
  assert.deepEqual(called('rememberChatProject').at(-1), [other, 'p']);
  assert.notEqual(other, id);
});

test('a Claude Code or Codex chat on a machine is listed under its Host-family id, and main is told the family', async () => {
  fx.native.host = { startChat: rec('startChat', async () => ({ chatId: 'x' })) };
  for (const family of ['claude', 'codex']) {
    const id = await acp.startHostAcpThread({ host: { id: 'box', path: '/srv/app', scope: 'paired' }, harness: family });
    assert.match(id, new RegExp(`^acp:host-${family}:`));
    assert.deepEqual(log.at(-1), [
      'startChat',
      { chatId: id, hostId: 'box', folder: '/srv/app', harness: family, projectId: null, scope: 'paired' },
    ]);
  }
});

test('a machine that refuses the chat leaves no thread behind', async () => {
  fx.native.host = {
    startChat: async () => {
      throw Object.assign(new Error('That machine is not in the list.'), { code: 'unknown_machine' });
    },
  };
  await assert.rejects(acp.startHostAcpThread({ host: { id: 'gone', path: '/x' }, harness: 'kimi' }), /not in the list/);
  assert.deepEqual(called('upsertThread'), []);
});
