// Claude renderer chat unit cases for commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, storeSet, claude, claudeThreadId, noteOwner, flush, log, rec, onEvent, baseNative, evStarted } from './fixture.ts';

export function registerCommands() {
  test("each Claude chat's own model, effort and login are sent to main when they change", async () => {
    const chat = claudeThreadId('own-1');
    fx.state.claude = { ...fx.state.claude, models: [{ id: 'opus' }] };
    storeSet({ runtime: { [chat]: { settings: { model: 'opus', effort: 'high' } }, 'codex-1': {} } });
    assert.deepEqual(
      log.filter((x) => x[0] === 'claudeOwn'),
      [['claudeOwn', chat, { model: 'opus', effort: 'high', account: null }]],
    );
    // the same again is not resent; an unlisted model counts as none
    storeSet({ runtime: { ...fx.state.runtime } });
    storeSet({ claudeChats: { [chat]: { id: 'work' } }, runtime: { [chat]: { settings: { model: 'gpt' } } } });
    storeSet({ runtime: { [chat]: { settings: null } } });
    assert.deepEqual(
      log
        .filter((x) => x[0] === 'claudeOwn')
        .slice(1)
        .map((x) => x[2]),
      // settings that are gone (unread) send only the login: main keeps the model it has (#2304)
      [{ model: null, effort: null, account: 'work' }, { account: 'work' }],
    );
    // a failed send is retried on the next change
    fx.native.session.claudeOwn = rec('claudeOwn', async () => {
      throw new Error('x');
    });
    storeSet({ claudeChats: { [chat]: { id: 'home' } } });
    await flush();
    fx.native.session.claudeOwn = rec('claudeOwn', async () => true);
    storeSet({ claude: { ...fx.state.claude, models: [{ id: 'opus' }, { id: 'x' }] } });
    assert.deepEqual(log.filter((x) => x[0] === 'claudeOwn').slice(-1)[0][2], { account: 'home' });
    // effort without a model listed
    storeSet({ runtime: { [chat]: { settings: { model: 'opus' } } } });
    assert.deepEqual(log.filter((x) => x[0] === 'claudeOwn').slice(-1)[0][2], { model: 'opus', effort: null, account: 'home' });
  });

  test('tasks, ultracode, stop, goals, rename and delete go to main', async () => {
    const chat = claudeThreadId('ctl-1');
    baseNative({ control: rec('control', async () => true), rename: rec('rename', async () => {}), remove: rec('remove', async () => {}) });
    await claude.claudeStopTask(chat, 'b1');
    await claude.claudeStopAllTasks(chat);
    // each session the tasks run in (after a switch, the chat's earlier Claude session)
    await claude.claudeStopAllTasks(chat, ['claude:old', chat]);
    await claude.setClaudeUltracode(chat, true);
    assert.deepEqual(
      log.filter((x) => x[0] === 'control'),
      [
        ['control', chat, 'stopTask', 'b1'],
        ['control', chat, 'stopAllTasks'],
        ['control', 'claude:old', 'stopAllTasks'],
        ['control', chat, 'stopAllTasks'],
        ['control', chat, 'applyFlagSettings', { ultracode: true }],
      ],
    );
    await claude.claudeStop(chat);
    await claude.claudePauseGoal(chat);
    await claude.claudeResumeGoal(chat);
    await claude.claudeExtendGoal(chat);
    await claude.claudeClearGoal(chat);
    await claude.claudeClearGoal(chat, true);
    assert.deepEqual(
      log.filter((x) => x[0] === 'claudeGoal').map((x) => x.slice(2)),
      [
        ['pause', false],
        ['resume', false],
        ['extend', false],
        ['clear', false],
        ['clear', true],
      ],
    );
    await claude.claudeRename(chat, 'New');
    assert.deepEqual(
      log.filter((x) => x[0] === 'rename'),
      [['rename', 'ctl-1', 'New']],
    );
    baseNative({
      control: async () => {
        throw new Error('gone');
      },
    });
    fx.native.session.claudeStop = async () => {
      throw 'busy';
    };
    await claude.claudeStopTask(chat, 'b1');
    await claude.claudeStopAllTasks(chat);
    await claude.setClaudeUltracode(chat, false);
    await claude.claudeStop(chat);
    assert.deepEqual(called('toast'), [
      ["Couldn't stop the task: gone", 'error'],
      ["Couldn't stop the tasks: gone", 'error'],
      ["Couldn't change ultracode: gone", 'error'],
      ["Couldn't stop: busy", 'error'],
    ]);
    baseNative({
      control: async () => {
        throw 'raw';
      },
    });
    await claude.claudeStopTask(chat, 'b1');
    await claude.claudeStopAllTasks(chat);
    await claude.setClaudeUltracode(chat, false);
    assert.deepEqual(called('toast').slice(4), [
      ["Couldn't stop the task: raw", 'error'],
      ["Couldn't stop the tasks: raw", 'error'],
      ["Couldn't change ultracode: raw", 'error'],
    ]);
    // no session running the tasks: said, not taken as stopped
    baseNative({ control: async () => null });
    await claude.claudeStopAllTasks(chat, ['claude:old']);
    assert.deepEqual(called('toast').at(-1), [
      "This chat's Claude session isn't running, so its tasks can't be stopped from here",
      'error',
    ]);
  });

  test("the / menu: Claude's catalog for its folder and login, fetched once; Codex's static table", async () => {
    const catalog = await import('../../../src/session/harness/claude/catalog.ts');
    const accounts = await import('../../../src/session/harness/claude/accounts.ts');
    assert.equal(claude.useClaudeCommands, catalog.useClaudeCommands, 'the public API shares the catalog request cache');
    assert.equal(claude.claudeChatAccount, accounts.claudeChatAccount, 'catalog and live turns share account selection');
    const chat = claudeThreadId('cmd-1');
    let fetches = 0;
    let release: (v: any) => void = () => {};
    baseNative({
      catalog: (_bin: any, cwd: string, account: string) => (
        fetches++, log.push(['catalog', cwd, account]), new Promise((r) => (release = r))
      ),
    });
    assert.equal(claude.useClaudeCommands(chat, '/w'), null);
    assert.equal(claude.useClaudeCommands(chat, '/w'), null, 'already fetching');
    assert.equal(fetches, 1);
    release({ commands: [{ name: 'review', description: 'Review', argumentHint: '' }], skills: ['pdf'], terminalSlash: null });
    await flush();
    const p = claude.useClaudeCommands(chat, '/w')!;
    assert.equal(p.kind, 'claude');
    assert.deepEqual(claude.useClaudeSkills(chat, '/w'), ['pdf']);
    assert.equal(claude.useCommandProvider(chat, '/w')!.kind, 'claude');
    // a catalog without skills or terminal commands
    fx.state.claudeCatalogs[`default\u0000/v`] = { commands: [], terminalSlash: ['x'] };
    assert.equal(claude.useClaudeCommands(null, '/v'), null, 'a new chat on Codex');
    fx.state.newChatHarness = 'claude';
    assert.deepEqual(claude.useClaudeSkills(null, '/v'), []);
    assert.equal(claude.useClaudeCommands(null, '/v')!.kind, 'claude');
    // no folder, no CLI, a Codex chat: nothing fetched
    assert.equal(claude.useClaudeCommands(chat, ''), null);
    fx.state.claude.status.bin = null;
    assert.equal(claude.useClaudeCommands(chat, '/other'), null);
    assert.equal(fetches, 1);
    assert.equal(claude.useClaudeSkills('codex-1', '/w'), null);
    assert.equal(claude.useCommandProvider('codex-1', '/w')!.kind, 'codex');
    fx.sessions.cx = { pendingSwitch: { harness: 'acp' } };
    assert.equal(claude.useCommandProvider('cx', '/w'), null);
    // an empty or failed fetch stores nothing
    fx.state.claude.status.bin = '/bin/claude';
    baseNative({ catalog: async () => null });
    claude.useClaudeCommands(chat, '/empty');
    baseNative({
      catalog: async () => {
        throw new Error('x');
      },
    });
    claude.useClaudeCommands(chat, '/fail');
    await flush();
    assert.equal(Object.keys(fx.state.claudeCatalogs).length, 2);
  });
}

export function registerSessionSettings() {
  test('settings read back from a session that runs here with another model are left alone', async () => {
    const chat = claudeThreadId('live-set');
    fx.state.threads[chat] = { id: chat };
    onEvent(evStarted(chat));
    fx.state.runtime[chat] = { turns: [], settings: { model: 'sonnet' } };
    baseNative({ sessionSettings: async () => ({ model: 'opus', effort: 'low' }) });
    await claude.openClaudeThread(chat);
    await flush();
    assert.deepEqual(fx.state.runtime[chat].settings, { model: 'sonnet' });
    // the same model, or none chosen: taken from the session
    fx.state.runtime[chat] = { ...fx.state.runtime[chat], settings: { model: 'opus' } };
    await claude.openClaudeThread(chat);
    await flush();
    assert.deepEqual(fx.state.runtime[chat].settings, { model: 'opus', effort: 'low' });
    noteOwner('unused', null);
  });

  // last: the fresh copy takes over the native event handlers the tests above use
}

export function registerTaskStops() {
  test('retained Claude task stops use their original native key after same-family and mixed switches', async () => {
    const chat = 'stable-task-chat';
    const old = 'claude:original-process';
    baseNative({ control: rec('control', async () => true) });
    for (const [harness, nativeId] of [
      ['claude', 'claude:replacement'],
      ['codex', 'replacement-thread'],
    ] as const) {
      storeSet({
        segments: {
          [chat]: [
            { harness: 'claude', nativeId: old },
            { harness, nativeId },
          ],
        },
      });
      log.length = 0;
      assert.equal(await claude.stopClaudeTask(chat, { id: 'old-job', source: { kind: 'claude', key: old } } as any), true);
      assert.deepEqual(log, [['control', old, 'stopTask', 'old-job']]);
    }
  });
}
