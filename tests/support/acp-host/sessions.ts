// ACP host sessions unit cases with shared fake-agent and transcript fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acp, KEY, CWD, setup, INIT, NO_REPLY } from './fixture';
import { useFakeClock } from '../ports/clock.ts';

export function registerSessionsCases() {
  test('the host takes its defaults', (t) => {
    const clock = useFakeClock(t, 1234);
    const h = new acp.AcpHost({ items: null, quirks: () => null, resolveBin: () => null });
    assert.deepEqual(h.ids, []);
    assert.equal(h.envOf(), process.env);
    assert.equal(h.tools, null);
    h.notifyFn();
    assert.equal(h.cwd, process.cwd());
    assert.equal(h.admittedFn('x'), null);
    assert.equal(h.dataDir, null);
    // the clock port's time (electron/platform/ports/clock.cjs)
    assert.equal(h.now(), clock.now());
    assert.deepEqual([h.cancelRetryMs, h.cancelForceMs], [5000, 15000]);
    assert.equal(h.label('mystery'), 'mystery');
  });

  test("harnesses that can't start: unknown, not installed, not admitted, a failed privacy gate, a failed initialize with its stderr", async () => {
    const quirks: any = {
      fake: { label: 'Fake', args: ['acp'] },
      gated: { label: 'Gated', args: ['acp'], admission: { privacyGate: async () => ({ ok: false, reason: 'telemetry is on' }) } },
      silent: { label: 'Silent', args: ['acp'], admission: { privacyGate: async () => null } },
    };
    const t = setup({
      quirks: (id: string) => quirks[id] ?? null,
      resolveBin: (id: string) => (id === 'missing' ? null : '/bin/x'),
      admitted: (id: string) => (id === 'off' ? 'switched off' : null),
    });
    quirks.missing = { label: 'Missing' };
    quirks.off = { label: 'Off', args: [] };
    await assert.rejects(t.host.agent('nope'), /Unknown harness: nope/);
    assert.equal(t.host.agents.size, 0);
    await assert.rejects(t.host.agent('missing'), /Missing isn't installed/);
    await assert.rejects(t.host.agent('off'), /Off: switched off/);
    await assert.rejects(t.host.agent('gated'), /telemetry is on/);
    await assert.rejects(t.host.agent('silent'), /Silent failed its privacy check/);
    const bad = setup({
      handlers: {
        initialize: (_p: any, proc: any) => {
          proc.stderr.emit('data', 'boot\nno api key\n');
          return { protocolVersion: 3 };
        },
      },
    });
    await assert.rejects(bad.host.agent('fake'), /Fake didn't start: fake speaks ACP v3; MoPilot needs v1/);
    const exited = setup({
      handlers: {
        initialize: (_p: any, proc: any) => {
          proc.stderr.emit('data', 'fatal: config\n');
          proc.exit(1);
          return NO_REPLY;
        },
      },
    });
    await assert.rejects(exited.host.agent('fake'), /Fake didn't start: fake exited \(1\) · fatal: config/);
    const thrown = setup({
      handlers: {
        initialize: () => {
          throw 'x';
        },
      },
    });
    await assert.rejects(thrown.host.agent('fake'), /Fake didn't start: x$/);
  });

  test('an agent that failed to start and exits late leaves the agent started after it in place', async () => {
    let n = 0;
    const t = setup({ handlers: { initialize: () => (++n === 1 ? { protocolVersion: 3 } : INIT()) } });
    await assert.rejects(t.host.agent('fake'), /Fake didn't start/);
    const second = await t.host.agent('fake');
    // the first process ends only now (it was asked to stop)
    t.sp.procs[0].exit(null, 'SIGTERM');
    assert.equal(await t.host.agents.get('fake'), second);
    assert.equal(await t.host.agent('fake'), second);
    assert.equal(t.sp.procs.length, 2, 'no third process');
    // the running agent going still clears its entry
    t.sp.procs[1].exit(0);
    assert.equal(t.host.agents.size, 0);
  });

  test('a harness launched by its quirks gets their env, the launch env and args; one agent is shared', async () => {
    const q = {
      label: 'L',
      env: { Q: '1' },
      launch: async (ctx: any) => ({ args: ['--patch', ctx.dataDir], env: { L: '2' } }),
      admission: { privacyGate: async (ctx: any) => ({ ok: ctx.env.L === '2' && ctx.args[0] === '--patch' }) },
    };
    const t = setup({ quirks: () => q });
    const [a, b] = await Promise.all([t.host.agent('l'), t.host.agent('l')]);
    assert.equal(a, b);
    assert.deepEqual(t.sp.calls[0].args, ['--patch', '/data']);
    assert.deepEqual(t.sp.calls[0].options.env, { BASE: '1', Q: '1', L: '2' });
    assert.equal(t.sp.calls[0].options.cwd, '/home');
    const n = setup({ quirks: () => ({ label: 'N', launch: () => ({}) }) });
    await n.host.agent('n');
    assert.deepEqual(n.sp.calls[0].args, []);
    const d = setup({ quirks: () => ({ label: 'D' }) });
    await d.host.agent('d');
    assert.deepEqual(d.sp.calls[0].args, []);
  });

  /* ------------------------------------------------------------------ */
  /* sessions                                                            */
  /* ------------------------------------------------------------------ */
  test('ensure: not an ACP key; no folder; a failed open is forgotten and its tools ended', async () => {
    const t = setup();
    await assert.rejects(t.host.ensure('claude:x'), /Not an ACP chat/);
    await assert.rejects(t.host.ensure(KEY), /This chat has no folder/);
    await assert.rejects(t.host.ensure(KEY, { cwd: 'rel' }), /no folder/);
    assert.equal(t.host.chats.size, 0);
    assert.deepEqual(t.ended, [KEY, KEY]);
    const n = setup({ handlers: { 'session/new': () => ({}) } });
    await assert.rejects(n.host.ensure(KEY, { cwd: CWD }), /Fake didn't return a session/);
    const d = setup({ admit: false });
    await assert.rejects(d.host.ensure(KEY, { cwd: CWD }), /can't give Fake computer and browser control/);
    assert.equal(d.host.bySession.size, 0);
    // without tools there's no sage server and no admission
    const w = setup({ tools: null });
    const chat = await w.host.ensure(KEY, { cwd: CWD, chatId: 'chat-1' });
    assert.equal(chat.chatId, 'chat-1');
    assert.equal(chat.serverName, null);
    assert.deepEqual(w.sp.procs[0].received.find((m: any) => m.method === 'session/new').params.mcpServers, []);
    assert.equal(await w.host.ensure(KEY), chat);
  });

  test('reopening a session: load, resume, a failed reopen continues in a new one, an agent that can do neither says so', async () => {
    const cases: [any, any, RegExp | null, string][] = [
      [{ loadSession: true }, {}, null, 'session/load'],
      [{ sessionCapabilities: { resume: {} } }, {}, null, 'session/resume'],
      [
        { loadSession: true },
        {
          'session/load': () => {
            throw new Error('gone');
          },
        },
        /Couldn't reopen the Fake session \(gone\)/,
        'session/new',
      ],
      [
        { loadSession: true },
        {
          'session/load': () => {
            throw 'nope';
          },
        },
        /\(nope\)/,
        'session/new',
      ],
      [{}, {}, /can't reopen sessions/, 'session/new'],
    ];
    for (const [caps, handlers, note, method] of cases) {
      const t = setup({ handlers: { initialize: () => INIT(caps), ...handlers } });
      t.items.append(KEY, { t: 'session', sessionId: 'old', cwd: CWD });
      const chat = await t.host.ensure(KEY, {});
      const sent = t.sp.procs[0].received.map((m: any) => m.method);
      assert.ok(sent.includes(method), `${method} in ${sent}`);
      const session = t.events.find((e) => e.kind === 'session');
      if (note) assert.match(session.note, note);
      else assert.equal(session.note, null);
      assert.equal(chat.loading, false);
    }
  });

  test("reopened settings: the chat's last mode and options are set again, skipping what the agent no longer offers or refuses", async () => {
    const configOptions = [
      { id: 'model', currentValue: 'a' },
      { id: 'level', currentValue: 'low' },
      { id: 'same', currentValue: 1 },
      { id: 'fails', currentValue: 0 },
    ];
    const t = setup({
      handlers: {
        'session/new': () => ({
          sessionId: 's',
          modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }] },
          configOptions,
        }),
        'session/set_config_option': (p: any) => {
          if (p.configId === 'fails') throw new Error('no');
          return p.configId === 'model' ? { configOptions: [{ id: 'model', currentValue: 'b' }, ...configOptions.slice(1)] } : {};
        },
      },
    });
    t.items.append(
      KEY,
      { t: 'mode', modeId: 'plan' },
      { t: 'mode', modeId: 7 },
      { t: 'config', configId: 'model', value: 'b' },
      { t: 'config', configId: 'level', value: 'high' },
      { t: 'config', configId: 'same', value: 1 },
      { t: 'config', configId: 'gone', value: 1 },
      { t: 'config', configId: 'fails', value: 1 },
      { t: 'config', configId: 3 },
    );
    const chat = await t.host.ensure(KEY, { cwd: CWD });
    assert.equal(chat.state.modes.currentModeId, 'plan');
    assert.deepEqual(
      chat.state.configOptions.map((o: any) => o.currentValue),
      ['b', 'high', 1, 0],
    );
    // a mode it doesn't offer, or a set_mode that fails, is skipped; no modes at all is fine
    for (const [modes, fail] of [
      [{ currentModeId: 'ask', availableModes: [{ id: 'ask' }] }, false],
      [{ currentModeId: 'ask' }, false],
      [{ currentModeId: 'ask', availableModes: [{ id: 'plan' }] }, true],
      [null, false],
    ] as const) {
      const u = setup({
        handlers: {
          'session/new': () => ({ sessionId: 's', modes }),
          'session/set_mode': () => {
            if (fail) throw new Error('no');
            return {};
          },
        },
      });
      u.items.append(KEY, { t: 'mode', modeId: 'plan' }, { t: 'mode', modeId: 'ask' }, { t: 'mode', modeId: 'plan' });
      const c = await u.host.ensure(KEY, { cwd: CWD });
      assert.equal(c.state.modes?.currentModeId ?? null, modes?.currentModeId ?? null);
    }
    // the agent's echo while reapplying is not recorded as the chat's choice
    const e = setup({
      handlers: {
        'session/new': () => ({ sessionId: 's', modes: { currentModeId: 'ask', availableModes: [{ id: 'plan' }] } }),
        'session/set_mode': (p: any, proc: any) => (
          proc.notify('session/update', { sessionId: 's', update: { sessionUpdate: 'current_mode_update', currentModeId: p.modeId } }), {}
        ),
      },
    });
    e.items.append(KEY, { t: 'mode', modeId: 'plan' });
    await e.host.ensure(KEY, { cwd: CWD });
    assert.equal((await e.items.readAsync(KEY)).filter((r: any) => r.t === 'mode').length, 1);
  });
}
