// A chat can move to an agent only when the Mac would take it; the reason is in the Mac's words (electron/app/chromePanelOptions.cjs switchBlocker).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');

test('the blockers: unknown agent, one that cannot take a chat, one without a model; an added agent keeps its own', async () => {
  const live: any = {
    codex: { modelList: async () => ({ data: [] }) },
    chats: { records: new Map() },
    controller: { state: new Map(), ref: () => null },
    acpAdmission: { list: () => [{ id: 'gemini', catalog: { configOptions: [] } }] },
    patchPrefs: () => true,
  };
  const m = createPanelOptions({
    live,
    claude: { probeInfo: () => ({ models: [] }), findBinary: async () => null, probe: async () => ({ models: [] }) },
    prefs: () => ({}),
    kindOf: () => null,
    labelOf: (k: string | null) => k,
    usable: async (id: string) => id !== 'claude',
  });
  assert.equal(await m.switchBlocker('nope'), 'Pick a harness.');
  assert.equal(await m.switchBlocker('claude'), "claude can't take a chat now.");
  assert.equal(await m.switchBlocker('codex'), 'Pick a model for codex in MoPilot first.');
  assert.equal(await m.switchBlocker('acp:gemini'), null);
});

test('the dev host’s fake app lists a signed-out agent a chat cannot move to', async () => {
  const { createFakeApp } = await import('../scripts/mobile-dev-host/fakeApp.mjs');
  const app = createFakeApp({ repo: '/repo', log: () => undefined, now: () => 1, sleep: async () => undefined, status: async () => '' });
  const rows = await app.ops.harnessStates();
  assert.deepEqual(
    rows.map((h: any) => [h.id, h.state, h.canSwitch]),
    [
      ['codex', 'ready', true],
      ['claude', 'ready', true],
      ['acp:gemini', 'signin', false],
    ],
  );
});

test('harness states: a built-in that cannot take a chat is unavailable, and a Mac with no agent admission lists only the built-ins', async () => {
  const { createHarnessStates } = require('../electron/app/chromePanelHarnessStates.cjs');
  const states = createHarnessStates({
    live: {},
    labels: { claude: 'Claude Code', codex: 'Codex' },
    usable: async (id: string) => id === 'codex',
    blocker: async (id: string) => (id === 'codex' ? null : 'not now'),
  });
  assert.deepEqual(
    (await states()).map((h: any) => [h.id, h.state, h.canSwitch, h.switchReason]),
    [
      ['claude', 'unavailable', false, 'not now'],
      ['codex', 'ready', true, null],
    ],
  );
});
