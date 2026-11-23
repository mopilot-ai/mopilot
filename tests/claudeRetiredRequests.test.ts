// Independent SDK callback ownership checks outside the Claude iterator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakes, load, fakeBin, flush, lastQuery } from './support/electron-claude.ts';
for (const callback of ['permission', 'elicitation'])
  test(`retired Claude ${callback} callbacks cannot publish replacement cards`, async () => {
    const t = load();
    fakes.onQuery = (q: any) => {
      q.reply = null;
    };
    const key = 'claude:reused-session';
    const opts = { bin: fakeBin('review/claude'), sessionId: 'reused-session' };
    await t.claude.send(key, opts, { role: 'user', content: 'old' });
    const old = lastQuery();
    old.close = () => {};
    await t.claude.retire(key, 0);
    await t.claude.send(key, opts, { role: 'user', content: 'replacement' });
    const current = lastQuery();
    const start = t.events.length;
    const answer =
      callback === 'permission'
        ? old.options.canUseTool('Bash', { command: 'obsolete' }, { toolUseID: 'old-tool' })
        : old.options.onElicitation({ serverName: 'old-server', message: 'obsolete', mode: 'form' }, {});
    await flush();
    const stale = t.events.slice(start);
    old.end();
    current.end();
    await answer;
    await flush();
    assert.equal(stale.length, 0, 'an old process callback cannot add a card to the replacement');
  });

for (const callback of ['permission', 'elicitation'])
  test(`old ${callback} cleanup removes only its card while replacement stays live`, async () => {
    const { setup } = await import('./support/controller/fixture');
    const { c, s } = setup();
    const key = 'claude:pending-reused';
    c.state.get(key);
    const t = load({ hooks: { onEvent: (e: any) => c.onClaudeEvent(e) } });
    fakes.onQuery = (q: any) => {
      q.reply = null;
    };
    const opts = { bin: fakeBin('review/claude'), sessionId: 'pending-reused' };
    await t.claude.send(key, opts, { role: 'user', content: 'old' });
    const old = lastQuery();
    const ask = (q: any) =>
      callback === 'permission'
        ? q.options.canUseTool('Bash', { command: 'pending' }, { toolUseID: 'tool' })
        : q.options.onElicitation({ serverName: 'server', message: 'pending', mode: 'form' }, {});
    const oldAnswer = ask(old);
    await flush();
    const oldId = s(key).approvals[0].id;
    old.close = () => {};
    await t.claude.retire(key, 0);
    await t.claude.send(key, opts, { role: 'user', content: 'replacement' });
    const current = lastQuery();
    const currentAnswer = ask(current);
    await flush();
    const currentId = s(key).approvals.find((a: any) => a.id !== oldId).id;
    old.end();
    await oldAnswer;
    await flush();
    const remaining = s(key).approvals.map((a: any) => a.id);
    current.end();
    await currentAnswer;
    await flush();
    assert.deepEqual(remaining, [currentId], 'retired callback cleanup must remove its card without clearing the replacement card');
  });

test('a Claude process closed during startup rejects unsent input instead of reporting acceptance', async () => {
  let t: any;
  t = load({
    hooks: { onEvent: (e: any) => e.kind === 'tasks' && e.key === 'claude:race' && t.claude.turnApi.control('claude:race', 'close') },
  });
  await assert.rejects(
    t.claude.send(
      'claude:race',
      { bin: fakeBin('review/claude'), sessionId: 'race', ephemeral: true },
      { role: 'user', content: 'keep this input' },
    ),
    /Session closed before this message was sent/,
  );
  await flush();
  assert.deepEqual(lastQuery().inputs, []);
  assert.equal(lastQuery().closed, true);
});

test('a retired process cannot publish its delayed command list over the current process', async () => {
  const t = load();
  let finish!: (v: any) => void;
  fakes.onQuery = (q: any) => {
    q.reply = null;
    q.supportedCommands = () =>
      new Promise((r) => {
        finish = r;
      });
  };
  const key = 'claude:catalog-reuse';
  const opts = { bin: fakeBin('review/claude'), sessionId: 'catalog-reuse', cwd: '/same-workspace' };
  await t.claude.send(key, opts, { role: 'user', content: 'old' });
  const old = lastQuery();
  old.push({ type: 'system', subtype: 'init' });
  await flush();
  old.close = () => {};
  await t.claude.retire(key, 0);
  fakes.onQuery = (q: any) => {
    q.reply = null;
  };
  await t.claude.send(key, opts, { role: 'user', content: 'new' });
  const current = lastQuery();
  current.push({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'current' }] });
  await flush();
  finish([{ name: 'obsolete' }]);
  await flush();
  const catalog = t.broadcasts.filter(([ch]: any[]) => ch === 'claude:catalog').at(-1)![1].catalog;
  old.end();
  current.end();
  await flush();
  assert.deepEqual(
    catalog.commands.map((c: any) => c.name),
    ['current'],
  );
});
