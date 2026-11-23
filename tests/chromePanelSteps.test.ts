// The side panel's steps (electron/chrome-extension/src/panelThread.mjs): steps in a row fold into one line naming how many and the latest, and one the user opened stays open across reads, however the rows around it shift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { el } from './support/side-panel-page.ts';

const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');

function thread() {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const t = new PanelThread({ document, request: () => new Promise(() => undefined), onError: () => undefined, onOpen: () => undefined });
  /** the folded run after the reply that reads `after` */
  const group = (after: string) => {
    const kids = els.rows.children;
    return kids[kids.findIndex((c: any) => c.textContent === after) + 1];
  };
  return { t, els, group };
}
const step = (text: string) => ({ role: 'step', text });
const reply = (text: string) => ({ role: 'assistant', text });
const toggle = (g: any, open: boolean) => {
  g.open = open;
  g.listeners.toggle();
};

test('steps in a row fold into one line, the latest named; a lone step stays a line', () => {
  const { t, els } = thread();
  t.render([step('Clicked'), reply('Loading'), step('Clicked'), step('Typed text'), step('Took a screenshot')], false);
  const [one, , g] = els.rows.children;
  assert.deepEqual([one.className, g.tagName, g.className, g.open], ['step', 'DETAILS', 'steps', false]);
  assert.deepEqual([g.children[0].tagName, g.children[0].textContent], ['SUMMARY', '3 steps · Took a screenshot']);
  assert.equal(g.children.length, 4);
});

test('a run the user opened stays open as steps are added, and as older rows are left out at the top', () => {
  const { t, group } = thread();
  const rows = [reply('One'), step('Clicked'), step('Typed text'), reply('Two'), step('Clicked'), step('Typed text')];
  t.render(rows, false);
  toggle(group('Two'), true);
  // a step more in the run: still open, its line says the latest
  t.render([...rows, step('Waited')], false);
  assert.deepEqual([group('Two').open, group('Two').children[0].textContent], [true, '3 steps · Waited']);
  // the first rows left out (the recent end of a long chat): the same run, still open; the one before it isn't
  t.render(rows.slice(1).concat(step('Waited')), false);
  assert.equal(group('Two').open, true);
  t.render(rows.slice(3), false);
  assert.equal(group('Two').open, true);
  // closed by the user: closed after the next read
  toggle(group('Two'), false);
  t.render(rows, false);
  assert.equal(group('Two').open, false);
  assert.equal(group('One').open, false);
  // another chat starts with every run shut
  toggle(group('Two'), true);
  t.close();
  t.render(rows, false);
  assert.equal(group('Two').open, false);
});

test('identical repeated runs remain independent, and stable native run identity survives removal of its preceding row', () => {
  const { t, els } = thread();
  t.render([reply('Continue'), step('Clicked'), step('Typed'), reply('Continue'), step('Clicked'), step('Typed')], false);
  const one = els.rows.children[1];
  toggle(one, true);
  t.render([reply('Continue'), step('Clicked'), step('Typed'), reply('Continue'), step('Clicked'), step('Typed')], false);
  assert.equal(els.rows.children[1].open, true);
  assert.equal(els.rows.children[3].open, false);
  const stable = [
    reply('Context'),
    { ...step('Read'), runId: 'turn-item' },
    { ...step('Clicked'), runId: 'turn-item' },
    { ...step('Typed'), runId: 'turn-item' },
  ];
  t.render(stable, false);
  toggle(els.rows.children[1], true);
  t.render(stable.slice(2), true);
  assert.equal(els.rows.children[1].open, true);
});

test('a detached disclosure toggle belongs to its old chat, even when the new chat has an identical run', () => {
  const { t, els } = thread();
  t.render([step('Clicked'), step('Read page')], false);
  const old = els.rows.children[0];
  t.close();
  toggle(old, true);
  assert.equal(t.openSteps.size, 0);
  t.render([step('Clicked'), step('Read page')], false);
  assert.equal(els.rows.children[0].open, false);
});
