// electron/capabilities/contract/codexSkyDown.cjs and CodexAdapter.skyDown: a loaded native Codex thread whose
// Codex Computer Use service didn't start is marked down once, and its chat gets one line saying a new chat uses
// MoPilot's computer use; the thread's tools and note stay as loaded (Codex keeps them); threads with nothing
// to change are left alone (#1381).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computerDown } = require('../electron/capabilities/contract/codexSkyDown.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { isToolHidden } = require('../electron/capabilities/visibility.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');

/** A real injection whose native threads get both surfaces, hiding MoPilot's tools for the surfaces served. */
function rig(surfaces = { chrome: true, computer: true }) {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => true,
    nativeSurfaces: () => surfaces,
    visibleTools: () => ['browser_navigate', 'desktop_click'],
    nativeHideFor: (s: any) => (name: string) =>
      isToolHidden(name, { drivesUserChrome: true, nativeChrome: s.chrome, nativeComputer: s.computer }),
    degradedNote: () => null,
  });
  let id = 0;
  const load = (threadId: string) => {
    const rid = ++id;
    inj.outgoing({ id: rid, method: 'thread/start', params: {} });
    inj.observe({ id: rid, result: { thread: { id: threadId } } });
  };
  const hide = (threadId: string) => sessions.get(inj.byThread.get(threadId)).hide;
  return { inj, sessions, load, hide };
}

test('computerDown: a loaded native thread is marked down once; its tools and note stay as loaded', () => {
  const { inj, load, hide } = rig();
  load('th');
  const receipt = inj.contextReceipt('th');
  const first = inj.turnContext('th');
  inj.contextForwarded('th', first.key, receipt);
  assert.equal(inj.nativeComputerLoaded(), true);

  assert.equal(computerDown(inj, 'th'), true);
  assert.equal(inj.loadedPath('th').computer, false);
  // an update of Codex Computer Use no longer waits for this thread
  assert.equal(inj.nativeComputerLoaded(), false);
  // Codex keeps the tool list and note the thread loaded with: nothing here pretends otherwise
  assert.equal(hide('th')('desktop_click'), true);
  assert.equal(inj.turnContext('th'), null);
  assert.equal(computerDown(inj, 'th'), false, 'a second report changes nothing');
});

test("computerDown: a sub-agent's report marks its chat's thread", () => {
  const { inj, load } = rig();
  load('parent');
  inj.subagents.set('child', 'parent');
  assert.equal(computerDown(inj, 'child'), true);
  assert.equal(inj.loadedPath('parent').computer, false);
});

test('computerDown: nothing to mark for no injection, no thread, a thread not loaded, or one without native computer use', () => {
  assert.equal(computerDown(null, 'th'), false);
  assert.equal(computerDown({ isNativeThread: () => true } as any, 'th'), false);
  const { inj, load } = rig({ chrome: true, computer: false });
  assert.equal(computerDown(inj, ''), false);
  assert.equal(computerDown(inj, 'never-loaded'), false);
  load('th');
  assert.equal(computerDown(inj, 'th'), false);
});

/** CodexAdapter.skyDown on a stand-in adapter: the real method with its tools, mapper and emitter. */
function adapter(tools: any, mapped: any = (method: string, p: any) => ({ chatId: 'chat-1', params: p })) {
  const emitted: any[] = [];
  const self = { tools, mapped, emit: (e: any) => emitted.push(e) };
  return { skyDown: (id: string, turnId: string | null) => CodexAdapter.prototype.skyDown.call(self, id, turnId), emitted };
}

test('CodexAdapter.skyDown: the chat gets one line under the turn when the thread changed', () => {
  const { inj, load } = rig();
  load('th');
  const a = adapter(inj);
  a.skyDown('th', 'turn-1');
  assert.equal(a.emitted.length, 1);
  const e = a.emitted[0];
  assert.equal(e.kind, 'notification');
  assert.equal(e.chatId, 'chat-1');
  assert.equal(e.method, 'item/completed');
  assert.equal(e.params.turnId, 'turn-1');
  assert.deepEqual(e.params.item, {
    type: 'statusNote',
    id: 'computer-turn-1',
    kind: 'computer',
    text: "Codex Computer Use didn't start. Start a new chat to use MoPilot's.",
  });
  assert.ok(e.params.item.text.length <= 72);
  // reported again: the thread already moved, so no second line
  a.skyDown('th', 'turn-2');
  assert.equal(a.emitted.length, 1);
});

test('CodexAdapter.skyDown: no line without a turn, or for a thread no chat shows', () => {
  const one = rig();
  one.load('th');
  const noTurn = adapter(one.inj);
  noTurn.skyDown('th', null);
  assert.equal(noTurn.emitted.length, 0);
  assert.equal(one.inj.loadedPath('th').computer, false, 'the thread is still marked');
  const two = rig();
  two.load('th');
  const unseen = adapter(two.inj, () => null);
  unseen.skyDown('th', 'turn-1');
  assert.equal(unseen.emitted.length, 0);
});
