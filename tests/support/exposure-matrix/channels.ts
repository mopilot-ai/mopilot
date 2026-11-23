// channels exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  BU,
  CU,
  IAB,
  world,
  ToolSessions,
  ToolSocket,
  SessionMcp,
  sockets,
  send,
  newKey,
  presented,
  withLogin,
  wireClaude,
  closeAll,
  injection,
  sageServers,
  pluginOf,
} from './fixture.ts';

export function registerChannels() {
  describe('CM-X03: a channel switched off', () => {
    test('CM-X03a: channel.claude.sdkMcp off: a new Claude session gets no MoPilot server; back on, the next one does', async () => {
      const w = world();
      w.state.yourChrome = true;
      const { sessions } = wireClaude(w);
      const opened: string[] = [];
      const open = sessions.open.bind(sessions);
      sessions.open = (k: string, o: any) => (opened.push(k), open(k, o));
      w.flags['channel.claude.sdkMcp'] = false;
      const keys: string[] = [];
      try {
        await withLogin('api_key', async () => {
          const off = await send(keys[keys.push(newKey()) - 1]);
          assert.ok(off.fresh);
          assert.equal(off.q.options.mcpServers, undefined, 'no MoPilot server');
          assert.deepEqual(opened, [], 'no tool session opened');
          w.flags['channel.claude.sdkMcp'] = true;
          const on = await send(keys[keys.push(newKey()) - 1]);
          assert.ok(presented(on.q, w).includes(IAB));
          assert.ok(presented(on.q, w).includes(CU));
          assert.ok(presented(on.q, w).includes(BU));
        });
      } finally {
        await closeAll(keys);
      }
    });

    test('CM-X03b: channel.codex.threadConfigMcp off: a native thread still gets the vendor plugin, without sage-mcp', () => {
      const w = world();
      for (const surfaces of [
        { chrome: true, computer: true },
        { chrome: true, computer: false },
        { chrome: false, computer: true },
      ]) {
        const { inj, sessions, load } = injection(w, { hasTools: false, surfaces: () => surfaces });
        const { out } = load('thread/start', 'cx-1');
        assert.equal(pluginOf(out), true, 'the vendor plugin on');
        assert.deepEqual(sageServers(out), [], 'no sage-mcp');
        assert.equal(sessions.byKey.size, 0);
        assert.equal(inj.isNativeThread('cx-1'), true);
        // resumed after an unload: the same
        inj.observe({ method: 'thread/closed', params: { threadId: 'cx-1' } });
        const resumed = load('thread/resume', 'cx-1').out;
        assert.equal(pluginOf(resumed), true);
        assert.deepEqual(sageServers(resumed), []);
      }
    });

    test('CM-X03c: channel.codex.threadConfigMcp off: a managed thread goes out unchanged', () => {
      const w = world();
      const { inj, load } = injection(w, { hasTools: false });
      for (const method of ['thread/start', 'thread/fork', 'thread/resume']) {
        const { msg, out } = load(method, `cx-${method}`);
        assert.equal(out, msg, `${method} unchanged`);
      }
      assert.equal(inj.isNativeThread('cx-thread/start'), false);
    });

    test('CM-X03d: channel.acp.sessionMcp off: an ACP session is given no sage-mcp', async () => {
      const w = world();
      const sessions = new ToolSessions();
      const socket = new ToolSocket({ sessions, registry: w.r, verifyPeer: async () => null });
      sockets.push(socket);
      const acp = new SessionMcp({ sessions, socket, command: '/bin/sage-mcp', enabled: () => false });
      await assert.rejects(acp.prepare('acp:1', { harnessPid: 1 }), /turned off computer and browser control/);
      assert.equal(sessions.byKey.size, 0);
    });
  });
}
