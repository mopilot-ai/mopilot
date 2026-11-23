// Motion capture over CDP, the capture side (scripts/motion-cdp/capture.mjs, session.mjs): Animation domain events reduced to timings, element labels, summaries, the screencast timeline, and a session on an attached page.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { animationLog, animationRecord, labelOf, screencastLog, summarize, summaryTable } from '../scripts/motion-cdp/capture.mjs';
import { startCapture } from '../scripts/motion-cdp/session.mjs';
import { cssAnimation, fakes } from './support/motionCdpFakes.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-cdp-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('animationRecord reads an Animation domain animation, with missing parts defaulted', () => {
  assert.deepEqual(animationRecord(cssAnimation('a', 1250), 1000), {
    id: 'a',
    type: 'CSSAnimation',
    name: 'fade-in',
    startMs: 250,
    durationMs: 200,
    delayMs: 50,
    endDelayMs: 0,
    iterations: 1,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
    direction: 'normal',
    fill: 'both',
    keyframes: [
      { offset: '0%', easing: 'ease' },
      { offset: '100%', easing: 'ease' },
    ],
    backendNodeId: 7,
    label: null,
    canceled: false,
  });
  const bare = animationRecord({}, 0);
  assert.deepEqual(
    [bare.id, bare.type, bare.startMs, bare.durationMs, bare.iterations, bare.easing, bare.keyframes, bare.backendNodeId],
    ['', 'unknown', null, 0, 1, 'linear', [], null],
  );
  assert.equal(animationRecord(cssAnimation('i', 5, { iterations: null }), 0).iterations, null, 'an infinite spinner');
  assert.equal(animationRecord(cssAnimation('j', 5, { iterations: Number.POSITIVE_INFINITY }), 0).iterations, null);
  assert.equal(animationRecord(null, 0).name, '');
});

test('animationLog keeps started animations, marks canceled ones, and labels them by element', () => {
  const log = animationLog();
  assert.equal(log.onEvent('Animation.animationStarted', { animation: cssAnimation('a', 1000) }), true);
  assert.equal(log.onEvent('Animation.animationStarted', { animation: cssAnimation('b', 1400, { backendNodeId: 9 }) }), true);
  assert.equal(
    log.onEvent('Animation.animationStarted', { animation: { id: 'c', type: 'WebAnimation', source: { duration: 300 } } }),
    true,
  );
  assert.equal(log.onEvent('Animation.animationStarted', {}), false);
  assert.equal(log.onEvent('Animation.animationCanceled', { id: 'b' }), true);
  assert.equal(log.onEvent('Animation.animationCanceled', { id: 'nope' }), false);
  assert.equal(log.onEvent('Animation.animationCreated', { id: 'z' }), false);
  assert.deepEqual(log.unlabeled(), [7, 9]);
  log.label(7, 'div.card');
  assert.deepEqual(log.unlabeled(), [9]);
  const recs = log.records();
  assert.deepEqual(
    recs.map((r) => [r.id, r.startMs, r.label, r.canceled]),
    [
      ['a', 0, 'div.card', false],
      ['b', 400, null, true],
      ['c', null, null, false],
    ],
  );
  const given = animationLog(900);
  given.onEvent('Animation.animationStarted', { animation: cssAnimation('x', 1000) });
  given.onEvent('Animation.animationStarted', { animation: cssAnimation('y', 1000) });
  assert.deepEqual(
    given.records().map((r) => [r.id, r.startMs]),
    [
      ['x', 100],
      ['y', 100],
    ],
    'same start: by id',
  );
});

test('labelOf names an element by tag, id, classes and role attributes, never its text', () => {
  assert.equal(
    labelOf({
      nodeName: 'DIV',
      attributes: [
        'id',
        'main',
        'class',
        'approval-card  enter a b',
        'data-state',
        'open',
        'role',
        'dialog',
        'title',
        'Secret text',
        'aria-label',
        'Allow',
      ],
    }),
    'div#main.approval-card.enter.a[aria-label=Allow][data-state][role=dialog]',
  );
  assert.equal(labelOf({ nodeName: 'SPAN', pseudoType: 'before' }), 'span::before');
  assert.equal(labelOf({ nodeName: 'P', attributes: ['class'] }), 'p', 'a lone attribute name is ignored');
  assert.equal(labelOf(null), 'unknown');
  assert.equal(labelOf({}), 'unknown');
});

test('summarize groups by element, type and name; summaryTable renders it', () => {
  const log = animationLog(0);
  log.onEvent('Animation.animationStarted', { animation: cssAnimation('a', 300) });
  log.onEvent('Animation.animationStarted', { animation: cssAnimation('b', 100, { duration: 150 }) });
  log.onEvent('Animation.animationStarted', {
    animation: { id: 'c', type: 'CSSTransition', name: 'opacity', source: { duration: 120, easing: 'ease', backendNodeId: 3 } },
  });
  log.onEvent('Animation.animationStarted', { animation: { id: 'd', type: 'WebAnimation', source: {} } });
  log.label(7, 'div.row|x');
  const groups = summarize(log.records());
  assert.deepEqual(
    groups.map((g) => [g.label, g.type, g.name, g.count, g.durations, g.delays, g.firstMs]),
    [
      ['div.row|x', 'CSSAnimation', 'fade-in', 2, [150, 200], [50], 100],
      ['unlabeled', 'CSSTransition', 'opacity', 1, [120], [0], Number.POSITIVE_INFINITY],
      ['unlabeled', 'WebAnimation', '', 1, [0], [0], Number.POSITIVE_INFINITY],
    ],
  );
  const table = summaryTable(groups);
  assert.match(table, /\| 100 \| `div.row\\\|x` \| CSSAnimation \| fade-in \| 2 \| 150, 200 \| 50 \| `cubic-bezier\(0.2, 0, 0, 1\)` \|/);
  assert.match(table, /\| – \| `unlabeled` \| WebAnimation \| – \| 1 \|/);
});

test('screencastLog names frames and lists their times from the first', () => {
  const shots = screencastLog();
  assert.equal(shots.origin(), null);
  assert.deepEqual(shots.index(), []);
  assert.equal(shots.add({ metadata: { timestamp: 1000.5 } }, 0), '000000.jpg');
  assert.equal(shots.add({ metadata: { timestamp: 1000.5166 } }, 0), '000001.jpg');
  assert.equal(shots.add({}, 1_000_600), '000002.jpg', 'no timestamp: the time it arrived');
  assert.equal(shots.origin(), 1_000_500);
  assert.deepEqual(shots.index(), [
    { file: '000000.jpg', t: 0 },
    { file: '000001.jpg', t: 0.017 },
    { file: '000002.jpg', t: 0.1 },
  ]);
});

test('a session started on an attached page takes its regions from the viewport, and works with no marks', async () => {
  const { page } = fakes(dir);
  const out = path.join(dir, 'attached');
  const capture = await startCapture(page, { dir: out, reduced: false, quality: 70 });
  const summary = await capture.finish({
    title: 'ChatGPT: animations during turn-start',
    arm: 'desk-chatgpt',
    family: 'chatgpt',
    moment: 'turn-start',
    marks: {},
    regions: (vp) => ({ whole: [0, 0, vp[0], vp[1]], none: null }),
  });
  assert.equal(summary, '0 animations in 0 groups, 0 frames');
  const rec = JSON.parse(fs.readFileSync(path.join(out, 'recording.json'), 'utf8'));
  assert.deepEqual(
    [rec.arm, rec.family, rec.regions, rec.sync],
    ['desk-chatgpt', 'chatgpt', { whole: [0, 0, 1200, 800] }, { clock: 'wall', originMs: 1_700_000_005_000 }],
  );
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /^# ChatGPT: animations during turn-start\n/);
});
