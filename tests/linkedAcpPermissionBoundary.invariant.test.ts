// Real controller ACP state feeds linked-child settings and each native dispatch boundary without borrowing global permissions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment } from './support/controller/fixture.ts';
import { orchestration, SESSION_BACKGROUND } from './support/orchestration-harness.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { createChildOptions } = require('../electron/session/orchestration/childSetup.cjs');
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { ClaudeAdapter } = require('../electron/harness/claude/adapter.cjs');
const { AcpTurns } = require('../electron/harness/acpTurns.cjs');
const { sendPrompt } = require('../electron/harness/acp/prompt.cjs');
const { buildSessionOptions } = require('../electron/harness/claude/sessionOptions.cjs');
const { chatPrefs, turnParams } = require('../electron/harness/codexParams.cjs');
const { createParentNotesGrant } = require('../electron/session/orchestration/parentNotes.cjs');
const { inheritedPermission } = require('../electron/harness/acp/inheritedPermission.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const anchors = { observe: 'readOnly', ask: 'ask', auto: 'auto', full: 'full', plan: 'readOnly' };

function parent(mode: string, config = false, reported: any = anchors) {
  const h = setup();
  selectSegment(h.c, h.chats, 'parent', [
    ['codex', 'old'],
    [config ? 'acp:kimi' : 'acp:qwen', 'native-parent'],
  ]);
  h.state.patch('parent', { plan: false });
  const key = h.c.ref('parent').key;
  const options = Object.keys(anchors).map((id) => ({ id }));
  h.c.onAcpEvent({
    key,
    kind: 'session',
    anchors: reported,
    ...(config
      ? {
          configOptions: [
            { id: 'mode', category: 'mode', type: 'select', currentValue: mode, options: options.map(({ id }) => ({ value: id })) },
          ],
        }
      : { modes: { currentModeId: mode, availableModes: options } }),
  });
  const live = { controller: h.c, chats: h.chats };
  return { ...h, live, key, childOptions: createChildOptions({ live, prefs: () => ({ permission: 'full-access' }) }) };
}

test('current ACP mode/config anchors cap same and mixed children, including non-plan read-only modes', async () => {
  for (const config of [false, true])
    for (const [mode, permission] of Object.entries({ observe: 'read-only', ask: 'default', auto: 'auto-review', full: 'full-access' })) {
      const h = parent(mode, config);
      for (const target of ['acp:qwen', 'acp:kimi', 'claude', 'codex']) {
        const child = await h.childOptions('parent', target, {});
        assert.equal(child.permission, permission, `${config}/${mode}/${target}`);
      }
    }
});

test('Codex and Claude permission receipts cannot override a later ACP segment on the same stable chat', async () => {
  for (const previous of ['codex', 'claude'])
    for (const permission of ['full-access', 'read-only'])
      for (const [mode, expected] of Object.entries({ observe: 'read-only', ask: 'default', auto: 'auto-review', full: 'full-access' })) {
        const h = setup();
        selectSegment(h.c, h.chats, 'parent', [[previous, 'previous-native']]);
        h.state.get('parent');
        h.chats.patchMeta('parent', { config: { permission } });
        if (previous === 'claude')
          h.c.onClaudeEvent({
            key: h.c.ref('parent').key,
            kind: 'message',
            msg: { type: 'system', subtype: 'status', permissionMode: permission === 'full-access' ? 'bypassPermissions' : 'dontAsk' },
          });
        else {
          const a = new CodexAdapter({
            server: { listeners: new Set(), send: () => {} },
            state: h.state,
            probe: null,
            prefs: () => ({ permission }),
          });
          a.ensureResumed = async () => {};
          a.nativeLifecycle.turnEnded = async () => {};
          a.defaults = async () => ({ inputs: {} });
          a.request = async () => ({ turn: { id: 'prior-turn' } });
          a.meta.set('previous-native', { preview: 'Existing thread', cwd: '/work' });
          assert.equal((await a.startTurn('parent', h.c.ref('parent'), { text: 'Earlier work' })).started, true);
        }
        const generic = h.state.get('parent').permission;
        assert.ok(generic, 'the previous native producer left a real permission receipt');
        h.state.clientPatch('parent', { plan: true });
        selectSegment(h.c, h.chats, 'parent', [
          [previous, 'previous-native'],
          ['acp:qwen', 'current-native'],
        ]);
        h.c.onAcpEvent({
          key: h.c.ref('parent').key,
          kind: 'session',
          anchors,
          modes: { currentModeId: mode, availableModes: Object.keys(anchors).map((id) => ({ id })) },
        });
        assert.equal(h.state.get('parent').permission, generic, 'ACP native scope does not replace another harness receipt');
        const options = createChildOptions({ live: { controller: h.c, chats: h.chats }, prefs: () => ({ permission: 'full-access' }) });
        for (const target of ['codex', 'claude', 'acp:qwen', 'acp:kimi'])
          assert.equal((await options('parent', target, {})).permission, expected, `${previous}/${permission}/${mode}/${target}`);
      }
});

test('native plan has a safe inherited base and an obsolete native event cannot raise the current cap', async () => {
  for (const config of [false, true]) {
    const h = parent('plan', config);
    assert.equal(h.state.get('parent').plan, true);
    const planned = await h.childOptions('parent', 'claude', {});
    assert.equal(planned.permission, 'plan');
    assert.equal(planned.planBasePermission, 'read-only');
    h.c.onAcpEvent({
      key: h.key,
      kind: 'update',
      update: config
        ? {
            sessionUpdate: 'config_option_update',
            configOptions: [
              {
                id: 'mode',
                category: 'mode',
                type: 'select',
                currentValue: 'observe',
                options: Object.keys(anchors).map((value) => ({ value })),
              },
            ],
          }
        : { sessionUpdate: 'current_mode_update', currentModeId: 'observe' },
    });
    h.c.onAcpEvent({ key: 'acp:qwen:obsolete', kind: 'session', modes: { currentModeId: 'full' }, anchors });
    assert.equal((await h.childOptions('parent', 'codex', {})).permission, 'read-only');
  }
});

test('missing, malformed and unknown ACP permission scopes refuse setup and a later valid event permits retry', async () => {
  for (const state of [undefined, null, {}, { acp: {} }, { acp: { modes: { currentModeId: 'observe' }, anchors: 'malformed' } }])
    assert.throws(() => inheritedPermission(state), /known permission scope/);
  for (const [mode, reported] of [
    ['unknown', anchors],
    ['observe', {}],
    ['observe', null],
    ['observe', []],
    ['observe', { observe: 'mystery' }],
    ['constructor', {}],
  ] as const) {
    const h = parent(mode, false, reported);
    await assert.rejects(h.childOptions('parent', 'claude', {}), /known permission scope/);
    h.c.onAcpEvent({ key: h.key, kind: 'session', modes: { currentModeId: 'ask' }, anchors });
    assert.equal((await h.childOptions('parent', 'claude', {})).permission, 'default');
  }
  const h = parent('observe');
  h.state.patch('parent', { acp: null });
  await assert.rejects(h.childOptions('parent', 'claude', {}), /known permission scope/);
  h.state.patch('parent', { acp: { anchors } });
  await assert.rejects(h.childOptions('parent', 'claude', {}), /known permission scope/);
});

test('a real ACP parent cap survives child persistence and reaches Claude, Codex and ACP native dispatch', async () => {
  const h = parent('observe');
  const sent: any[] = [];
  const prefs = () => ({ permission: 'full-access' });
  const claude = new ClaudeAdapter({
    ref: (id: string) => h.c.ref(id),
    chatOf: (key: string) => h.c.chatOf(key),
    api: { isLive: () => false, accounts: () => ({ accounts: [] }) },
    state: h.state,
    prefs,
    savedSettings: (id: string) => h.chats.records.get(id)?.meta.config,
    send: async (_id: string, _key: string, options: any) => (sent.push(buildSessionOptions(options)), {}),
  });
  const starter = new ChatStarter({
    prefs,
    chats: h.chats,
    claudeSession: (key: string, info: any) => claude.registerSession(key, { ...info, resume: true }),
    claudeOwn: (id: string, own: any) => claude.setOwn(id, own),
    acpSession: () => {},
    codexThread: async () => ({ id: 'codex-child' }),
    started: () => {},
  });
  const options = await h.childOptions('parent', 'claude', {});
  const child = starter.startClaude('/work', null, options);
  const receipt = await claude.startTurn(child, { key: child, id: child.slice(7), kind: 'claude' }, { text: 'Read files' });
  assert.equal(receipt.started, true);
  assert.equal(sent[0].permissionMode, 'dontAsk');
  assert.ok(sent[0].allowedTools.includes('Read'));
  assert.ok(!sent[0].allowedTools.includes('Write'));
  const codexChild = await starter.startCodex('/work', null, await h.childOptions('parent', 'codex', {}));
  const codex = turnParams(
    codexChild,
    'input',
    { text: 'Read files' },
    chatPrefs(prefs(), h.chats.records.get(codexChild).meta.config),
    '/work',
  );
  assert.deepEqual(codex.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  const native: any[] = [];
  const acpChild = starter.startAcp('qwen', '/work', null, await h.childOptions('parent', 'acp:qwen', {}));
  const chat: any = {
    key: acpChild,
    harness: 'qwen',
    sessionId: 'child-native',
    cwd: '/work',
    state: { modes: { currentModeId: 'full', availableModes: Object.keys(anchors).map((id) => ({ id })) } },
    agent: { caps: {}, request: async (...args: any[]) => (native.push(args), {}) },
  };
  const host: any = {
    starting: new Map(),
    ensure: async () => chat,
    assertChatCurrent: () => {},
    quirksOf: () => ({ anchors }),
    items: { readAsync: async () => [], append: () => {} },
    setMode: async (_key: string, mode: string) => native.push(['mode', mode]),
    emitEvent: () => {},
    now: () => 0,
    signedInFn: () => {},
    finish: () => {},
  };
  const acp = new AcpTurns({
    savedSettings: (id: string) => h.chats.records.get(id)?.meta.config,
    send: (_id: string, key: string, payload: any, meta: any) => sendPrompt(host, key, payload, meta),
    rename: () => {},
    readImage: async () => null,
    named: async () => true,
  });
  acp.registerSession(acpChild, { cwd: '/work' });
  assert.equal((await acp.startTurn(acpChild, { key: acpChild }, { text: 'Read files' })).started, true);
  assert.deepEqual(native[0], ['mode', 'observe']);
  assert.equal(native[1][0], 'session/prompt');
});

test('ACP notes metadata reports native approval requirements without claiming a current or future directory grant', async () => {
  const h = parent('ask');
  const granted = await createParentNotesGrant({ live: h.live })('parent', '/private/notes');
  assert.deepEqual(h.chats.records.get('parent').meta.config.additionalDirectories, ['/private/notes']);
  assert.equal(granted.granted, false);
  assert.match(granted.degraded, /cannot grant.*automatically/);
  assert.match(granted.degraded, /native approval.*current and future turns/);
  assert.doesNotMatch(granted.degraded, /granted to future turns/);
});

test('a native parent starting an ACP child reports inherited and shared directory access limitations in the actual result', async () => {
  for (const source of ['codex', 'claude']) {
    const h = orchestration({ said: () => 'Use Kimi for this task' });
    h.userTurn();
    h.records.get('top').meta = { config: { permission: 'default', additionalDirectories: ['/authorized'] } };
    h.refs.set('top', { kind: source, id: 'source-native', key: source === 'claude' ? 'claude:source-native' : 'source-native' });
    const prefs = () => ({ permission: 'default' });
    const claudeTurns = new ClaudeAdapter({
      api: { accounts: () => ({ accounts: [] }) },
      prefs,
      savedSettings: (id: string) => h.records.get(id)?.meta.config,
    });
    h.orch.o.childOptions = createChildOptions({ live: { controller: h.controller, chats: h.orch.o.chats, claudeTurns }, prefs });
    h.orch.o.prepareNotes = async () => ({ path: '/shared-notes', additionalDirectories: ['/shared-notes'] });
    const started = await h.orch.start('top', {
      title: 'Read files',
      prompt: 'Read the assigned files',
      background: SESSION_BACKGROUND,
      harness: 'acp:kimi',
      use_worktree: false,
    });
    assert.equal(started.status, 'started');
    assert.equal(started.harness, 'acp:kimi');
    assert.ok(started.ignored.some((reason: string) => /native approval.*current and future turns/.test(reason)));
    assert.deepEqual(h.journal.child(started.chat_id).settings.additionalDirectories, ['/authorized', '/shared-notes']);
    assert.doesNotMatch(started.ignored.join(' '), /granted to future turns/);
  }
});
