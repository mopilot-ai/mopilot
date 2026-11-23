// ACP host signin unit cases with shared fake-agent and transcript fixtures.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setup, NO_REPLY } from './fixture';

export function registerSigninCases() {
  test('sign-in: a slow browser sign-in is not cut off at a minute, and a process that does not start is not left running', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = setup({ handlers: { authenticate: () => NO_REPLY } });
      const p = t.host.authenticate('fake', 'oauth');
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      const proc = t.sp.procs[0];
      // the user is still in the browser after five minutes: the process is still there
      mock.timers.tick(5 * 60_000);
      assert.deepEqual(proc.kills, []);
      // past the cap it gives up, and the process goes
      mock.timers.tick(10 * 60_000);
      await assert.rejects(p, /authenticate timed out/);
      mock.timers.tick(2000);
      assert.deepEqual(proc.kills, ['SIGTERM']);
      // one whose initialize fails is ended at once
      const bad = setup({ handlers: { initialize: () => ({ protocolVersion: 3 }) } });
      await assert.rejects(bad.host.authenticate('fake', 'oauth'), /ACP v3/);
      mock.timers.tick(2000);
      assert.deepEqual(bad.sp.procs[0].kills, ['SIGTERM']);
    } finally {
      mock.timers.reset();
    }
  });

  test('sign-in: through the running agent, or a short-lived one; nothing for a harness that is not installed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let releaseAuth!: () => void;
      let firstAuth = true;
      const t = setup({
        handlers: {
          authenticate: () => {
            if (!firstAuth) return {};
            firstAuth = false;
            return new Promise((resolve) => {
              releaseAuth = () => resolve({});
            });
          },
        },
        quirks: (id: string) =>
          id === 'fake'
            ? { label: 'Fake', args: ['acp'], env: { Q: '1' } }
            : id === 'l'
              ? { label: 'L', launch: async () => ({ env: { L: '1' } }) }
              : null,
      });
      await assert.rejects(t.host.authenticate('nope', 'm'), /nope isn't installed/);
      const p = t.host.authenticate('fake', 'oauth');
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const proc = t.sp.procs[0];
      assert.deepEqual(proc.received.find((m: any) => m.method === 'authenticate').params, { methodId: 'oauth' });
      assert.deepEqual(t.sp.calls[0].options.env, { BASE: '1', Q: '1' });
      // it answers nothing the agent asks
      const ask = proc.request('fs/read_text_file', {});
      await new Promise((r) => setImmediate(r));
      assert.equal((await ask).result, null);
      releaseAuth();
      assert.equal(await p, true);
      // started only to sign in: it goes once the sign-in is over (stdin closed, SIGTERM after the grace)
      mock.timers.tick(2000);
      assert.deepEqual(proc.kills, ['SIGTERM']);
      const l = t.host.authenticate('l', 'x');
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
      await l;
      assert.deepEqual(t.sp.calls[1].args, []);
      assert.equal(t.sp.calls[1].options.env.L, '1');
      // the chat process when one runs
      const running = await t.host.agent('fake');
      const n = t.sp.calls.length;
      assert.equal(await t.host.agentForLogin('fake'), running);
      assert.equal(t.sp.calls.length, n);
      // signing in through it leaves it running: the chat goes on
      const signin = t.host.authenticate('fake', 'oauth');
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      assert.equal(await signin, true);
      mock.timers.tick(2000);
      assert.equal(t.host.agents.has('fake'), true);
      assert.deepEqual(t.sp.procs.at(-1)!.kills, []);
    } finally {
      mock.timers.reset();
    }
  });

  test('sign-in: Cancel stops waiting, asks the agent to drop it, and ends a process started only to sign in', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = setup({ handlers: { authenticate: () => NO_REPLY } });
      const abort = new AbortController();
      const p = t.host.authenticate('fake', 'oauth', abort.signal);
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      const proc = t.sp.procs[0];
      const sent = proc.received.find((m: any) => m.method === 'authenticate');
      abort.abort();
      await assert.rejects(p, (e: any) => e.cancelled === true && /authenticate was cancelled/.test(e.message));
      assert.deepEqual(proc.received.find((m: any) => m.method === '$/cancel_request').params, { requestId: sent.id });
      mock.timers.tick(2000);
      assert.deepEqual(proc.kills, ['SIGTERM']);
      // through a chat's running process: that process stays, the chat goes on
      const running = await t.host.agent('fake');
      const live = new AbortController();
      const q = t.host.authenticate('fake', 'oauth', live.signal);
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      live.abort();
      await assert.rejects(q, (e: any) => e.cancelled === true);
      mock.timers.tick(2000);
      assert.equal(await t.host.agents.get('fake'), running);
      assert.deepEqual(t.sp.procs.at(-1)!.kills, []);
      // cancelled while the process was still starting: it never asks, and the process goes
      const early = new AbortController();
      early.abort();
      const u = setup({ handlers: { authenticate: () => NO_REPLY } });
      await assert.rejects(u.host.authenticate('fake', 'oauth', early.signal), (e: any) => e.cancelled === true);
      assert.equal(
        u.sp.procs[0].received.find((m: any) => m.method === 'authenticate'),
        undefined,
      );
      mock.timers.tick(2000);
      assert.deepEqual(u.sp.procs[0].kills, ['SIGTERM']);
    } finally {
      mock.timers.reset();
    }
  });

  test("sign-in: one through a chat's process gives up at the same cap, and the chat's process stays", async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const t = setup({ handlers: { authenticate: () => NO_REPLY } });
      const running = await t.host.agent('fake');
      const p = t.host.authenticate('fake', 'oauth');
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
      mock.timers.tick(15 * 60_000);
      await assert.rejects(p, /authenticate timed out/);
      mock.timers.tick(2000);
      assert.equal(await t.host.agents.get('fake'), running);
      assert.deepEqual(t.sp.procs.at(-1)!.kills, []);
    } finally {
      mock.timers.reset();
    }
  });
}
