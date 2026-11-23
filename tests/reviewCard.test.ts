// The review card, matched to Claude Code's app: findings by file with status badges, Apply fixes or Re-run review, Walk
// through in diff, rows that open to the whole finding, the re-report's one line, and Codex's review text as the same list.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import postcss from 'postcss';
import { appCss } from './support/app-css.ts';
import { mockStore, autoMock, stubComponent, render, callsTo, moduleCalls, resetStore, setStore, settle } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown') });
autoMock('src/session/open.ts', 'open');
const { ReviewCard } = await import('../src/components/thread/ReviewCard.tsx');

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? '';
const findings = [
  {
    file: 'electron/windows.cjs',
    line: 12,
    summary: 'The frameless window has no shadow on Linux.',
    shortSummary: 'No frame/shadow on Linux',
    failureScenario: 'On Ubuntu the window has no border.',
    category: 'cross-platform',
  },
  { file: 'src/styles/app.css', line: 40, summary: 'Header padding no longer drags the window.', failureScenario: '-' },
  { file: 'electron/windows.cjs', line: 30, summary: 'Background ignores the theme pref.', category: 'correctness', verdict: 'CONFIRMED' },
  { file: 'src/Mini.tsx', line: null, summary: 'New chat cannot clear an error.', verdict: 'PLAUSIBLE' },
];
const item = (patch: object = {}) => ({ id: 'r1', review: '- `x`', findings, level: 'high', ...patch });
const turnWith = (...items: object[]) => ({
  id: `t${items.length}`,
  status: 'completed',
  items: items.map((i) => ({ type: 'exitedReviewMode', ...i })),
});
const button = (v: { $$: (s: string) => HTMLElement[] }, label: string) =>
  v.$$('button').find((b) => text(b) === label) as HTMLButtonElement | undefined;
const card = (props: object = {}) => h(ReviewCard, { item: item(), cwd: '/repo', chatId: 'c1', latest: true, ...props } as any);

beforeEach(() => {
  moduleCalls.length = 0;
  resetStore({ reviewMarks: {}, reviewTargets: {}, runtime: { c1: { turns: [turnWith(item())] } } });
});

test("the header, files and rows read as Claude Code's card: level and count, file names, badge and label", async () => {
  const v = await render(card());
  assert.equal(text(v.$('.findings-title')), 'Code review');
  assert.equal(text(v.$('.findings-meta')), 'high · 4 findings');
  assert.deepEqual(
    v.$$('.findings-file-name').map((n) => [text(n), n.title]),
    [
      ['windows.cjs', 'electron/windows.cjs'],
      ['app.css', 'src/styles/app.css'],
      ['Mini.tsx', 'src/Mini.tsx'],
    ],
  );
  assert.deepEqual(
    v
      .$$('.finding-row')
      .map((r) => [
        text(r.querySelector('.finding-badge')),
        r.querySelector('.finding-badge')!.className,
        text(r.querySelector('.finding-label')),
      ]),
    [
      ['Cross platform', 'finding-badge category', 'electron/windows.cjs:12. No frame/shadow on Linux'],
      ['Confirmed', 'finding-badge danger', 'electron/windows.cjs:30. Background ignores the theme pref'],
      ['Unverified', 'finding-badge', 'src/styles/app.css:40. Header padding no longer drags the window'],
      ['Plausible', 'finding-badge warning', 'src/Mini.tsx. New chat cannot clear an error'],
    ],
  );
  await settle(() => v.$('.findings-file-name')!.click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['electron/windows.cjs', '/repo']);
  // a path with no file name shows as written
  await v.rerender(card({ item: item({ findings: [{ ...findings[0], file: 'docs/' }] }) }));
  assert.equal(text(v.$('.findings-file-name')), 'docs/');
  // no level: the count alone, in the singular for one
  await v.rerender(card({ item: item({ level: null, findings: [findings[0]] }) }));
  assert.equal(text(v.$('.findings-meta')), '1 finding');
  await v.unmount();
});

test('a row opens to the summary, failure scenario and location, with View in diff, and stays open when shown again', async () => {
  const v = await render(card());
  const rows = () => v.$$('.finding-row');
  await settle(() => rows()[0].click());
  assert.equal(rows()[0].getAttribute('aria-expanded'), 'true');
  assert.equal(text(v.$('.finding-summary')), 'The frameless window has no shadow on Linux.');
  assert.equal(text(v.$('.finding-scenario')), 'On Ubuntu the window has no border.');
  assert.equal(text(v.$('.finding-loc')), 'electron/windows.cjs:12');
  await settle(() => (v.$('.finding-loc') as HTMLButtonElement).click());
  assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['electron/windows.cjs:12', '/repo']);
  await settle(() => button(v, 'View in diff')!.click());
  assert.deepEqual(callsTo('store:openFindingsWalk')[0], ['c1', 'r1', 0, 'branch']);
  // a lone dash is no scenario; a finding with no line names its file alone
  await settle(() => rows()[2].click());
  assert.equal(v.$$('.finding-scenario').length, 1);
  await settle(() => rows()[3].click());
  assert.equal(text(v.$$('.finding-loc')[2]), 'src/Mini.tsx');
  // the open rows come back open; closing one forgets it
  await v.unmount();
  const again = await render(card());
  assert.deepEqual(
    again.$$('.finding-row').map((r) => r.getAttribute('aria-expanded')),
    ['true', 'false', 'true', 'true'],
  );
  await settle(() => again.$$('.finding-row')[0].click());
  assert.equal(again.$$('.finding-row')[0].getAttribute('aria-expanded'), 'false');
  await again.unmount();
});

test('Apply fixes asks for the open findings and shows them in the diff; Walk through starts at the first still shown', async () => {
  setStore({ reviewMarks: { c1: { r1: { status: { 0: 'dismissed' }, unanchored: [1] } } } });
  const v = await render(card());
  await settle(() => button(v, 'Apply fixes')!.click());
  assert.deepEqual(callsTo('store:openFindingsWalk')[0], ['c1', 'r1', 1, 'branch']);
  assert.deepEqual(callsTo('store:askFixes')[0], ['c1', 'r1', findings, [1, 2, 3]]);
  await settle(() => button(v, 'Walk through in diff')!.click());
  assert.deepEqual(callsTo('store:openFindingsWalk')[1], ['c1', 'r1', 1, 'branch']);
  // a dismissed row reads so and is dimmed; a finding whose file is not in the diff says so
  assert.equal(text(v.$('.finding.settled .finding-badge')), 'Dismissed');
  // rows open in an earlier test are still open (as they are across mounts)
  const openRow = async (n: number) => {
    const row = v.$$('.finding-row')[n];
    if (row.getAttribute('aria-expanded') !== 'true') await settle(() => row.click());
    return v.$$('.finding')[n];
  };
  assert.ok(!(await openRow(0)).querySelector('.finding-view'), 'a dismissed finding is not walked to');
  assert.equal(text((await openRow(2)).querySelector('.finding-detail .finding-badge')), 'Not in the current diff');
  // a fixed finding has left the diff too: the walk starts past it
  setStore({ runtime: { c1: { turns: [turnWith(item(), { id: 'r2', findings: [{ ...findings[1], outcome: 'fixed' }] })] } } });
  await settle();
  await settle(() => button(v, 'Walk through in diff')!.click());
  assert.deepEqual(callsTo('store:openFindingsWalk')[2], ['c1', 'r1', 2, 'branch']);
  await v.unmount();
});

test('while fixes run the card says so; once every finding is settled it offers Re-run review', async () => {
  const fixing = { status: { 0: 'fixing', 1: 'fixing', 2: 'fixing', 3: 'fixing' }, fixAfter: { turnId: 't1', items: 1 } };
  setStore({
    reviewMarks: { c1: { r1: fixing } },
    runtime: { c1: { turns: [turnWith(item()), { id: 'fix', status: 'inProgress', items: [{ id: 'u', type: 'userMessage' }] }] } },
  });
  const v = await render(card());
  assert.equal(text(v.$('[role="status"]')), '4 fixes in progress');
  assert.ok(button(v, 'Apply fixes')!.disabled);
  assert.equal(button(v, 'Walk through in diff')!.disabled, false);
  assert.deepEqual(new Set(v.$$('.finding-badge').map(text)), new Set(['Fixing…']));
  await settle(() => v.$$('.finding-row')[0].click());
  assert.ok(button(v, 'View in diff'), 'a finding being fixed can still be walked to');
  // the fix turn ends well: all fixed, the review is complete
  setStore({
    runtime: { c1: { turns: [turnWith(item()), { id: 'fix', status: 'completed', items: [{ id: 'u', type: 'userMessage' }] }] } },
  });
  await settle();
  assert.equal(text(v.$('[role="status"]')), 'Review complete');
  assert.deepEqual(
    [...new Set(v.$$('.finding-row .finding-badge').map((b) => `${text(b)}|${b.className}`))],
    ['Fixed|finding-badge success'],
  );
  assert.ok(button(v, 'Walk through in diff')!.disabled);
  assert.ok(!button(v, 'View in diff'), 'a fixed finding is not walked to');
  await settle(() => button(v, 'Re-run review')!.click());
  assert.deepEqual(callsTo('store:rerunReview')[0], ['c1', 'high']);
  // one fix running reads in the singular
  setStore({
    reviewMarks: { c1: { r1: { status: { 0: 'fixing' }, fixAfter: { turnId: 't1', items: 1 } } } },
    runtime: { c1: { turns: [turnWith(item()), { id: 'fix', status: 'inProgress', items: [{ id: 'u', type: 'userMessage' }] }] } },
  });
  await settle();
  assert.equal(text(v.$('[role="status"]')), '1 fix in progress');
  await v.unmount();
});

test("only the chat's latest review acts; a review that finishes while shown opens its findings in the diff", async () => {
  const v = await render(card({ latest: false }));
  assert.ok(!v.$('.findings-action'));
  await settle(() => v.$$('.finding-row')[1].click());
  assert.ok(!button(v, 'View in diff'));
  await v.rerender(card({ chatId: undefined }));
  assert.ok(!v.$('.findings-action'));
  // running, then finished: the walk opens once
  await v.rerender(card({ running: true }));
  assert.equal(callsTo('store:openFindingsWalk').length, 0);
  await v.rerender(card({ running: false }));
  assert.deepEqual(callsTo('store:openFindingsWalk'), [['c1', 'r1', 0, 'branch']]);
  await v.rerender(card({ running: false }));
  assert.equal(callsTo('store:openFindingsWalk').length, 1);
  // nor when every finding is settled; while fixes run it opens again
  setStore({ reviewMarks: { c1: { r1: { status: { 0: 'fixing', 1: 'dismissed', 2: 'dismissed', 3: 'dismissed' } } } } });
  await v.rerender(card({ running: true }));
  await v.rerender(card({ running: false }));
  assert.equal(callsTo('store:openFindingsWalk').length, 2);
  // not when nothing is open to fix
  setStore({ reviewMarks: { c1: { r1: { status: { 0: 'dismissed', 1: 'dismissed', 2: 'dismissed', 3: 'dismissed' } } } } });
  await v.rerender(card({ running: true }));
  await v.rerender(card({ running: false }));
  assert.equal(callsTo('store:openFindingsWalk').length, 2);
  await v.unmount();
});

test('a review that found nothing has no actions; a re-report is one line of outcomes', async () => {
  const v = await render(card({ item: item({ findings: [] }) }));
  assert.equal(text(v.$('.findings-meta')), 'high · No issues found');
  assert.ok(!v.$('.findings-action'));
  assert.ok(!v.$('.findings-list .findings-file'));
  assert.equal(v.$('.findings-card')?.className, 'findings-card empty');
  assert.equal(text(v.$('[role="status"]')), 'Review complete, no issues found');
  await v.rerender(card());
  assert.equal(v.$('.findings-card')?.className, 'findings-card');
  // empty while its review still runs is not "nothing found": findings may yet arrive
  await v.rerender(card({ item: item({ findings: [] }), running: true }));
  assert.equal(text(v.$('.findings-meta')), 'high · 0 findings');
  assert.equal(v.$('.findings-card')?.className, 'findings-card');
  assert.equal(text(v.$('[role="status"]')), '');
  await v.rerender(
    card({
      item: item({
        id: 'r2',
        findings: [
          { ...findings[0], outcome: 'fixed' },
          { ...findings[1], outcome: 'skipped' },
        ],
      }),
    }),
  );
  assert.equal(text(v.$('.findings-outcomes')), 'Code review1 fixed · 1 skipped');
  await v.rerender(card({ item: item({ id: 'r3', findings: [{ ...findings[0], outcome: 'later' }] }) }));
  assert.equal(text(v.$('.findings-outcomes .findings-meta')), 'Outcomes reported');
  await v.unmount();
});

test("Codex's review text is the same list, its intro above, walked in the branch diff for a branch review", async () => {
  const review = [
    'Two problems.',
    '',
    'Full review comments:',
    '',
    '- [P1] add now subtracts — /repo/src/math.ts:4-6',
    '  `add` returns a - b.',
    '- [P2] An odd outcome — /repo/src/b.ts:1-1',
  ].join('\n');
  const codex = { id: 'x1', review, target: { type: 'baseBranch' } };
  setStore({ runtime: { c1: { turns: [turnWith(codex)] } } });
  const v = await render(card({ item: codex }));
  assert.equal(text(v.$('.findings-meta')), '2 findings');
  assert.equal(v.$('.findings-card > [data-stub="Markdown"]')?.dataset.text, 'Two problems.');
  assert.deepEqual(v.$$('.finding-badge').map(text), ['P1', 'P2']);
  await settle(() => button(v, 'Walk through in diff')!.click());
  assert.deepEqual(callsTo('store:openFindingsWalk')[0], ['c1', 'x1', 0, 'branch']);
  // the target the review was started on wins over the item's
  setStore({ reviewTargets: { c1: { type: 'uncommittedChanges' } } });
  await settle();
  await settle(() => button(v, 'Walk through in diff')!.click());
  assert.equal(callsTo('store:openFindingsWalk')[1][3], 'uncommitted');
  // a commit or custom review is walked in the branch, which holds the commits on it
  for (const type of ['commit', 'custom']) {
    setStore({ reviewTargets: { c1: { type } } });
    await settle();
    await settle(() => button(v, 'Walk through in diff')!.click());
    assert.equal(callsTo('store:openFindingsWalk').at(-1)![3], 'branch', type);
  }
  // before the chat's turns hold it: every finding open
  setStore({ runtime: {} });
  await settle();
  assert.equal(v.$$('.finding.settled').length, 0);
  await v.unmount();
});

test('the same review may render in a transcript and a pane with one card in each scope', async () => {
  const shared = { id: 'shared-review', review: 'No findings reported.' };
  const v = await render(
    h(
      'div',
      null,
      h('section', { className: 'test-transcript' }, card({ item: shared })),
      h('aside', { className: 'test-pane' }, card({ item: shared })),
    ),
  );
  assert.equal(v.$$('.review-result').length, 2);
  assert.equal(v.$$('.test-transcript .review-result').length, 1);
  assert.equal(v.$$('.test-pane .review-result').length, 1);
});

test("the footer's sentence badge is not cut to a category badge's 7rem", () => {
  const css = postcss.parse(appCss());
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    css.walkRules((r) => {
      if (r.selectors.includes(selector) && r.parent?.type === 'root') r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  assert.equal(decls('.finding-badge')['max-width'], '7rem', 'a category badge in a row stays capped');
  assert.equal(decls('.finding-foot .finding-badge')['max-width'], '100%');
});

test('the action buttons have every state: Apply fixes ghost with hover/pressed, Walk through an outlined pill, disabled and focus', () => {
  const css = postcss.parse(appCss());
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    css.walkRules((r) => {
      if (r.selectors.includes(selector)) r.walkDecls((d) => void (out[d.prop] = d.value));
    });
    return out;
  };
  const ghost = decls('.btn-pill.ghost.findings-action');
  assert.equal(ghost.background, 'none');
  assert.equal(ghost['border-color'], 'transparent');
  assert.equal(decls('.btn-pill.ghost.findings-action:hover:not(:disabled)').background, 'rgba(var(--ink), 0.05)');
  assert.equal(decls('.btn-pill.ghost.findings-action:active:not(:disabled)').background, 'rgba(var(--ink), 0.09)');
  // Walk through in diff: an outlined pill on the card's own ground, not a filled grey block
  const pill = decls('.btn-pill.findings-action:not(.ghost)');
  assert.equal(pill.background, 'var(--card-bg)');
  assert.equal(pill['border-color'], 'rgba(var(--ink), 0.12)');
  assert.match(pill['box-shadow'], /^0 1px 1px /);
  assert.equal(decls('.btn-pill.findings-action:not(.ghost):active:not(:disabled)')['box-shadow'], 'none');
  assert.equal(decls('.btn-pill.findings-action:disabled').opacity, '0.45');
  assert.match(decls('.btn-pill.findings-action:focus-visible').outline, /var\(--accent\)/);
});
