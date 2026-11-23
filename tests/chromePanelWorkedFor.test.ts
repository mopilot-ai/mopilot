// "Worked for 11s" in Chrome's side panel (electron/capabilities/browser/chromePanelLive.cjs rowsOf, electron/chrome-extension/src/panelStep.mjs, panelThread.mjs): a finished turn that worked in one run of steps folds them under how long it worked, as ChatGPT's panel does, instead of "6 steps · Used a tool" (#3046).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { el } from './support/side-panel-page.ts';

const require = createRequire(import.meta.url);
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { workedFor } = await import('../electron/chrome-extension/src/panelStep.mjs');

const user = { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Pay the fee' }] };
const agent = (text: string) => ({ type: 'agentMessage', id: `a-${text}`, text });
const step = (id: string) => ({
  type: 'mcpToolCall',
  id,
  server: 'mopilot_browser',
  tool: 'navigate',
  arguments: { url: 'https://a.example/' },
});
const turn = (items: any[], o: object = {}) => ({ id: 't1', status: 'completed', durationMs: 11_400, items, ...o });
const worked = (turns: any[]) =>
  rowsOf(turns)
    .rows.filter((r: any) => r.role === 'step')
    .map((r: any) => r.workedMs);

test('a completed turn with one run of steps carries how long it worked on each step', () => {
  assert.deepEqual(worked([turn([user, step('s1'), step('s2'), agent('Done.')])]), [11_400, 11_400]);
  // a turn that only worked, and one whose steps come after its reply
  assert.deepEqual(worked([turn([user, step('s1')])]), [11_400]);
  assert.deepEqual(worked([turn([user, agent('On it.'), step('s1'), step('s2')])]), [11_400, 11_400]);
  // each turn its own time
  assert.deepEqual(
    worked([turn([user, step('s1')], { id: 't1' }), turn([user, step('s2')], { id: 't2', durationMs: 3_000 })]),
    [11_400, 3_000],
  );
});

test('no time where it would mislead: several runs, a turn still running, stopped or failed, no or a tiny duration', () => {
  // a reply between the steps makes two runs: the turn's time would be said twice
  assert.deepEqual(worked([turn([user, step('s1'), agent('Halfway.'), step('s2')])]), [undefined, undefined]);
  assert.deepEqual(worked([turn([user, step('s1')], { status: 'inProgress' })]), [undefined]);
  // stopped or failed: the app says that, not how long it worked
  assert.deepEqual(worked([turn([user, step('s1')], { status: 'interrupted' })]), [undefined]);
  assert.deepEqual(worked([turn([user, step('s1')], { status: 'failed' })]), [undefined]);
  assert.deepEqual(worked([turn([user, step('s1')], { durationMs: null })]), [undefined]);
  assert.deepEqual(worked([turn([user, step('s1')], { durationMs: 'x' })]), [undefined]);
  assert.deepEqual(worked([turn([user, step('s1')], { durationMs: 999 })]), [undefined]);
  assert.deepEqual(worked([{ id: 't', items: [user, step('s1')] }]), [undefined]);
  assert.deepEqual(worked([turn([user, agent('No steps.')])]), []);
});

test('the time reads as ChatGPT says it', () => {
  assert.equal(workedFor(11_400), '11s');
  assert.equal(workedFor(60_000), '1m');
  assert.equal(workedFor(125_000), '2m 5s');
  assert.equal(workedFor(3_600_000), '1h');
  assert.equal(workedFor(3_780_000), '1h 3m');
});

/** A thread on a fake document, answering its first read with `rows`. */
async function shown(rows: any[]) {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  let answer: (r: any) => void = () => undefined;
  const t = new PanelThread({
    document,
    request: () => new Promise((r) => (answer = r)),
    onError: () => undefined,
    onOpen: () => undefined,
  });
  const opened = t.open('c1', {});
  answer({ rows, state: 'idle' });
  await opened;
  return els.rows.children.map((c: any) => [c.className, c.children[0]?.textContent ?? c.textContent]);
}

test('the panel folds a finished one-run turn under "Worked for", even one step, and a running one under its step count', async () => {
  const s = (text: string, o: object = {}) => ({ role: 'step', text, ...o });
  assert.deepEqual(await shown([s('Opened a.example', { workedMs: 11_400 }), s('Clicked', { workedMs: 11_400 })]), [
    ['steps', 'Worked for 11s'],
  ]);
  assert.deepEqual(await shown([s('Opened a.example', { workedMs: 125_000 })]), [['steps', 'Worked for 2m 5s']]);
  // no time (still running, or a turn with several runs): the count and the latest step, and a lone step stays a line
  assert.deepEqual(await shown([s('Opened a.example'), s('Clicked')]), [['steps', '2 steps · Clicked']]);
  assert.deepEqual(await shown([s('Opened a.example')]), [['step', 'Opened a.example']]);
});
