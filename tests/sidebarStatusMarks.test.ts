// The sidebar's PR badge and status dot draw one mark per state, each rule with one owner in the app stylesheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { appCss } from './support/app-css.ts';
import { pullRequestPresentation, type PullRequestDetails } from '../src/lib/pullRequestIndicator.ts';
import type { ThreadPullRequest } from '../src/lib/threadPullRequest.ts';
import { DOT_STATUSES } from '../src/components/sidebar/ThreadIndicators.tsx';

const url = 'https://github.com/org/repo/pull/42';
const CHECKS: PullRequestDetails['checks'][] = ['none', 'passing', 'pending', 'failing', 'unknown'];
const MERGEABLE: PullRequestDetails['mergeable'][] = ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'];
const MERGE_STATES = ['CLEAN', 'HAS_HOOKS', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'DIRTY', 'DRAFT', 'UNKNOWN'];

/** Every PR the sidebar can be handed: each lifecycle, with no details and with every combination of them. */
function everyPullRequest(): ThreadPullRequest[] {
  const all: ThreadPullRequest[] = [];
  for (const state of ['open', 'draft', 'merged', 'closed', 'unknown'] as const) {
    all.push({ url, number: 42, state });
    for (const checks of CHECKS)
      for (const mergeable of MERGEABLE)
        for (const mergeState of MERGE_STATES) all.push({ url, number: 42, state, details: { checks, mergeable, mergeState } });
  }
  return all;
}

/** The app stylesheet's top-level style rules, keyframes and all, as happy-dom parses them. */
function rules() {
  const window = new Window();
  const style = window.document.createElement('style');
  style.textContent = appCss();
  window.document.head.append(style);
  const sheet = style.sheet!;
  const list = [...sheet.cssRules] as any[];
  const styleRules = list.filter((rule) => rule.selectorText !== undefined) as { selectorText: string; style: any }[];
  const keyframes = list.filter((rule) => rule.name !== undefined && rule.cssRules) as { name: string; cssRules: any }[];
  return { styleRules, keyframes, close: () => window.happyDOM.close() };
}

const selectors = (rule: { selectorText: string }) => rule.selectorText.split(',').map((s) => s.trim());

test('no two PR states draw the same badge: the glyph and its dot tell each label apart', () => {
  const marks = new Map<string, Set<string>>();
  for (const pr of everyPullRequest()) {
    const { label, dot } = pullRequestPresentation(pr);
    const mark = `${pr.state === 'unknown' ? 'open-glyph' : pr.state} · ${dot ?? 'no dot'}`;
    marks.set(mark, (marks.get(mark) ?? new Set()).add(label));
  }
  for (const [mark, labels] of marks) {
    // a PR whose state GitHub did not report draws the open glyph in the muted color: its own mark
    assert.equal(labels.size, 1, `${mark} stands for ${[...labels].join(' and ')}`);
  }
});

test('a draft shows its checks and conflicts like an open PR, and never claims it can merge', () => {
  const draft = (checks: PullRequestDetails['checks'], mergeable: PullRequestDetails['mergeable'] = 'MERGEABLE') =>
    pullRequestPresentation({ url, number: 42, state: 'draft', details: { checks, mergeable, mergeState: 'DRAFT' } });
  assert.deepEqual(draft('failing'), { indicator: 'failing', label: 'draft · checks failing', dot: 'failing' });
  assert.deepEqual(draft('pending'), { indicator: 'in_progress', label: 'draft · checks pending', dot: 'pending' });
  assert.deepEqual(draft('passing'), { indicator: 'successful', label: 'draft · checks passed', dot: 'passing' });
  assert.deepEqual(draft('none'), { indicator: 'draft', label: 'draft' }, 'a draft with no checks is just a draft');
  assert.deepEqual(draft('unknown'), { indicator: 'draft', label: 'draft · checks unavailable', dot: 'unknown' });
  assert.deepEqual(draft('passing', 'CONFLICTING'), { indicator: 'failing', label: 'draft · merge conflicts', dot: 'conflict' });
  // GitHub reports a draft's merge state as DRAFT; even a stale CLEAN never makes a draft ready
  assert.notEqual(
    pullRequestPresentation({
      url,
      number: 42,
      state: 'draft',
      details: { checks: 'passing', mergeable: 'MERGEABLE', mergeState: 'CLEAN' },
    }).indicator,
    'ready',
  );
});

test('every CI dot the badge can draw has its own rule, and none paints a ring in a fixed background', async () => {
  const { styleRules, close } = rules();
  try {
    const dots = new Set(
      everyPullRequest()
        .map((pr) => pullRequestPresentation(pr).dot)
        .filter(Boolean) as string[],
    );
    for (const dot of dots) {
      assert.ok(
        styleRules.some((rule) => selectors(rule).includes(`.thread-pr-dot.${dot}`)),
        `.thread-pr-dot.${dot} has a rule`,
      );
    }
    for (const rule of styleRules.filter((r) => r.selectorText.includes('.thread-pr-dot'))) {
      for (const property of ['outline', 'outline-color', 'box-shadow'])
        assert.equal(rule.style.getPropertyValue(property), '', `${rule.selectorText} sets no ${property} in a row's color`);
    }
    // the glyph is cut away under the dot instead, so a hovered or selected row shows through
    const cut = styleRules.find((rule) => selectors(rule).includes('.thread-pr-icon:has(> .thread-pr-dot) svg'));
    assert.ok(cut, 'the glyph is cut away where the dot sits');
    assert.match(cut.style.getPropertyValue('mask') || cut.style.getPropertyValue('mask-image'), /radial-gradient/);
  } finally {
    await close();
  }
});

test('each PR lifecycle color has one rule, and the hover card draws the same glyph color', async () => {
  const { styleRules, close } = rules();
  try {
    for (const state of ['open', 'draft', 'merged', 'closed']) {
      const badge = styleRules.filter(
        (rule) => selectors(rule).includes(`.thread-pr-badge.${state}`) && rule.style.getPropertyValue('color'),
      );
      assert.equal(badge.length, 1, `.thread-pr-badge.${state} color is declared once`);
      const card = styleRules.filter(
        (rule) =>
          selectors(rule).includes(`.thread-pr-list-item.${state} .thread-pr-list-state svg`) && rule.style.getPropertyValue('color'),
      );
      assert.equal(card.length, 1, `the hover card colors the ${state} glyph once`);
      assert.equal(card[0].style.getPropertyValue('color'), badge[0].style.getPropertyValue('color'), `${state}: card glyph matches badge`);
    }
  } finally {
    await close();
  }
});

test('row dots style exactly the statuses the sidebar draws, and the elsewhere dot stays dimmed while it pulses', async () => {
  const { styleRules, keyframes, close } = rules();
  try {
    const styled = new Set<string>();
    for (const rule of styleRules)
      for (const selector of selectors(rule)) {
        const match = /^\.row-dot\.([\w-]+)$/.exec(selector);
        if (match) styled.add(match[1]);
      }
    assert.deepEqual([...styled].sort(), [...DOT_STATUSES].sort(), 'no rule styles a status nothing draws, and every status has one');
    const pulse = keyframes.find((rule) => rule.name === 'row-dot-pulse')!;
    assert.ok(pulse, 'the pulse keyframes exist');
    const peak = [...pulse.cssRules].map((frame: any) => frame.style.getPropertyValue('opacity')).join(' ');
    assert.match(peak, /var\(--row-dot-peak/, 'the pulse scales by the dot’s own peak instead of overriding its opacity');
    const elsewhere = styleRules.find(
      (rule) => selectors(rule).includes('.row-dot.elsewhere') && rule.style.getPropertyValue('--row-dot-peak'),
    );
    assert.equal(elsewhere?.style.getPropertyValue('--row-dot-peak').trim(), '0.6', 'a chat running elsewhere pulses at 60%');
  } finally {
    await close();
  }
});

test('the hover card says a failing PR in red whatever its lifecycle color', async () => {
  const window = new Window();
  try {
    const style = window.document.createElement('style');
    // happy-dom substitutes only custom properties a sheet defines: give the state colors distinct values
    style.textContent = `${appCss()}\n:root { --red: rgb(200, 0, 0); --green-text: rgb(0, 150, 0); --purple: rgb(120, 0, 200); }`;
    window.document.head.append(style);
    const state = (lifecycle: string, indicator: string) => {
      const item = window.document.createElement('button');
      item.className = `thread-pr-list-item ${lifecycle}`;
      item.innerHTML = `<span class="thread-pr-list-state" data-indicator="${indicator}"></span>`;
      window.document.body.append(item);
      return window.getComputedStyle(item.firstElementChild!).color;
    };
    const red = state('closed', 'closed');
    for (const lifecycle of ['open', 'draft']) assert.equal(state(lifecycle, 'failing'), red, `${lifecycle} · failing reads red`);
    assert.notEqual(state('open', 'ready'), red, 'a healthy open PR keeps its own color');
  } finally {
    await window.happyDOM.close();
  }
});
