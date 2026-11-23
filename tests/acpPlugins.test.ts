// MoPilot's plugins on a basic-tier (ACP) session (electron/harness/acp.cjs with electron/plugins/delivery.cjs):
// their MCP servers join session/new's mcpServers after sage-mcp, in the transports the agent advertised and its
// quirks allow; the folders are let go however the session ends; a failed delivery doesn't stop the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, KEY, CWD, INIT, recentIgnored, clearIgnored, until } from './support/acp-host/fixture.ts';

/** A delivery that records what it was asked and how often each session let go. */
function fakePlugins(o: { fail?: boolean } = {}) {
  const asked: any[] = [];
  let released = 0;
  return {
    asked,
    released: () => released,
    forAcp: async (q: any) => {
      asked.push(q);
      if (o.fail) throw new Error('store unreadable');
      return {
        mcpServers: [{ name: 'tidy_local', command: 'node', args: [], env: [] }],
        withheld: [{ id: 'tidy@acme', why: "remote: This harness doesn't connect to remote MCP servers." }],
        release: () => void released++,
      };
    },
  };
}

const newSession = (t: any) => t.sp.procs[0].received.find((m: any) => m.method === 'session/new').params;

test('the plugins’ MCP servers follow sage-mcp in session/new, asked with the agent’s MCP capabilities', async () => {
  clearIgnored();
  const plugins = fakePlugins();
  const t = setup({ plugins, handlers: { initialize: () => INIT({ mcpCapabilities: { http: true } }) } });
  await t.host.ensure(KEY, { cwd: CWD, chatId: 'chat-1' });
  assert.deepEqual(newSession(t).mcpServers, [{ name: 'sage_0123456789ab' }, { name: 'tidy_local', command: 'node', args: [], env: [] }]);
  assert.deepEqual(plugins.asked, [{ mcp: { http: true, sse: false }, stdio: true }]);
  assert.ok(
    recentIgnored().some((e: any) => /tidy@acme: remote/.test(e.message)),
    'what was withheld is recorded',
  );
  t.host.close(KEY);
  assert.equal(plugins.released(), 1);
});

test('a harness whose quirks refuse stdio MCP is asked without stdio', async () => {
  const plugins = fakePlugins();
  const t = setup({ plugins, quirks: (id: string) => (id === 'fake' ? { label: 'Fake', args: ['acp'], mcpStdio: false } : null) });
  await t.host.ensure(KEY, { cwd: CWD });
  assert.equal(plugins.asked[0].stdio, false);
  // and with no http in its initialize, its tools can only be offered as they always are
  assert.equal(t.prepared[0].http, false);
});

test("a harness that takes no stdio MCP but takes http gets its tools over http; one that takes stdio doesn't", async () => {
  const http = { initialize: () => INIT({ mcpCapabilities: { http: true } }) };
  const noStdio = setup({
    handlers: http,
    quirks: (id: string) => (id === 'fake' ? { label: 'Fake', args: ['acp'], mcpStdio: false } : null),
  });
  await noStdio.host.ensure(KEY, { cwd: CWD, chatId: 'chat-1' });
  assert.deepEqual(noStdio.prepared, [{ harnessPid: 4242, chatId: 'chat-1', segmentId: KEY, resume: false, http: true }]);
  const stdio = setup({ handlers: http });
  await stdio.host.ensure(KEY, { cwd: CWD });
  assert.equal(stdio.prepared[0].http, false);
});

test('the folders are let go when the agent exits, and when the session never opens', async () => {
  const exiting = fakePlugins();
  const t = setup({ plugins: exiting });
  await t.host.ensure(KEY, { cwd: CWD });
  t.sp.procs[0].emit('exit', 1, null);
  await until(() => exiting.released() === 1);

  const refused = fakePlugins();
  const d = setup({ plugins: refused, admit: false });
  await assert.rejects(d.host.ensure(KEY, { cwd: CWD }), /can't give Fake computer and browser control/);
  assert.equal(refused.released(), 1, 'once, though both the chat and the failed open let go');
});

test('a delivery that fails leaves the session to start without plugins', async () => {
  clearIgnored();
  const plugins = fakePlugins({ fail: true });
  const t = setup({ plugins });
  await t.host.ensure(KEY, { cwd: CWD });
  assert.deepEqual(newSession(t).mcpServers, [{ name: 'sage_0123456789ab' }]);
  assert.ok(recentIgnored().some((e: any) => /store unreadable/.test(e.message)));
  t.host.close(KEY);
});
