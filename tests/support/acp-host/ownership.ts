// ACP host ownership unit cases with shared fake-agent and transcript fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until, KEY, CWD, setup, INIT } from './fixture';

export function registerOwnershipCases() {
  test('ACP agents with the same native session id keep independent callbacks and terminals', async () => {
    const t = setup({
      quirks: () => ({ label: 'Fake', args: ['acp'] }),
      handlers: { 'session/new': () => ({ sessionId: 'same-native-id' }) },
    });
    const otherKey = 'acp:other:second';
    const first = await t.host.ensure(KEY, { cwd: CWD });
    const second = await t.host.ensure(otherKey, { cwd: CWD });
    const update = (text: string) => ({
      sessionId: 'same-native-id',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
    t.host.onAgentNotification(first.agent, 'session/update', update('first'));
    t.host.onAgentNotification(second.agent, 'session/update', update('second'));
    const texts = async (key: string) =>
      (await t.items.readAsync(key)).filter((r: any) => r.t === 'update').map((r: any) => r.update.content.text);
    assert.deepEqual(await texts(KEY), ['first']);
    assert.deepEqual(await texts(otherKey), ['second']);
    assert.deepEqual(await t.host.onAgentRequest(first.agent, 'session/request_permission', { sessionId: 'same-native-id' }), {
      outcome: { outcome: 'cancelled' },
    });
    const one = await t.host.onAgentRequest(first.agent, 'terminal/create', { sessionId: 'same-native-id', command: 'echo' });
    const two = await t.host.onAgentRequest(second.agent, 'terminal/create', { sessionId: 'same-native-id', command: 'echo' });
    t.host.close(KEY);
    assert.deepEqual(t.pty.killed, [`acp:${one.terminalId}`]);
    assert.ok(t.host.terminals.get(two.terminalId, second));
    t.host.onAgentNotification(second.agent, 'session/update', update('still second'));
    assert.deepEqual(await texts(otherKey), ['second', 'still second']);
    t.sp.procs[1].exit(0);
    assert.deepEqual(t.pty.killed, [`acp:${one.terminalId}`, `acp:${two.terminalId}`]);
    assert.equal(t.host.bySession.size, 0);
  });

  test('closing an ACP chat during session creation cannot bind or clean up its replacement', async () => {
    let release: any;
    let calls = 0;
    const t = setup({
      quirks: (id: string) => (id === 'fake' ? { label: 'Fake', args: ['acp'], mcpScope: 'session' } : null),
      handlers: {
        'session/new': () =>
          ++calls === 1
            ? new Promise((resolve) => {
                release = resolve;
              })
            : { sessionId: 'replacement' },
      },
    });
    const old = t.host.ensure(KEY, { cwd: CWD });
    const rejected = assert.rejects(old, /ACP chat closed/);
    await until(() => release);
    t.host.close(KEY);
    const replacement = await t.host.ensure(KEY, { cwd: CWD });
    const ended = [...t.ended];
    release({ sessionId: 'late' });
    await rejected;
    assert.equal(t.host.chats.get(KEY), replacement);
    assert.deepEqual(t.ended, ended);
    assert.equal(t.host.chatOf(replacement.agent, 'late'), null);
    assert.equal(t.host.chatOf(replacement.agent, 'replacement'), replacement);
    assert.deepEqual(
      (await t.items.readAsync(KEY)).filter((r: any) => r.t === 'session').map((r: any) => r.sessionId),
      ['replacement'],
    );
    t.host.close(KEY);
  });

  test('ACP startup that loses its chat during admission or settings cannot publish a stale session', async () => {
    for (const phase of ['admission', 'settings']) {
      const t = setup();
      let release: any;
      let calls = 0;
      const pauseFirst = () =>
        ++calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(true);
      if (phase === 'admission') t.host.tools.admission = pauseFirst;
      else t.host.reapplySettings = pauseFirst;
      const old = t.host.ensure(KEY, { cwd: CWD });
      const rejected = assert.rejects(old, /ACP chat closed/);
      await until(() => release);
      t.host.close(KEY);
      const replacement = await t.host.ensure(KEY, { cwd: CWD });
      const events = [...t.events];
      const ended = [...t.ended];
      release(true);
      await rejected;
      assert.equal(t.host.chats.get(KEY), replacement);
      assert.deepEqual(t.events, events);
      assert.deepEqual(t.ended, ended);
      assert.equal(t.host.chatOf(replacement.agent, replacement.sessionId), replacement);
      t.host.close(KEY);
    }
  });

  test('ACP settings replies from a closed chat cannot change its replacement or transcript', async () => {
    for (const kind of ['mode', 'config']) {
      let release: any;
      const method = kind === 'mode' ? 'session/set_mode' : 'session/set_config_option';
      const t = setup({
        quirks: (id: string) => (id === 'fake' ? { label: 'Fake', args: ['acp'], mcpScope: 'session' } : null),
        handlers: {
          [method]: () =>
            new Promise((resolve) => {
              release = resolve;
            }),
        },
      });
      await t.host.ensure(KEY, { cwd: CWD });
      const old = kind === 'mode' ? t.host.setMode(KEY, 'plan') : t.host.setConfigOption(KEY, 'model', 'old');
      const rejected = assert.rejects(old, /closed/);
      await until(() => release);
      t.host.close(KEY);
      const replacement = await t.host.ensure(KEY, { cwd: CWD });
      const events = [...t.events];
      const records = await t.items.readAsync(KEY);
      release({ configOptions: [{ id: 'model', currentValue: 'old' }] });
      await rejected;
      assert.equal(t.host.chats.get(KEY), replacement);
      assert.deepEqual(t.events, events);
      assert.deepEqual(await t.items.readAsync(KEY), records);
      t.host.close(KEY);
    }
  });

  test('ACP settings cannot send to a chat closed while obtaining its live session', async () => {
    for (const kind of ['mode', 'config']) {
      const t = setup();
      await t.host.ensure(KEY, { cwd: CWD });
      const old = kind === 'mode' ? t.host.setMode(KEY, 'plan') : t.host.setConfigOption(KEY, 'model', 'old');
      const rejected = assert.rejects(old, /ACP chat closed/);
      t.host.close(KEY);
      await rejected;
      const method = kind === 'mode' ? 'session/set_mode' : 'session/set_config_option';
      assert.equal(
        t.sp.procs[0].received.some((m: any) => m.method === method),
        false,
      );
      assert.equal(
        (await t.items.readAsync(KEY)).some((r: any) => r.t === kind),
        false,
      );
    }
  });

  test('retired ACP startup stops before tools, new sessions or admission after an awaited boundary', async () => {
    for (const phase of ['agent', 'prepare', 'load', 'resume', 'failed load', 'failed resume']) {
      let release: any;
      let requests = 0;
      const method = phase.includes('resume') ? 'session/resume' : 'session/load';
      const t = setup({
        handlers: {
          initialize: () => INIT({ loadSession: !phase.includes('resume'), sessionCapabilities: { resume: {} } }),
          [method]: () =>
            ++requests === 1
              ? new Promise((resolve, reject) => {
                  release = phase.startsWith('failed') ? () => reject(new Error('gone')) : resolve;
                })
              : {},
        },
      });
      if (phase === 'agent' || phase === 'prepare') {
        const owner = phase === 'agent' ? t.host : t.host.tools;
        const name = phase === 'agent' ? 'agent' : 'prepare';
        const real = owner[name].bind(owner);
        let calls = 0;
        owner[name] = async (...args: any[]) => {
          const result = await real(...args);
          return ++calls === 1
            ? new Promise((resolve) => {
                release = () => resolve(result);
              })
            : result;
        };
      } else t.items.append(KEY, { t: 'session', sessionId: 'old', cwd: CWD });
      const old = t.host.ensure(KEY, { cwd: CWD });
      const rejected = assert.rejects(old, /ACP chat closed/);
      await until(() => release);
      t.host.close(KEY);
      const replacement = await t.host.ensure(KEY, { cwd: CWD });
      const received = t.sp.procs[0].received.length;
      let prepares = 0;
      const prepare = t.host.tools.prepare.bind(t.host.tools);
      t.host.tools.prepare = (...args: any[]) => {
        prepares++;
        return prepare(...args);
      };
      let admissions = 0;
      t.host.tools.admission = async () => {
        admissions++;
        return true;
      };
      release({});
      await rejected;
      assert.equal(t.sp.procs[0].received.length, received, phase);
      assert.equal(prepares, 0, phase);
      assert.equal(admissions, 0, phase);
      assert.equal(t.host.chats.get(KEY), replacement);
      t.host.close(KEY);
    }
  });

  test('ACP settings restoration stops its remaining RPCs when the startup chat closes', async () => {
    for (const phase of ['mode', 'failed mode', 'config', 'failed config']) {
      let release: any;
      let deferred = false;
      const response = {
        modes: { currentModeId: 'ask', availableModes: [{ id: 'ask' }, { id: 'plan' }] },
        configOptions: [
          { id: 'model', currentValue: 'a' },
          { id: 'level', currentValue: 'low' },
        ],
      };
      const method = phase.includes('mode') ? 'session/set_mode' : 'session/set_config_option';
      const t = setup({
        handlers: {
          initialize: () => INIT({ loadSession: true }),
          'session/load': () => structuredClone(response),
          [method]: () => {
            if (deferred) return {};
            deferred = true;
            return new Promise((resolve, reject) => {
              release = phase.startsWith('failed') ? () => reject(new Error('refused')) : resolve;
            });
          },
        },
      });
      t.items.append(
        KEY,
        { t: 'session', sessionId: 'old', cwd: CWD },
        { t: 'mode', modeId: 'plan' },
        { t: 'config', configId: 'model', value: 'b' },
        { t: 'config', configId: 'level', value: 'high' },
      );
      const old = t.host.ensure(KEY, { cwd: CWD });
      const rejected = assert.rejects(old, /ACP chat closed/);
      await until(() => release);
      t.host.close(KEY);
      const replacement = await t.host.ensure(KEY, { cwd: CWD });
      const received = t.sp.procs[0].received.length;
      const events = [...t.events];
      release({});
      await rejected;
      assert.equal(t.sp.procs[0].received.length, received, phase);
      assert.deepEqual(t.events, events);
      assert.equal(t.host.chats.get(KEY), replacement);
      t.host.close(KEY);
    }
  });
}
