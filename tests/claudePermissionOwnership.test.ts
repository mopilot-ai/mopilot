// Live Claude permission updates follow main-owned per-chat settings and cannot overwrite a newer native lifetime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CHAT, ref, setup, item } from './support/claude-adapter.ts';
import { deferred } from './support/async-scenarios.ts';
const { createAppState } = createRequire(import.meta.url)('../electron/app/appState.cjs');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function durable(t: any) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-permission-owner-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  const live = { claudeTurns: h.adapter, controller: { invalidate() {} } };
  const state = createAppState({
    app: { getPath: () => folder, getVersion: () => '9.9.9' },
    live,
    claude: { retireChat() {}, setChatNames() {} },
    isFlagEnabled: () => false,
  });
  state.openChats();
  h.adapter.savedSettings = (id: string) => state.chats.records.get(id)?.meta?.config;
  return { ...h, state };
}

test('a saved child permission change reaches its running CLI after the global preference callback saw its old cap', async (t) => {
  const h = durable(t);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'full-access', additionalDirectories: ['/notes/live'] } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  assert.deepEqual(h.sent[0].opts.additionalDirectories, ['/notes/live']);
  h.setPrefs({ permission: 'default' });
  await h.adapter.permissionChanged();
  assert.deepEqual(h.controls, [], 'the earlier global callback preserves the saved child cap');
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'default', additionalDirectories: ['/notes/live'] } });
  await tick();
  assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'default']]);
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});

test('overlapping permission requests serialize and retain the newest mode rather than replaying a captured live record', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const first = deferred<void>();
  const second = deferred<void>();
  h.api.control = async (key: string, method: string, permission: unknown) => {
    h.controls.push([key, method, permission]);
    return permission === 'full-access' ? first.promise : second.promise;
  };
  h.setPrefs({ permission: 'full-access' });
  const older = h.adapter.permissionChanged();
  await tick();
  h.setPrefs({ permission: 'default' });
  const latest = h.adapter.permissionChanged();
  await tick();
  assert.equal(h.controls.length, 1);
  first.resolve();
  await tick();
  assert.deepEqual(h.controls, [
    [CHAT, 'setPermissionMode', 'full-access'],
    [CHAT, 'setPermissionMode', 'default'],
  ]);
  second.resolve();
  await Promise.all([older, latest]);
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});

test('main observes only permission-relevant config changes, including model capability and clearing a saved override', async (t) => {
  const h = durable(t);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'auto-review' } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const requests: any[] = [];
  const changed = h.adapter.permissionChanged.bind(h.adapter);
  h.adapter.permissionChanged = (id: any = null) => (requests.push(id), changed(id));
  h.state.chats.patchMeta(CHAT, { title: 'Renamed', unread: true });
  assert.deepEqual(requests, []);
  h.state.chats.patchMeta(CHAT, { config: { model: 'sonnet', permission: 'auto-review' } });
  await tick();
  assert.deepEqual(requests, [CHAT]);
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
  h.state.chats.patchMeta(CHAT, { config: null });
  await tick();
  assert.deepEqual(requests, [CHAT, CHAT]);
  h.state.chats.patchMeta(CHAT, { unread: false });
  assert.equal(requests.length, 2);
});

test('a failed durable write cannot update the live mode, and reopening loaded records establishes the metadata baseline', async (t) => {
  const h = durable(t);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'full-access' } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  h.state.openChats();
  const requests: string[] = [];
  h.adapter.permissionChanged = async (id: string) => (requests.push(id), []);
  h.state.chats.patchMeta(CHAT, { title: 'Only renamed' });
  assert.deepEqual(requests, []);
  h.state.chats.newer.add(CHAT);
  assert.equal(h.state.chats.patchMeta(CHAT, { config: { permission: 'default' } }), false);
  assert.deepEqual(requests, []);
  h.state.chats.newer.delete(CHAT);
  const file = h.state.chats.file(CHAT);
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => h.state.chats.patchMeta(CHAT, { config: { permission: 'default' } }));
  assert.deepEqual(requests, []);
  assert.equal(h.adapter.live.get(CHAT).permission, 'full-access');
});

test('a rejected obsolete control retries latest desired settings without replaying the failed mode', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = async (key: string, method: string, mode: any) => {
    h.controls.push([key, method, mode]);
    if (mode === 'full-access') await pending.promise;
  };
  h.setPrefs({ permission: 'full-access' });
  const old = h.adapter.permissionChanged();
  await tick();
  h.setPrefs({ permission: 'auto-review' });
  const latest = h.adapter.permissionChanged();
  pending.reject(new Error('old control failed'));
  await Promise.all([old, latest]);
  assert.deepEqual(
    h.controls.map((c) => c[2]),
    ['full-access', 'auto-review'],
  );
  assert.equal(h.adapter.live.get(CHAT).permission, 'auto-review');
});

test('a changed durable desire is reread after an obsolete rejection even without a second notification', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = async (key: string, method: string, mode: any) => {
    h.controls.push([key, method, mode]);
    if (mode === 'full-access') await pending.promise;
  };
  h.setPrefs({ permission: 'full-access' });
  const old = h.adapter.permissionChanged();
  await tick();
  h.setPrefs({ permission: 'auto-review' });
  pending.reject(new Error('old control failed'));
  await old;
  assert.deepEqual(
    h.controls.map((c) => c[2]),
    ['full-access', 'auto-review'],
  );
});

test('a closed process retires its worker and its replacement lifetime reconciles independently', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = async (key: string, method: string, mode: any) => {
    h.controls.push([key, method, mode]);
    if (mode === 'full-access') await pending.promise;
  };
  h.setPrefs({ permission: 'full-access' });
  const stale = h.adapter.permissionChanged();
  await tick();
  h.live.delete(CHAT);
  h.adapter.observe({ kind: 'closed', key: CHAT });
  h.live.add(CHAT);
  h.adapter.live.set(CHAT, { model: 'opus', permission: 'default', account: 'default', marker: 'replacement' });
  h.setPrefs({ permission: 'auto-review' });
  await h.adapter.permissionChanged();
  assert.equal(h.adapter.live.get(CHAT).permission, 'auto-review');
  pending.resolve();
  await stale;
  assert.equal(h.adapter.live.get(CHAT).permission, 'auto-review');
  assert.equal(h.adapter.live.get(CHAT).marker, 'replacement');
});

test('a replaced live record or selected native source cannot be overwritten after the control await', async () => {
  for (const retirement of ['record', 'source', 'missing-ref', 'not-live']) {
    const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
    await h.adapter.startTurn(CHAT, ref(CHAT), item());
    const pending = deferred<void>();
    h.api.control = () => pending.promise;
    h.setPrefs({ permission: 'full-access' });
    const old = h.adapter.permissionChanged();
    await tick();
    if (retirement === 'record') h.adapter.live.set(CHAT, { permission: 'default', marker: 'new-record' });
    if (retirement === 'source') h.adapter.refOf = () => ({ kind: 'codex', key: 'replacement' });
    if (retirement === 'missing-ref')
      h.adapter.refOf = () => {
        throw new Error('gone');
      };
    if (retirement === 'not-live') h.live.delete(CHAT);
    pending.resolve();
    assert.deepEqual(await old, []);
    assert.equal(h.adapter.live.get(CHAT).permission, 'default');
  }
});

test('permission updates target only the changed chat and preserve other saved caps during a global change', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  const other = 'claude:other';
  const saved: any = { [CHAT]: { model: 'opus', permission: 'full-access' }, [other]: { model: 'opus', permission: 'default' } };
  h.adapter.savedSettings = (id: string) => saved[id];
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  await h.adapter.startTurn(other, ref(other), item());
  h.setPrefs({ permission: 'full-access' });
  await h.adapter.permissionChanged();
  assert.deepEqual(h.controls, []);
  saved[CHAT].permission = 'default';
  assert.deepEqual(await h.adapter.permissionChanged(CHAT), [CHAT]);
  assert.equal(h.adapter.live.get(other).permission, 'default');
  assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'default']]);
});

test('a turn queued behind permission controls reads latest settings when it actually starts', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = async (key: string, method: string, mode: any) => {
    h.controls.push([key, method, mode]);
    if (mode === 'full-access') await pending.promise;
  };
  h.setPrefs({ permission: 'full-access' });
  const old = h.adapter.permissionChanged();
  await tick();
  const turn = h.adapter.startTurn(CHAT, ref(CHAT), item('after mode update'));
  h.setPrefs({ permission: 'default' });
  const latest = h.adapter.permissionChanged();
  assert.equal(h.sent.length, 1);
  pending.resolve();
  await Promise.all([old, latest, turn]);
  assert.equal(h.sent[1].opts.permission, 'default');
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});

test('a mode changed while the first process starts is applied once that native process exists', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  const folder = deferred<any>();
  h.adapter.api.sessionCwd = () => folder.promise;
  const turn = h.adapter.startTurn(CHAT, ref(CHAT), item());
  await tick();
  h.setPrefs({ permission: 'full-access' });
  const changed = h.adapter.permissionChanged(CHAT);
  folder.resolve('/current');
  await Promise.all([turn, changed]);
  assert.equal(h.sent[0].opts.permission, 'default');
  assert.equal(h.adapter.live.get(CHAT).permission, 'full-access');
  assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'full-access']]);
});

test('retirement at a queued start, native-control or folder-read await prevents an old prompt from reaching a replacement', async () => {
  for (const stage of ['queued', 'control', 'folder']) {
    const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
    const pending = deferred<any>();
    let control: Promise<any> | null = null;
    if (stage !== 'folder') {
      await h.adapter.startTurn(CHAT, ref(CHAT), item());
      h.setPrefs({ permission: 'full-access' });
      h.api.control = () => pending.promise;
      if (stage === 'queued') {
        control = h.adapter.permissionChanged();
        await tick();
      }
    } else h.adapter.api.sessionCwd = () => pending.promise;
    const before = h.sent.length;
    const turn = h.adapter.startTurn(CHAT, ref(CHAT), item('retired prompt'));
    await tick();
    h.adapter.observe({ kind: 'closed', key: CHAT });
    pending.resolve('/retired');
    if (control) await control;
    assert.equal((await turn).started, false, stage);
    assert.equal(h.sent.length, before, stage);
  }
});

test('an accepted old prompt is never replayed or written over a new live record after its receipt waits', async () => {
  const h = setup();
  const accepted = deferred<any>();
  h.adapter.sendTo = () => accepted.promise;
  const turn = h.adapter.startTurn(CHAT, ref(CHAT), item());
  await tick();
  h.adapter.observe({ kind: 'closed', key: CHAT });
  h.adapter.live.set(CHAT, { marker: 'replacement', permission: 'default' });
  accepted.resolve({ elsewhere: [] });
  assert.equal((await turn).started, true, 'native acceptance cannot become retryable merely because its source retired');
  assert.equal(h.adapter.live.get(CHAT).marker, 'replacement');
});

test('a failed settings job does not block the next turn; missing live records and obsolete sources receive no controls', async () => {
  const h = setup();
  let reads = 0;
  h.adapter.savedSettings = () => {
    if (++reads === 1) throw new Error('settings unavailable');
    return {};
  };
  const first = h.adapter.startTurn(CHAT, ref(CHAT), item());
  const retry = h.adapter.startTurn(CHAT, ref(CHAT), item('retry'));
  await assert.rejects(first, /settings unavailable/);
  assert.equal((await retry).started, true);
  h.adapter.live.delete(CHAT);
  h.adapter.startingTurns.set(CHAT, 1);
  assert.deepEqual(await h.adapter.permissionChanged(), []);
  h.adapter.startingTurns.delete(CHAT);
  assert.deepEqual(h.controls, []);
});

test('deleted or archived metadata cannot send a permission control, and an archived-mode change waits for a future live turn', async (t) => {
  const h = durable(t);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'full-access' } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const requested: string[] = [];
  h.adapter.permissionChanged = async (id: string) => (requested.push(id), []);
  h.state.chats.onChange(CHAT, null);
  assert.deepEqual(requested, []);
  h.state.chats.patchMeta(CHAT, { archived: 10, config: { permission: 'default' } });
  assert.deepEqual(requested, []);
});

test('a mode notification failure stays observable without failing the durable configuration write', async (t) => {
  const h = durable(t);
  h.adapter.permissionChanged = async () => {
    throw new Error('live control unavailable');
  };
  assert.equal(h.state.chats.patchMeta(CHAT, { config: { permission: 'default' } }), true);
  await tick();
  assert.equal(h.state.chats.records.get(CHAT).meta.config.permission, 'default');
});

test('native plan enter remains protected and native exit resumes the current saved choice through the real event producer', async (t) => {
  const h = durable(t);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'default' } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const { ChatController } = createRequire(import.meta.url)('../electron/session/controller.cjs');
  const controller = new ChatController({
    state: h.adapter.state,
    chats: h.state.chats,
    claudeTurns: h.adapter,
    codex: {},
    acpTurns: {},
    switcher: {},
    claude: {},
  });
  const report = (permissionMode: string) => {
    const event = { kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'status', permissionMode } };
    controller.onClaudeEvent(event);
    h.adapter.observe(event); // The production main hook dispatches in this order.
  };
  report('plan');
  assert.equal(h.adapter.state.get(CHAT).plan, true);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'full-access' } });
  await tick();
  assert.equal(h.adapter.live.get(CHAT).permission, 'plan');
  assert.deepEqual(h.controls, [], 'a saved user choice does not silently exit genuine native planning');
  report('default');
  await tick();
  assert.equal(h.adapter.state.get(CHAT).plan, false);
  assert.equal(h.adapter.live.get(CHAT).permission, 'full-access');
  assert.deepEqual(h.controls, [[CHAT, 'setPermissionMode', 'full-access']]);
  h.state.chats.patchMeta(CHAT, { config: { model: 'opus', permission: 'default' } });
  await tick();
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});

test('a native mode ACK during a pending control does not discard the queued newer desired mode', async () => {
  const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = async (key: string, method: string, mode: any) => {
    h.controls.push([key, method, mode]);
    if (mode === 'full-access') await pending.promise;
    h.adapter.observe({
      kind: 'message',
      key,
      msg: { type: 'system', subtype: 'status', permissionMode: mode === 'full-access' ? 'bypassPermissions' : mode },
    });
  };
  h.setPrefs({ permission: 'full-access' });
  const before = h.adapter.permissionChanged();
  await tick();
  h.setPrefs({ permission: 'default' });
  const after = h.adapter.permissionChanged();
  pending.resolve();
  await Promise.all([before, after]);
  assert.deepEqual(
    h.controls.map((entry) => entry[2]),
    ['full-access', 'default'],
  );
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});

test('native permission reports during first send survive its receipt, while unknown, subagent and retired-source reports do not', async () => {
  const h = setup();
  const accepted = deferred<any>();
  h.adapter.sendTo = () => accepted.promise;
  const first = h.adapter.startTurn(CHAT, ref(CHAT), item());
  await tick();
  h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'init', permissionMode: 'default' } });
  h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'status', permissionMode: 'plan' } });
  accepted.resolve({ elsewhere: [] });
  await first;
  assert.equal(h.adapter.live.get(CHAT).permission, 'plan');
  for (const msg of [
    { type: 'system', subtype: 'status', permissionMode: 'future-unknown' },
    { type: 'system', subtype: 'status', permissionMode: 'bypassPermissions', parent_tool_use_id: 'subagent' },
    { type: 'system', subtype: 'other', permissionMode: 'bypassPermissions' },
  ])
    h.adapter.observe({ kind: 'message', key: CHAT, msg });
  assert.equal(h.adapter.live.get(CHAT).permission, 'plan');
  h.adapter.refOf = () => ({ kind: 'codex', key: 'selected-elsewhere' });
  h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'status', permissionMode: 'bypassPermissions' } });
  assert.equal(h.adapter.live.get(CHAT).permission, 'plan');
});

test('a refused current downgrade keeps its known native mode and tells the user that the previous mode remains active', async () => {
  const h = setup({ prefs: { permission: 'full-access', claudeSelection: { model: 'opus' } } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  h.api.control = async () => {
    throw new Error('native permission control refused');
  };
  h.setPrefs({ permission: 'default' });
  assert.deepEqual(await h.adapter.permissionChanged(CHAT), []);
  assert.equal(h.adapter.live.get(CHAT).permission, 'full-access');
  assert.ok(h.events.some(([event]) => event.kind === 'toast' && event.text.includes('previous mode is still active')));
});

test('a native mode report remains authoritative when only its control response rejects, with no false retry or failure claim', async () => {
  for (const mode of ['bypassPermissions', 'plan', 'default']) {
    const h = setup({ prefs: { claudeSelection: { model: 'opus' } } });
    await h.adapter.startTurn(CHAT, ref(CHAT), item());
    let calls = 0;
    h.api.control = async () => {
      calls++;
      h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'status', permissionMode: mode } });
      throw new Error('control response rejected');
    };
    h.setPrefs({ permission: 'full-access' });
    assert.deepEqual(await h.adapter.permissionChanged(), mode === 'bypassPermissions' ? [CHAT] : []);
    assert.equal(calls, 1, mode);
    assert.equal(h.adapter.live.get(CHAT).permission, mode === 'bypassPermissions' ? 'full-access' : mode);
    assert.equal(
      h.events.some(([event]) => event.kind === 'toast'),
      mode === 'default',
    );
  }
});

test('a mode reported before a later turn cannot overwrite that turn’s newly acknowledged settings', async () => {
  const h = setup();
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'init', permissionMode: 'bypassPermissions' } });
  await h.adapter.startTurn(CHAT, ref(CHAT), item('plan next', { plan: true }));
  assert.equal(h.adapter.live.get(CHAT).permission, 'plan');
  h.adapter.observe({ kind: 'closed', key: CHAT });
  assert.equal(h.adapter.nativePermissionReports.has(CHAT), false, 'a closed lifetime releases its native reports');
});

test('a failed old control after process closure cannot show a failure for its replacement', async () => {
  const h = setup();
  await h.adapter.startTurn(CHAT, ref(CHAT), item());
  const pending = deferred<void>();
  h.api.control = () => pending.promise;
  h.setPrefs({ permission: 'full-access' });
  const update = h.adapter.permissionChanged();
  await tick();
  h.adapter.observe({ kind: 'closed', key: CHAT });
  pending.reject(new Error('old process closed'));
  assert.deepEqual(await update, []);
  assert.equal(
    h.events.some(([event]) => event.kind === 'toast'),
    false,
  );
});

test('a plan-exit notification failure cannot erase the native mode or escape the event producer', async () => {
  const h = setup();
  await h.adapter.startTurn(CHAT, ref(CHAT), item('plan', { plan: true }));
  h.adapter.permissionChanged = async () => {
    throw new Error('notification unavailable');
  };
  h.adapter.observe({ kind: 'message', key: CHAT, msg: { type: 'system', subtype: 'status', permissionMode: 'default' } });
  await tick();
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
  const { observeNativePermission } = createRequire(import.meta.url)('../electron/harness/claude/permissions.cjs');
  h.adapter.refOf = () => ({ kind: 'codex', key: 'replacement' });
  assert.equal(observeNativePermission(h.adapter, CHAT, { type: 'system', subtype: 'status', permissionMode: 'bypassPermissions' }), false);
  assert.equal(h.adapter.live.get(CHAT).permission, 'default');
});
