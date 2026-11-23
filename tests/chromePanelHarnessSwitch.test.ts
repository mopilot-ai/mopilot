// A chat's harness switched from the Chrome side panel (electron/app/chromePanelOptions.cjs switchTo, the panel's `switch`
// request in electron/capabilities/browser/chromePanel.cjs, and the Harness section of the model menu in
// electron/chrome-extension/src/panelMenus.mjs): the pending switch the app's picker records, the menus that follow the
// target until the next message, a pick while it waits, and every refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PanelMenus } from '../electron/chrome-extension/src/panelMenus.mjs';
import { el } from './support/side-panel-page.ts';

const require = createRequire(import.meta.url);
const { createPanelOptions } = require('../electron/app/chromePanelOptions.cjs');
const { ChromePanel } = require('../electron/capabilities/browser/chromePanel.cjs');

const CODEX_LIST = {
  data: [
    {
      model: 'sol',
      displayName: 'gpt-6.1-sol',
      supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
      defaultReasoningEffort: 'high',
      isDefault: true,
    },
    { model: 'mini', displayName: 'GPT-6.1-Mini', supportedReasoningEfforts: [], defaultReasoningEffort: null },
  ],
};
const CLAUDE_MODELS = [
  { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best', supportedEffortLevels: ['low', 'high'], supportsAutoMode: true },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 5.5 · Fast', supportedEffortLevels: ['low'], supportsAutoMode: true },
];
const ACP_CATALOG = {
  configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'm1', options: [{ value: 'm1', name: 'Model one' }] }],
  modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }] },
};

/** Main's side of the panel's menus over a chat `c` on `kind`, with a session state that patches as the controller's does. */
function world(
  o: {
    kind?: string | null;
    codex?: any;
    usable?: (k: string) => Promise<boolean>;
    session?: any;
    prefs?: any;
    labelOf?: (k: string | null) => string | null;
    /** called on each read of Codex's model list */
    listed?: () => void;
  } = {},
) {
  const sessions = new Map<string, any>([['c', { ...o.session }]]);
  const patches: any[] = [];
  const calls: any[] = [];
  const kinds: Record<string, string | null> = { c: o.kind === undefined ? 'claude' : o.kind };
  let prefs = { ...o.prefs };
  const live = {
    codex: {
      modelList: async () => {
        o.listed?.();
        return 'codex' in o ? o.codex : CODEX_LIST;
      },
    },
    chats: { records: new Map(), patchMeta: () => true },
    controller: {
      state: {
        get: (id: string) => sessions.get(id),
        patch: (id: string, p: any) => {
          patches.push(p);
          sessions.set(id, { ...sessions.get(id), ...p });
        },
      },
      ref: (id: string) => ({ key: `key-${id}` }),
    },
    acpAdmission: { list: () => [{ id: 'gemini', catalog: ACP_CATALOG }] },
    acpHost: {
      setConfigOption: async (...a: any[]) => calls.push(['setConfigOption', ...a]),
      setMode: async (...a: any[]) => calls.push(['setMode', ...a]),
    },
    claudeTurns: { settings: () => null, setOwn: (...a: any[]) => calls.push(['setOwn', ...a]), pickOf: () => null },
    patchPrefs: (set: any) => {
      calls.push(['patchPrefs', set]);
      prefs = { ...prefs, ...set };
    },
  };
  const claude = { probeInfo: () => ({ models: CLAUDE_MODELS }), findBinary: async () => null, probe: async () => null };
  const menus = createPanelOptions({
    live,
    claude,
    prefs: () => prefs,
    kindOf: (id: string) => kinds[id] ?? null,
    labelOf: o.labelOf ?? ((k: string | null) => (k ? `label:${k}` : null)),
    usable: o.usable ?? (async () => true),
  });
  return { menus, sessions, patches, calls, kinds, prefs: () => prefs };
}

test('a chat switched to another harness waits for its next message, and the menus follow the target until then', async () => {
  const w = world({ session: { goal: { status: 'active', objective: 'ship it' } } });
  const before = w.menus.owner('c');
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.deepEqual(w.sessions.get('c').pendingSwitch, {
    harness: 'codex',
    model: null,
    modelLabel: 'GPT-6.1 Sol',
    mode: 'auto',
    goal: 'ship it',
    multiAgent: false,
    account: null,
  });
  assert.notEqual(w.menus.owner('c'), before, 'the panel reads the menus again');
  const now = await w.menus.options({ chatId: 'c' });
  assert.equal(now.harnessId, 'codex');
  assert.equal(now.harness, 'label:codex');
  assert.equal(now.switching, true);
  assert.equal(now.model, 'sol');
  assert.equal(now.permission.title, 'What MoPilot can do');

  // a model picked while it waits: the target's default, and the model the switch goes on
  const waiting = w.menus.owner('c');
  await w.menus.choose({ chatId: 'c', model: 'mini', effort: null });
  assert.notEqual(w.menus.owner('c'), waiting);
  assert.deepEqual(w.calls.at(-1), ['patchPrefs', { model: 'mini', effort: null }]);
  assert.equal(w.sessions.get('c').pendingSwitch.model, 'mini');
  assert.equal(w.sessions.get('c').pendingSwitch.modelLabel, 'GPT-6.1 Mini');
  // the pick's own effort replaces one the switch was recorded with (set_session_harness)
  assert.equal(w.sessions.get('c').pendingSwitch.effort, null);
  assert.equal((await w.menus.options({ chatId: 'c' })).model, 'mini');
  // the waiting target picked again keeps the model picked for it
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.equal(w.sessions.get('c').pendingSwitch.model, 'mini');
  // a permission picked while it waits is the app's own setting, never the old harness's session
  await w.menus.permit({ chatId: 'c', value: 'full-access' });
  assert.deepEqual(w.calls.at(-1), ['patchPrefs', { permission: 'full-access' }]);

  // its own harness again: the waiting switch is cancelled
  await w.menus.switchTo({ chatId: 'c', harness: 'claude' });
  assert.equal(w.sessions.get('c').pendingSwitch, null);
  const count = w.patches.length;
  await w.menus.switchTo({ chatId: 'c', harness: 'claude' });
  assert.equal(w.patches.length, count, 'nothing waiting: nothing to cancel');
  const back = await w.menus.options({ chatId: 'c' });
  assert.equal(back.harnessId, 'claude');
  assert.equal(back.switching, false);
});

test('a basic harness target keeps its own model, and a finished goal is not set again', async () => {
  const w = world({ session: { goal: { status: 'complete', objective: 'done' } } });
  await w.menus.switchTo({ chatId: 'c', harness: 'acp:gemini' });
  assert.deepEqual(w.sessions.get('c').pendingSwitch, {
    harness: 'acp:gemini',
    model: '',
    modelLabel: '',
    mode: 'auto',
    goal: null,
    multiAgent: false,
    account: null,
  });
  const now = await w.menus.options({ chatId: 'c' });
  assert.equal(now.model, 'm1', 'the catalog model shows, not the empty switch model');
  // a pick goes to the target's defaults only: the switch has no model of its own to change
  const count = w.patches.length;
  await w.menus.choose({ chatId: 'c', model: 'm1', effort: null });
  assert.equal(w.patches.length, count);
  assert.equal(w.calls.filter((c) => c[0] === 'setConfigOption').length, 0, "the old harness's session is not touched");
});

test('a switch is refused for a harness that cannot take the chat, has no model, or a chat that moved meanwhile', async () => {
  await assert.rejects(world().menus.switchTo({ chatId: 'c', harness: 'nope' }), /Pick a harness/);
  await assert.rejects(world({ kind: null }).menus.switchTo({ chatId: 'c', harness: 'codex' }), /can't move to label:codex/);
  await assert.rejects(world({ usable: async () => false }).menus.switchTo({ chatId: 'c', harness: 'codex' }), /can't take a chat now/);
  await assert.rejects(
    world({ labelOf: () => null, usable: async () => false }).menus.switchTo({ chatId: 'c', harness: 'codex' }),
    /^Error: codex can't/,
  );
  await assert.rejects(world({ codex: { data: [] } }).menus.switchTo({ chatId: 'c', harness: 'codex' }), /Pick a model for label:codex/);
  const w = world({ usable: async () => true });
  const moving = w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  w.kinds.c = 'acp:gemini';
  await assert.rejects(moving, /changed harness meanwhile/);
  assert.equal(w.patches.length, 0);
});

test('a model the list lacks keeps its id as its name, in the switch and in a pick while it waits', async () => {
  const w = world({ prefs: { model: 'gone' } });
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.equal(w.sessions.get('c').pendingSwitch.modelLabel, 'gone');
  await w.menus.choose({ chatId: 'c', model: 'unlisted', effort: null });
  assert.equal(w.sessions.get('c').pendingSwitch.modelLabel, 'unlisted');
});

test('a model picked for a switch that was replaced meanwhile leaves the new switch as it is', async () => {
  const w = world();
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  const choosing = w.menus.choose({ chatId: 'c', model: 'mini', effort: null });
  w.sessions.set('c', { pendingSwitch: { harness: 'acp:gemini', model: '' } });
  await choosing;
  assert.deepEqual(w.sessions.get('c').pendingSwitch, { harness: 'acp:gemini', model: '' });
  // a new chat's pick (no chat named) changes only the defaults
  const count = w.patches.length;
  await w.menus.choose({ harness: 'codex', model: 'sol', effort: 'high' });
  assert.equal(w.patches.length, count);
});

test("the panel's switch request names a real harness and a chat", async () => {
  const asked: any[] = [];
  const panel = new ChromePanel({ switchHarness: async (p: any) => asked.push(p) });
  const replies: any[] = [];
  await panel.handle({ id: 1, method: 'switch', params: { chatId: 'c', harness: 'codex' } }, (r: any) => replies.push(r));
  await panel.handle({ id: 2, method: 'switch', params: { chatId: 'c', harness: 'rm -rf' } }, (r: any) => replies.push(r));
  await panel.handle({ id: 3, method: 'switch', params: { harness: 'codex' } }, (r: any) => replies.push(r));
  await panel.handle({ id: 4, method: 'switch', params: { chatId: 'c' } }, (r: any) => replies.push(r));
  assert.deepEqual(asked, [{ chatId: 'c', harness: 'codex' }]);
  assert.deepEqual(replies[0].result, { switched: true });
  assert.equal(replies[1].error, 'Pick a harness.');
  assert.ok(replies[2].error);
  assert.equal(replies[3].error, 'Pick a harness.');
});

/** The panel's menus on a fake document; each request is answered by `answer`. */
function panelMenus(answer: (method: string, p: any) => Promise<any>) {
  const els: Record<string, any> = {};
  const picked: string[] = [];
  const errors: string[] = [];
  const asks: [string, any][] = [];
  const m = new PanelMenus({
    document: { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) },
    request: (method: string, p: any) => {
      asks.push([method, p]);
      return answer(method, p);
    },
    onError: (t: string) => errors.push(t),
    onHarness: (id: string) => picked.push(id),
  });
  const rows = () =>
    els['model-rows'].children.map((c: any) =>
      c.tagName === 'H4'
        ? `# ${c.textContent}`
        : `${c.children[0]?.textContent ?? c.textContent}${c.attrs['aria-checked'] === 'true' ? ' ✓' : ''}${c.children[1] ? ` (${c.children[1].textContent})` : ''}`,
    );
  const click = (label: string) => els['model-rows'].children.find((c: any) => c.children[0]?.textContent === label).listeners.click();
  return { m, els, picked, errors, asks, rows, click };
}

const HARNESSES = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];
const options = (harnessId: string, switching = false) => ({
  models: [{ id: 'x', label: 'Model X', description: null, efforts: [], defaultEffort: null, more: false }],
  model: 'x',
  effort: null,
  harness: harnessId,
  harnessId,
  switching,
  permission: null,
});

test("the model menu lists the harnesses: a new chat's pick stays in the panel, a chat's goes to MoPilot", async () => {
  let switching = false;
  const p = panelMenus(async (method) => {
    if (method === 'switch') {
      switching = true;
      return { switched: true };
    }
    return options(switching ? 'codex' : 'claude', switching);
  });
  await p.m.load({ harness: 'claude' });
  // the menu's second level: the harnesses, then the models
  p.m.view = 'list';
  p.m.setHarnesses([HARNESSES[0]]);
  assert.deepEqual(p.rows(), ['‹ Harness', '# Models', 'Model X ✓'], 'one harness is no choice');
  p.m.setHarnesses(HARNESSES);
  assert.deepEqual(p.rows(), ['‹ Harness', 'Claude Code ✓', 'Codex', '# Models', 'Model X ✓']);
  await p.click('Codex');
  assert.deepEqual(p.picked, ['codex']);
  assert.equal(p.asks.filter(([m]) => m === 'switch').length, 0);

  await p.m.load({ chatId: 'c' });
  p.click('Codex');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(p.asks.at(-2), ['switch', { chatId: 'c', harness: 'codex' }]);
  assert.deepEqual(p.asks.at(-1), ['options', { chatId: 'c' }], 'the menus follow the harness the next message goes to');
  assert.deepEqual(p.rows().slice(0, 3), ['‹ Harness', 'Claude Code', 'Codex ✓ (From your next message)']);
});

test('a refused switch says why and keeps the menus; one answered after the panel moved on says nothing', async () => {
  let fail: (e: Error) => void = () => {};
  const p = panelMenus((method) =>
    method === 'switch' ? new Promise((_r, reject) => (fail = reject)) : Promise.resolve(options('claude')),
  );
  p.m.setHarnesses(HARNESSES);
  await p.m.load({ chatId: 'c' });
  const refused = p.m.harness('codex');
  fail(new Error("This chat can't move to Codex."));
  await refused;
  assert.deepEqual(p.errors, ["This chat can't move to Codex."]);
  assert.equal(p.asks.filter(([m]) => m === 'options').length, 1, 'no reload after a refusal');

  const late = p.m.harness('codex');
  await p.m.load({ chatId: 'other' });
  fail(new Error('too late'));
  await late;
  assert.deepEqual(p.errors, ["This chat can't move to Codex."]);
});

test('one move to Codex reads its model list once, for the check and for the model the switch starts on (#4986)', async () => {
  let reads = 0;
  const w = world({ listed: () => reads++ });
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.equal(reads, 1);
  assert.equal(w.sessions.get('c').pendingSwitch.model, null);
  // the phone's read after the pick is its own read of the chat's menus
  await w.menus.options({ chatId: 'c' });
  assert.equal(reads, 2);
  // a move that waits already, picked again, reads nothing more for the move itself
  await w.menus.switchTo({ chatId: 'c', harness: 'codex' });
  assert.equal(reads, 2);
});

test('a move to a basic harness reads no model list at all (its own model is kept)', async () => {
  let reads = 0;
  const w = world({ listed: () => reads++ });
  await w.menus.switchTo({ chatId: 'c', harness: 'acp:gemini' });
  assert.equal(reads, 0);
  assert.equal(w.sessions.get('c').pendingSwitch.model, '');
});
