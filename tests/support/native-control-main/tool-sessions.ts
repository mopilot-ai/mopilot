// Native-control tool-sessions unit cases with shared protocol and lifecycle fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ToolSessions, ToolSocket, hideRule, fakeRegistry } from './fixture';

export function registerToolSessionsCases() {
  async function socketClient(path: string) {
    const sock = net.connect(path);
    await new Promise((r) => sock.once('connect', r));
    sock.setEncoding('utf8');
    const waiting = new Map<number, (m: any) => void>();
    let buf = '';
    sock.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(m.id)?.(m);
      }
    });
    let next = 1;
    const request = (method: string, params: any = {}) =>
      new Promise<any>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    return { request, close: () => sock.destroy() };
  }

  test('sage-mcp lists and runs only the tools the session may see, read at each request', async () => {
    const sessions = new ToolSessions();
    const registry = fakeRegistry(['computer_click', 'browser_navigate', 'sage_files']);
    const socket = new ToolSocket({ sessions, registry, verifyPeer: async () => null });
    const path = await socket.listen();
    let hideComputer = true;
    const hide = (name: string) => name.startsWith('computer_') && hideComputer;
    const { token } = sessions.open('codex:1', { harnessPid: 1, hide, chatId: 'chat', segmentId: 'seg' });
    const c = await socketClient(path);
    try {
      assert.ok((await c.request('hello', { token, pid: 2 })).result.serverName);
      const names = async () => (await c.request('tools/list')).result.tools.map((t: any) => t.name);
      assert.deepEqual(await names(), ['browser_navigate', 'sage_files']);
      const hidden = await c.request('tools/call', { name: 'computer_click', arguments: {} });
      assert.deepEqual(hidden.result, {
        content: [{ type: 'text', text: 'computer_click is unavailable in this session.' }],
        isError: true,
      });
      assert.deepEqual(registry.invoked, []);
      const ran = await c.request('tools/call', { name: 'sage_files' });
      assert.deepEqual(ran.result, { content: [{ type: 'text', text: 'ran sage_files' }], isError: false });
      // the session changes path (the patch replaces its filter): the hidden tool comes back
      hideComputer = false;
      assert.deepEqual(await names(), ['computer_click', 'browser_navigate', 'sage_files']);
      sessions.assign('codex:1', { hide: () => 'not true' });
      assert.deepEqual(await names(), ['computer_click', 'browser_navigate', 'sage_files']);
      assert.equal(sessions.get('codex:1').hide(), 'not true');
      await c.request('tools/call', { name: 'computer_click', arguments: { x: 1 } });
      assert.deepEqual(registry.invoked.at(-1), { chatId: 'chat', segmentId: 'seg', name: 'computer_click', args: { x: 1 }, callId: null });
    } finally {
      c.close();
      socket.close();
    }
  });

  test("sage-mcp refuses a hidden tool with the session rule's own message (the surfaces its harness serves)", async () => {
    const sessions = new ToolSessions();
    const registry = fakeRegistry(['desktop_click', 'sage_files']);
    const socket = new ToolSocket({ sessions, registry, verifyPeer: async () => null });
    const path = await socket.listen();
    const hide = hideRule(
      (name: string) => name.startsWith('desktop_'),
      (name: string) => `${name} is unavailable in this session: the harness's own computer use is on here; use it instead.`,
    );
    const { token } = sessions.open('codex:2', { harnessPid: 1, hide, chatId: 'chat', segmentId: 'seg' });
    const c = await socketClient(path);
    try {
      assert.ok((await c.request('hello', { token, pid: 2 })).result.serverName);
      const hidden = await c.request('tools/call', { name: 'desktop_click', arguments: {} });
      assert.deepEqual(hidden.result, {
        content: [
          {
            type: 'text',
            text: "desktop_click is unavailable in this session: the harness's own computer use is on here; use it instead.",
          },
        ],
        isError: true,
      });
      assert.deepEqual(registry.invoked, []);
    } finally {
      c.close();
      socket.close();
    }
  });

  test("a session record the sessions no longer list falls back to the connection's own", async () => {
    class Forgetful extends ToolSessions {
      forget = false;
      get(key: string) {
        return this.forget ? null : super.get(key);
      }
    }
    const sessions = new Forgetful();
    const registry = fakeRegistry(['computer_click', 'sage_files']);
    const socket = new ToolSocket({ sessions, registry, verifyPeer: async () => null });
    const path = await socket.listen();
    const { token } = sessions.open('claude:1', {
      harnessPid: 1,
      hide: (n: string) => n === 'computer_click',
      chatId: 'c1',
      segmentId: 's1',
    });
    const c = await socketClient(path);
    try {
      await c.request('hello', { token, pid: 2 });
      sessions.forget = true;
      assert.deepEqual(
        (await c.request('tools/list')).result.tools.map((t: any) => t.name),
        ['sage_files'],
      );
      await c.request('tools/call', { name: 'sage_files' });
      assert.deepEqual(registry.invoked.at(-1), { chatId: 'c1', segmentId: 's1', name: 'sage_files', args: {}, callId: null });
    } finally {
      c.close();
      socket.close();
    }
  });

  test('a session without a filter, and its get(), show every tool', () => {
    const sessions = new ToolSessions();
    sessions.open('k');
    assert.equal(sessions.get('k').hide, null);
    const hide = () => true;
    sessions.rotate('k', { hide });
    assert.equal(sessions.get('k').hide, hide);
    assert.equal(sessions.resolve('nope'), null);
  });
}
