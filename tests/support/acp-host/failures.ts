// ACP host failures unit cases with shared fake-agent and transcript fixtures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acp, until, KEY, CWD, setup, INIT, NO_REPLY } from './fixture';

export function registerFailuresCases() {
  test('readTextFile: an error without a code is named by its message', (t) => {
    t.mock.method(fs, 'readFileSync', () => {
      throw new Error('weird failure');
    });
    assert.throws(
      () => acp.readTextFile({ path: '/abs/file' }),
      (e: any) => e.code === -32002 && /Couldn't read \/abs\/file: weird failure/.test(e.message),
    );
  });

  test('a start, reopen or prompt that fails with a non-Error is reported as text', async (t) => {
    const init = t.mock.method(acp.AcpAgent.prototype, 'initialize', async () => {
      throw 'no handshake';
    });
    const a = setup();
    await assert.rejects(a.host.agent('fake'), /Fake didn't start: no handshake$/);
    init.mock.restore();

    const realRequest = acp.AcpAgent.prototype.request;
    t.mock.method(acp.AcpAgent.prototype, 'request', function (this: any, method: string, ...rest: any[]) {
      if (method === 'session/load') return Promise.reject('load refused');
      if (method === 'session/prompt') return Promise.reject('prompt refused');
      return realRequest.call(this, method, ...rest);
    });
    const b = setup({ handlers: { initialize: () => INIT({ loadSession: true }) } });
    b.items.append(KEY, { t: 'session', sessionId: 'old', cwd: CWD });
    await b.host.ensure(KEY, {});
    assert.match(b.events.find((e) => e.kind === 'session').note, /\(load refused\)/);
    await b.host.send(KEY, { blocks: [] });
    await until(() => b.kinds().includes('turnEnd'));
    assert.equal(b.events.at(-1).error, 'prompt refused');
  });

  test('reapplying options on a session that offers none skips them', async () => {
    const t = setup({ handlers: { 'session/new': () => ({ sessionId: 's' }) } });
    t.items.append(KEY, { t: 'config', configId: 'model', value: 'b' });
    const chat = await t.host.ensure(KEY, { cwd: CWD });
    assert.equal(chat.state.configOptions ?? null, null);
    assert.equal(
      t.sp.procs[0].received.some((m: any) => m.method === 'session/set_config_option'),
      false,
    );
  });

  test("an ignored Stop cancels the chat's open permission cards, not another chat's", async () => {
    const t = setup({ handlers: { 'session/prompt': () => NO_REPLY } });
    const chat = await t.host.ensure(KEY, { cwd: CWD });
    await t.host.send(KEY, { blocks: [] });
    const proc = t.sp.procs[0];
    const ask = proc.request('session/request_permission', {
      sessionId: chat.sessionId,
      toolCall: { title: 'rm -rf' },
      options: [{ kind: 'allow_once', optionId: 'y' }],
    });
    await until(() => t.kinds().includes('permission'));
    const other = { key: 'acp:fake:other', resolve: () => assert.fail('not cancelled') };
    t.host.perms.set('other', other);
    t.host.cancel(KEY);
    assert.deepEqual((await ask).result, { outcome: { outcome: 'cancelled' } });
    const cancelled = t.events.find((e) => e.kind === 'permissionCancelled');
    assert.equal(cancelled.key, KEY);
    assert.equal(t.host.perms.get('other'), other);
    await until(() => t.kinds().includes('turnEnd'), 1000);
  });

  test('sign-in with a short-lived agent: no args or env from the quirks or their launch means none', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = setup({
        quirks: (id: string) => (id === 'bare' ? { label: 'Bare' } : id === 'empty' ? { label: 'Empty', launch: async () => ({}) } : null),
      });
      for (const id of ['bare', 'empty']) {
        const p = t.host.agentForLogin(id);
        for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
        await p;
      }
      assert.deepEqual(
        t.sp.calls.map((c: any) => [c.args, c.options.env]),
        [
          [[], { BASE: '1' }],
          [[], { BASE: '1' }],
        ],
      );
    } finally {
      mock.timers.reset();
    }
  });

  test('search: a transcript that cannot be read matches nothing; the next search reads it again', async (t) => {
    const s = setup();
    const a = 'acp:fake:a';
    s.items.append(a, { t: 'session', sessionId: 's', cwd: '/a' }, { t: 'update', update: { text: 'deep needle' } });
    const file = s.items.file(a);
    await s.items.flush(a);
    // the search reads each transcript once, for its title and its text alike
    fs.chmodSync(file, 0);
    assert.deepEqual(await s.host.search('needle'), []);
    fs.chmodSync(file, 0o600);
    assert.deepEqual(
      (await s.host.search('needle')).map((c: any) => c.id),
      [a],
    );
  });
}
