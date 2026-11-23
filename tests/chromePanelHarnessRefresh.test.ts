// The side panel's Harness rows (electron/chrome-extension/src/panelMenus.mjs, sidePanel.mjs): the harnesses a chat can run on are asked again each time the model menu opens, so one that wasn't ready when the panel loaded (Codex still starting, a check that failed once) is offered once it is, instead of the menu showing one harness's models until the panel reloads (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';
import { PanelMenus } from '../electron/chrome-extension/src/panelMenus.mjs';

const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const CLAUDE = { id: 'claude', label: 'Claude Code' };
const CODEX = { id: 'codex', label: 'Codex' };

/** A panel whose `harnesses` answers are taken from `answers` in turn (the last one repeats); a function or an Error is one's answer. */
async function panel(answers: (any[] | Error | (() => Promise<any[]>))[]) {
  let n = 0;
  const asked: number[] = [];
  const p = panelPage({
    reply: async (m: any) => {
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') {
        asked.push(n);
        const a = answers[Math.min(n++, answers.length - 1)];
        const list = typeof a === 'function' ? await a() : a;
        if (list instanceof Error) throw list;
        return { status: 'connected', result: { harnesses: list } };
      }
      return { status: 'connected', result: {} };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  await tick();
  const offered = () => p.els.harness.children.map((o: any) => o.value);
  const rows = () => p.els['model-rows'].children.map((c: any) => `${c.tagName}:${c.textContent}`);
  const openMenu = async () => {
    p.els.model.listeners.click();
    await tick();
    await tick();
  };
  return { p, asked, offered, rows, openMenu };
}

test('the model menu opens on the harnesses read at load, and asks again: a harness that is ready by then is offered', async () => {
  const t = await panel([[CLAUDE], [CLAUDE, CODEX]]);
  // one harness is no choice: no Harness rows
  assert.deepEqual(t.offered(), ['claude']);
  assert.equal(t.rows().includes('BUTTON:Codex'), false);
  await t.openMenu();
  assert.deepEqual(t.asked, [0, 1]);
  assert.deepEqual(t.offered(), ['claude', 'codex']);
  // the menu opens on the effort; its title row leads to the harnesses and models
  t.p.els['model-rows'].children[0].listeners.click();
  assert.deepEqual(
    t.rows().filter((r: string) => r.startsWith('H4:') || r === 'BUTTON:Codex' || r === 'BUTTON:‹ Harness'),
    ['BUTTON:‹ Harness', 'BUTTON:Codex', 'H4:Models'],
  );
});

test('a refresh keeps the harness the next new chat is on, and is asked only when the model menu opens', async () => {
  const t = await panel([
    [CLAUDE, CODEX],
    [CODEX, CLAUDE],
  ]);
  t.p.els.harness.value = 'codex';
  await t.openMenu();
  assert.deepEqual(t.offered(), ['codex', 'claude']);
  assert.equal(t.p.els.harness.value, 'codex');
  // closing it, and the permission menu, ask nothing
  t.p.els.model.listeners.click();
  t.p.els.perm.listeners.click();
  await tick();
  assert.equal(t.asked.length, 2);
  // a pick gone from the list falls back to the first
  const gone = await panel([[CLAUDE, CODEX], [CLAUDE]]);
  gone.p.els.harness.value = 'codex';
  await gone.openMenu();
  assert.equal(gone.p.els.harness.value, 'claude');
});

test('an answer with none, or a failed ask, leaves the list as it was; the failure is shown', async () => {
  const empty = await panel([[CLAUDE, CODEX], []]);
  await empty.openMenu();
  assert.deepEqual(empty.offered(), ['claude', 'codex']);
  const failed = await panel([[CLAUDE, CODEX], new Error('MoPilot is busy')]);
  await failed.openMenu();
  assert.deepEqual(failed.offered(), ['claude', 'codex']);
  assert.match(failed.p.els.error.textContent, /busy/);
});

test('two asks in a row: the later answer wins, however the answers arrive', async () => {
  let late!: (l: any[]) => void;
  const t = await panel([[CLAUDE], () => new Promise<any[]>((r) => (late = r)), [CLAUDE, CODEX]]);
  await t.openMenu();
  // the first ask is still out; closing and opening again asks a second time
  t.p.els.model.listeners.click();
  await t.openMenu();
  assert.deepEqual(t.offered(), ['claude', 'codex']);
  // the first ask answers last, with a list from before: it is not applied
  late([CLAUDE]);
  await tick();
  assert.deepEqual(t.offered(), ['claude', 'codex']);
});

test('only the model menu opening asks: PanelMenus calls onModelMenu for it and for nothing else', () => {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  let asked = 0;
  const m = new PanelMenus({
    document,
    request: async () => ({}),
    onError: () => undefined,
    onHarness: () => undefined,
    onModelMenu: () => asked++,
  });
  m.toggle('perm-menu');
  assert.equal(asked, 0);
  m.toggle('model-menu');
  assert.equal(asked, 1);
  // closing it is no opening
  m.toggle('model-menu');
  assert.equal(asked, 1);
  // a menu built without the hook still opens
  const plain = new PanelMenus({ document, request: async () => ({}), onError: () => undefined, onHarness: () => undefined });
  plain.toggle('model-menu');
  assert.equal(els['model-menu'].hidden, false);
});

test('a harness list that did not change leaves the menu’s rows as they are, so a press that began on one is not lost; a changed one draws them again', () => {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  const m = new PanelMenus({ document, request: async () => ({}), onError: () => undefined, onHarness: () => undefined });
  let drawn = 0;
  const render = m.render.bind(m);
  m.render = () => (drawn++, render());
  m.setHarnesses([CLAUDE, CODEX]);
  assert.equal(drawn, 1);
  m.setHarnesses([{ ...CLAUDE }, { ...CODEX }]);
  assert.equal(drawn, 1, 'the same harnesses: nothing is drawn again');
  m.setHarnesses([CLAUDE]);
  assert.equal(drawn, 2, 'one fewer');
  m.setHarnesses([CLAUDE, { id: 'codex', label: 'Codex CLI' }]);
  assert.equal(drawn, 3, 'a label that changed');
  m.setHarnesses([CLAUDE, CODEX]);
  assert.equal(drawn, 4, 'an id or label that differs');
});
