// Tool disclosures and previews retain exact native identity, bounded text, shared image shapes and real DOM state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { window } from './support/dom.ts';
import type { HTMLDetailsElement } from 'happy-dom';
import { stepElement } from '../electron/chrome-extension/src/panelStep.mjs';
const require = createRequire(import.meta.url);
const { stepDetails } = require('../electron/capabilities/contract/chromePanelStep.cjs');
const { rowsOf } = require('../electron/capabilities/browser/chromePanelLive.cjs');
const { PanelHistoryMedia } = require('../electron/session/panelHistoryMedia.cjs');
const { readPeerTurns, readPeerReference } = require('../electron/session/peerTranscript.cjs');
const png = 'data:image/png;base64,iVBORw0KGgo=';
const tool = (id: string, data = 'A'.repeat(6000)) => ({
  type: 'mcpToolCall',
  id,
  tool: 'mcp__mopilot_chrome__computer',
  arguments: { action: 'screenshot' },
  result: { content: [{ type: 'image', mimeType: 'image/png', data }] },
});

test('step details bound nested input, result text and screenshots, and identify only actual Chrome namespaces', () => {
  const detail = stepDetails({
    ...tool('one'),
    arguments: {
      text: 'x'.repeat(10000),
      list: Array.from({ length: 100 }, () => ({ a: { b: { deep: true } } })),
      flag: true,
      number: 2,
      empty: null,
      odd: 1n,
    },
    result: {
      content: [
        { type: 'text', text: 'y'.repeat(10000) },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
        { type: 'unknown', data: 'SHOULD NOT SHOW' },
      ],
    },
  });
  assert.equal(detail.surface, 'chrome');
  assert.ok(detail.detail.length <= 4000);
  assert.match(detail.detail, /Nested value/);
  assert.doesNotMatch(detail.detail, /SHOULD NOT SHOW|base64/);
  assert.equal(detail.thumbnail, 'data:image/png;base64,AAA=');
  for (const server of ['mopilot_chrome', 'claude-in-chrome']) assert.equal(stepDetails({ server }).surface, 'chrome');
  assert.equal(stepDetails({ tool: 'chrome_navigate' }).surface, 'chrome');
  assert.deepEqual(stepDetails({}), {});
  assert.deepEqual(stepDetails({ arguments: undefined, result: { content: 'malformed' } }), {});
  assert.equal(stepDetails({ tool: 'other_screenshot', contentItems: [{ type: 'inputImage', imageUrl: png }] }).thumbnail, undefined);
  assert.equal(stepDetails({ ...tool('big', 'x'.repeat(400001)) }).thumbnail, undefined);
  assert.equal(stepDetails({ tool: 'chrome_screenshot', panelThumbnail: 'https://outside.test/pixel' }).thumbnail, undefined);
  assert.match(stepDetails({ command: 'echo safe', error: { message: 'Failed' } }).detail, /Result \(preview\)\nFailed/);
  assert.match(stepDetails({ arguments: Symbol('test') }).detail, /Symbol/);
});

test('scoped full history preserves one real screenshot while reference media stays stripped', async () => {
  const turn = { id: 't', items: [tool('shot')] };
  const record = { segments: [{ kind: 'claude', nativeId: 'sid' }] };
  const read = async () => ({ turns: [turn] });
  const full = await readPeerTurns(record, read);
  const item = full.turns[0].items[0];
  assert.match(item.result.content[0].data, /not included/);
  assert.equal(item.panelThumbnail, `data:image/png;base64,${'A'.repeat(6000)}`);
  assert.equal(rowsOf(full.turns).rows[0].thumbnail, item.panelThumbnail);
  const reference = await readPeerReference(record, read);
  assert.doesNotMatch(JSON.stringify(reference), /panelThumbnail|data:image\/png;base64/);
  assert.equal(turn.items[0].result.content[0].data.length, 6000, 'the native producer is never mutated');
});

test('the preview shelf is bounded, namespaced by source and item, and respects sliced-away history', () => {
  const media = new PanelHistoryMedia();
  media.keep('a', {});
  media.keep('a', { id: 'empty' });
  media.keep('a', { id: 't', items: [null, { type: 'mcpToolCall' }, { type: 'plan', id: 'p' }, { type: 'mcpToolCall', id: 'none' }] });
  for (let i = 0; i < 6; i++) media.keep('a', { id: `t${i}`, items: [tool('shot')] });
  assert.equal(media.recent.size, 4);
  const absent = [{ sourceSession: 'a', id: 't0', items: [{ id: 'shot' }] }];
  media.apply(absent);
  assert.equal((absent[0].items[0] as any).panelThumbnail, undefined);
  const selected: any[] = [
    { sourceSession: 'b', id: 't5', items: [{ id: 'shot' }] },
    { sourceSession: 'a', id: 't4', items: [{ id: 'shot' }] },
    { sourceSession: 'a', id: 'empty' },
  ];
  media.apply(selected);
  assert.equal(selected[0].items[0].panelThumbnail, undefined);
  assert.match(selected[1].items[0].panelThumbnail, /^data:image/);
  media.keep('a', { id: 't5', items: [tool('shot', 'BBBB')] });
  assert.equal(media.recent.size, 4);
});

test('only the latest screenshot in the current turn survives row clipping, with bounded step details', () => {
  const rows = rowsOf([
    { id: 'old', items: [tool('old')] },
    {
      id: 'new',
      sourceSession: 'native',
      items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Now' }] }, tool('first'), tool('last')],
    },
  ]).rows;
  assert.equal(rows.filter((r: any) => r.thumbnail).length, 1);
  assert.equal(rows.at(-1).id, JSON.stringify(['native', 'new', 'last']));
  assert.ok(rows.at(-1).detail);
  const total = rowsOf([
    { items: Array.from({ length: 120 }, (_, i) => ({ type: 'commandExecution', id: String(i), command: 'x'.repeat(10000) })) },
  ]);
  assert.ok(total.rows.reduce((n: number, r: any) => n + r.text.length + (r.detail?.length ?? 0), 0) <= 400000);
});

test('step DOM keeps disclosure state, text-safe details and inline-only screenshot images', () => {
  const doc = window.document;
  const opened = new Set<string>();
  const plain = stepElement(doc, { text: 'Waited' }, 'p', opened);
  assert.equal(plain.tagName, 'DIV');
  const row = { text: 'Clicked', detail: '<script>not markup</script>', surface: 'chrome', thumbnail: png };
  const el = stepElement(doc, row, 'one', opened);
  assert.equal(el.tagName, 'DETAILS');
  assert.equal(el.querySelector('script'), null);
  assert.equal(el.querySelector('pre')!.textContent, row.detail);
  assert.equal(el.querySelector('img')!.getAttribute('src'), png);
  el.open = true;
  el.dispatchEvent(new window.Event('toggle'));
  assert.equal(stepElement(doc, row, 'one', opened).open, true);
  el.open = false;
  el.dispatchEvent(new window.Event('toggle'));
  assert.equal(opened.has('one'), false);
  assert.equal(stepElement(doc, { text: 'Unsafe', thumbnail: 'https://outside.test/pixel' }, 'none', opened).querySelector('img'), null);
  assert.equal(stepElement(doc, { text: 'Only image', thumbnail: png }, 'image', opened).querySelector('pre'), null);
});

test('stripped or oversized screenshots never replace an earlier valid current-turn preview', async () => {
  const turn = { id: 't', items: [tool('valid'), tool('too-large', 'B'.repeat(450000))] };
  const full = await readPeerTurns({ segments: [{ kind: 'claude', nativeId: 'sid' }] }, async () => ({ turns: [turn] }));
  const rows = rowsOf(full.turns).rows;
  assert.equal(rows.filter((r: any) => r.thumbnail).length, 1);
  assert.equal(rows[0].thumbnail, `data:image/png;base64,${'A'.repeat(6000)}`);
  assert.equal(rows[1].thumbnail, undefined);
  assert.deepEqual(stepDetails({ ...tool('foreign'), server: 'third-party', tool: 'chrome_history_export' }).surface, undefined);
  const doc = window.document;
  const row = rowsOf([{ items: [{ type: 'agentMessage', text: 'x'.repeat(30000) }] }]).rows[0];
  const el = doc.createElement('div');
  el.textContent = row.text;
  const { messageTools } = await import('../electron/chrome-extension/src/panelMessage.mjs');
  messageTools(doc, el, row, 'clip', new Set());
  assert.equal(el.querySelector('button')!.dataset.copyState, 'Copy shown text');
  assert.match(el.querySelector('button')!.getAttribute('aria-label')!, /truncated/);
  const step = stepElement(doc, rows[0], 'step', new Set());
  messageTools(doc, step, rows[0], 'step', new Set());
  assert.equal(step.querySelector('button'), null, 'step details do not inherit hidden message-copy controls');
});

test('unchanged native rows preserve text selection, inner scroll and duplicate-message disclosure through refresh and clipping', async () => {
  const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');
  const doc = window.document;
  doc.body.innerHTML = '<button id="load-again"></button><div id="cards"></div><div id="rows"></div><div id="live"></div>';
  const t = new PanelThread({ document: doc, request: async () => ({}), onError: () => {}, onOpen: () => {} });
  const rows = rowsOf([{ id: 't', sourceSession: 'native', items: [tool('one'), tool('two')] }]).rows;
  t.render(rows, false);
  const pre = doc.querySelector('#rows pre')!;
  pre.scrollTop = 83;
  const range = doc.createRange();
  range.selectNodeContents(pre);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const selected = selection.toString();
  t.render([...rows, { role: 'assistant', text: 'Later narration' }], false);
  assert.equal(doc.querySelector('#rows pre'), pre);
  assert.equal(pre.scrollTop, 83);
  assert.equal(selection.toString(), selected);
  const prompts = rowsOf([
    { id: 'a', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Long '.repeat(180) }] }] },
    { id: 'b', items: [{ type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'Long '.repeat(180) }] }] },
  ]).rows;
  t.render(prompts, false);
  const second = doc.querySelectorAll('.message-fold')[1] as HTMLDetailsElement;
  second.open = true;
  second.dispatchEvent(new window.Event('toggle'));
  t.render([prompts[1]], false);
  assert.equal(doc.querySelector('.message-fold'), second);
  assert.equal(second.open, true);
  t.render([], false);
  assert.equal(doc.getElementById('rows')!.children.length, 0);
  doc.body.replaceChildren();
});

test('clipping and omission replace only obsolete nodes and never move surviving native rows', async () => {
  const { reconcile } = await import('../electron/chrome-extension/src/panelNodes.mjs');
  const doc = window.document;
  const parent = doc.createElement('div');
  const stale = doc.createElement('p'),
    a = doc.createElement('div'),
    b = doc.createElement('div');
  parent.append(stale, a, b);
  const moved: any[] = [];
  const insert = parent.insertBefore.bind(parent);
  parent.insertBefore = ((node: any, before: any) => {
    if (node.parentNode === parent) moved.push(node);
    return insert(node, before);
  }) as any;
  reconcile(parent, [a, b]);
  assert.deepEqual(moved, []);
  reconcile(parent, [doc.createElement('p'), a, b]);
  reconcile(parent, [doc.createElement('p'), a, b]);
  assert.deepEqual(moved, []);
  const clip = rowsOf([{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'x'.repeat(30000) }] }] }]).rows[0];
  assert.equal(clip.truncated, true);
  assert.equal(clip.text.length, 20001);
});
