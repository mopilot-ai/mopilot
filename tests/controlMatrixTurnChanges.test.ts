// Every harness family's turns are snapshotted on main's one TurnChanges (electron/session/turnChanges.cjs), so what a shell
// command wrote is in the turn's changes on each of them: #316 gave Codex the snapshots and left Claude Code and ACP to
// their edit tools' items. A family this table lacks fails here.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test, assert, thread, setup } from './support/codex-adapter/fixture.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);

const { MAIN_TRAITS } = require('../electron/harness/family.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { TurnSnapshots } = require('../electron/session/turnSnapshots.cjs');

/** A chat controller whose Claude Code and ACP turns snapshot on `owner`, as main attaches it. */
function controller(owner: any) {
  const kindOf = (id: string) => (id.startsWith('cl') ? 'claude' : 'acp:kimi');
  const rec = (id: string) => ({ id, segments: [{ kind: kindOf(id), nativeId: id }] });
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: {
      record: rec,
      records: new Map([
        ['cl1', rec('cl1')],
        ['acp1', rec('acp1')],
      ]),
    },
    codex: {},
    claudeTurns: { startTurn: async () => ({ started: true }), crashed: () => {} },
    acpTurns: { startTurn: async () => ({ started: true }) },
    claude: { send: async () => true },
    acp: { send: async () => true, cancel: () => true },
  });
  new TurnSnapshots({ changes: owner, publish: () => {}, state }).attach(c);
  return { c, state };
}

/** Starts one turn of the family in /work through its production path; the native key it runs on. */
const START: Record<string, (owner: any) => Promise<string>> = {
  codex: async (owner) => {
    const { a } = setup({}, { turnChanges: owner });
    a.hold('native', thread('native', { preview: 'existing' }));
    assert.equal((await a.startTurn('native', { kind: 'codex', id: 'native' }, { text: 'run the script', opts: {} })).started, true);
    return 'native';
  },
  claude: async (owner) => {
    const { c } = controller(owner);
    await c.claudeSend('cl1', 'claude:cl1', { cwd: '/work' }, null, 'next', { uuid: 'p1' });
    return 'claude:cl1';
  },
  acp: async (owner) => {
    const { c, state } = controller(owner);
    state.patch('acp1', { plan: false });
    c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 'at-p1', cwd: '/work' });
    return 'acp:kimi:acp1';
  },
};

test('every harness family has a turn start in the snapshot matrix', () => {
  assert.deepEqual(Object.keys(START).sort(), Object.keys(MAIN_TRAITS).sort());
});

for (const family of Object.keys(MAIN_TRAITS)) {
  test(`${family}: a turn snapshots its folder on the shared TurnChanges`, async () => {
    const begun: [string, string][] = [];
    const owner = {
      begin: async (key: string, cwd: string) => void begun.push([key, cwd]),
      abort() {},
      itemStarted() {},
    };
    const key = await defined(START[family])(owner);
    assert.deepEqual(begun, [[key, '/work']]);
  });
}

/** Every main-process source file. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === 'node_modules' ? [] : sources(join(dir, e.name))) : /\.c?js$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

// main's wiring hands that one TurnChanges to the Codex adapter and the snapshots: tests/turnChangesWiring.test.ts
test('main builds TurnChanges in one place only', () => {
  const builds = sources('electron').filter((f) =>
    /new \(?(?:require\([^)]*turnChanges\.cjs'\)\.)?TurnChanges\)?\(/.test(readFileSync(f, 'utf8')),
  );
  assert.deepEqual(builds, [join('electron', 'session', 'turnSnapshots.cjs')]);
});

function defined<T>(value: T | undefined): T {
  assert.ok(value);
  return value;
}
