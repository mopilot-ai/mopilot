// The goal's pill and card above the composer: look, text per harness and state, and controls (editing the
// objective: goalCardEdit.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChatGoal } from '../src/store/types.ts';
import { appCss } from './support/app-css.ts';
import { paletteToken } from './support/palette.ts';
import { window } from './support/dom.ts';
import { act, f, failWith, goalCardSummary, goalPillView, mount, original } from './support/goal-pills.ts';

for (const theme of ['dark', 'light']) {
  test(`${theme}: the goal pill sits alone in the centered row, truncating its text`, async (t) => {
    document.documentElement.setAttribute('data-theme', theme);
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8') + appCss();
    document.head.append(style);
    t.after(() => {
      style.remove();
      document.documentElement.removeAttribute('data-theme');
    });
    const m = await mount(t, {
      ...original,
      status: 'active',
      objective: 'Try to merge all the PRs opened by me to the main properly.',
      timeUsedSeconds: 993,
    });
    const css = (el: Element, property: string) => getComputedStyle(el).getPropertyValue(property);
    const row = m.host.querySelector('.composer-pills')!;
    assert.deepEqual([css(row, 'display'), css(row, 'justify-content'), css(row, 'gap')], ['flex', 'center', '8px']);
    // the goal pill alone: no files-changed pill beside it
    assert.deepEqual(
      [...row.children].map((c) => c.className),
      ['goal-pill'],
    );
    const goal = m.pill();
    assert.deepEqual(
      ['height', 'border-top-left-radius', 'padding-left', 'box-sizing'].map((p) => css(goal, p)),
      ['32px', '24px', '12px', 'border-box'],
    );
    assert.equal(css(goal, 'background-color'), paletteToken(theme, '--surface'));
    assert.deepEqual([css(goal, 'flex-shrink'), css(goal, 'min-width')], ['1', '0']);
    assert.equal(css(m.host.querySelector('.goal-pill-text')!, 'text-overflow'), 'ellipsis');
    assert.equal(m.host.querySelector('.goal-pill-text')?.textContent, '16m 33s');
    assert.ok(m.host.querySelector('.goal-icon'));
    await m.open();
    const card = m.card()!;
    assert.equal(css(card.querySelector('.goal-objective')!, 'overflow'), 'hidden');
    // (the two-line clamp is a -webkit-box property the test DOM does not compute)
    assert.equal(css(card.querySelector('.goal-objective')!, 'overflow-wrap'), 'anywhere');
    // the pencil waits for the pointer on the objective
    assert.equal(css(card.querySelector('.goal-edit')!, 'opacity'), '0');
    for (const button of card.querySelectorAll('.goal-actions button')) {
      assert.ok(button.querySelector('svg'));
      assert.equal(button.textContent, '');
    }
  });
}

test('the pill shows short progress only, per harness and state, never "Goal", "Active" or tokens', () => {
  const claude = (status: ChatGoal['status'], iterations = 3) =>
    ({ ...original, status, claude: { iterations, lastReason: null, limit: 30 } }) as ChatGoal;
  const cases: [ChatGoal, string, string, string][] = [
    [{ ...original, status: 'active', timeUsedSeconds: 720 }, '12m', 'running', 'Goal, running for 12m'],
    [{ ...original, status: 'active', timeUsedSeconds: 0 }, '0s', 'running', 'Goal, running for 0s'],
    [{ ...original, status: 'active', timeUsedSeconds: undefined } as unknown as ChatGoal, '0s', 'running', 'Goal, running for 0s'],
    [claude('active'), '3 turns', 'running', 'Goal, 3 turns'],
    [claude('active', 1), '1 turn', 'running', 'Goal, 1 turn'],
    [{ ...original, status: 'active', claude: undefined }, '3s', 'running', 'Goal, running for 3s'],
    [{ ...original, status: 'paused' }, 'Paused', 'muted', 'Goal, Paused'],
    [{ ...original, status: 'paused', pausedAtQuit: true }, 'Paused', 'muted', 'Goal, Paused'],
    [claude('paused'), 'Paused', 'muted', 'Goal, Paused'],
    [claude('budgetLimited'), 'Round limit reached', 'limit', 'Goal, Round limit reached'],
    [{ ...original, status: 'budgetLimited' }, 'Budget reached', 'muted', 'Goal, Budget reached'],
    [{ ...original, status: 'blocked' }, 'Blocked', 'muted', 'Goal, Blocked'],
    [{ ...original, status: 'usageLimited' }, 'Usage limit reached', 'muted', 'Goal, Usage limit reached'],
    [claude('stopped'), 'Stopped', 'muted', 'Goal, Stopped'],
    [claude('complete'), 'Complete', 'muted', 'Goal, Complete'],
  ];
  for (const [goal, text, tone, label] of cases) {
    assert.deepEqual(goalPillView(goal), { text, tone, label }, JSON.stringify(goal));
    assert.doesNotMatch(text, /Goal|Active|token/);
  }
  // a Claude goal's count reads its own rounds even when the snapshot has none yet
  assert.equal(goalPillView({ ...original, status: 'active', claude: {} as any }).text, '0 turns');
});

test("the card's summary: a Claude goal's rounds or holder; a Codex goal's stop and time, or nothing", () => {
  assert.equal(goalCardSummary({ ...original, status: 'active', timeUsedSeconds: 0 }), null);
  assert.equal(goalCardSummary({ ...original, status: 'active', timeUsedSeconds: 125 }), '2m 5s elapsed');
  assert.equal(goalCardSummary({ ...original, status: 'paused', pausedAtQuit: true }), 'Paused when MoPilot quit · 3s elapsed');
  assert.equal(goalCardSummary({ ...original, status: 'blocked', timeUsedSeconds: 0 }), 'Blocked');
  assert.equal(goalCardSummary({ ...original, status: 'active', claude: { iterations: 4, lastReason: null, limit: 30 } }), '4 / 30 rounds');
  assert.match(
    goalCardSummary({ ...original, status: 'paused', claude: { iterations: 4, lastReason: null, limit: 30 } })!,
    /kept by MoPilot/,
  );
});

test('the pill names the goal for assistive tech, holds the objective as its tooltip and opens the card above itself', async (t) => {
  const m = await mount(t, { ...original, status: 'active', timeUsedSeconds: 720 });
  const pill = m.pill();
  assert.equal(pill.textContent, '12m');
  assert.equal(pill.getAttribute('aria-label'), 'Goal, running for 12m');
  assert.equal(pill.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(pill.title, 'Ship the beta');
  assert.equal(m.card(), null);
  await m.open();
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  // the card's own content stands in for the tooltip while it is open
  assert.equal(pill.title, '');
  assert.equal(m.card()!.getAttribute('role'), 'dialog');
  assert.equal(m.card()!.querySelector('.goal-card-title')?.textContent, 'Goal');
  assert.equal(m.card()!.querySelector('.goal-objective')?.textContent, 'Ship the beta');
  assert.equal(m.card()!.querySelector('.goal-objective')?.getAttribute('title'), 'Ship the beta');
  assert.equal(m.card()!.querySelector('.goal-card-summary')?.textContent, '12m elapsed');
  // the keyboard moves into the card, and Escape gives it back to the pill
  assert.equal(document.activeElement, m.card());
  await m.key('Escape', {}, document.activeElement!);
  assert.equal(m.card(), null);
  assert.equal(document.activeElement, pill);
  await m.open();
  // a second click on the pill closes it, and nothing was asked of the goal
  await act(async () => pill.click());
  assert.equal(m.card(), null);
  assert.deepEqual(f.calls, []);
});

test("the card offers exactly the controls the goal's harness and state allow", async (t) => {
  const claude = (status: ChatGoal['status']) =>
    ({ ...original, status, claude: { iterations: 30, lastReason: null, limit: 30 } }) as ChatGoal;
  const cases: [ChatGoal, string[], boolean][] = [
    [{ ...original, status: 'active' }, ['Pause', 'Clear'], true],
    [{ ...original, status: 'paused' }, ['Resume', 'Clear'], true],
    [{ ...original, status: 'blocked' }, ['Resume', 'Clear'], true],
    [claude('active'), ['Pause', 'Clear'], false],
    [claude('paused'), ['Resume', 'Clear'], false],
    [claude('budgetLimited'), ['10 more rounds', 'Clear'], false],
    [claude('stopped'), ['Resume', 'Clear'], false],
    [claude('complete'), ['Clear'], false],
  ];
  for (const [goal, controls, editable] of cases) {
    const m = await mount(t, goal);
    await m.open();
    assert.deepEqual(m.controls(), controls, JSON.stringify(goal));
    assert.equal(!!m.button('Edit goal'), editable, JSON.stringify(goal));
  }
});

test('the token budget line is in the card only when the goal has a budget, never on the pill', async (t) => {
  const m = await mount(t, { ...original, status: 'active' });
  assert.doesNotMatch(m.pill().textContent!, /token/);
  await m.open();
  assert.equal(m.card()!.querySelector('.goal-budget')?.textContent, '200k token budget (soft, checked between turns) · 2k used');
  const none = await mount(t, { ...original, tokenBudget: null });
  await none.open();
  assert.equal(none.card()!.querySelector('.goal-budget'), null);
});

test("a Claude goal's last check follows its summary", async (t) => {
  const m = await mount(t, { ...original, status: 'active', claude: { iterations: 2, lastReason: 'tests still fail', limit: null } });
  await m.open();
  assert.deepEqual(
    [...m.card()!.querySelectorAll('.goal-card-summary')].map((e) => e.textContent),
    ['2 rounds', 'Last check: tests still fail'],
  );
});

test('an outside click closes the card', async (t) => {
  const m = await mount(t);
  await m.open();
  await act(async () => {
    document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any);
  });
  assert.equal(m.card(), null);
});

test('the row shows the goal pill when one applies, and nothing otherwise', async (t) => {
  const goalOnly = await mount(t);
  assert.ok(goalOnly.pill());
  const hidden = await mount(t, { ...original }, { showGoal: false });
  assert.equal(hidden.host.innerHTML, '');
  const complete = await mount(t, { ...original, status: 'complete' });
  assert.equal(complete.host.innerHTML, '');
  const none = await mount(t, null);
  assert.equal(none.host.innerHTML, '');
});

test('the card says why Pause, Resume, 10 more rounds or Clear failed', async (t) => {
  const m = await mount(t, { ...original, status: 'active' });
  await m.open();
  failWith(new Error('app-server is down'));
  try {
    await m.click('Pause');
    await m.click('Clear');
  } finally {
    failWith(null);
  }
  assert.deepEqual(f.calls, [
    ['pause', 'chat-1'],
    ['clear', 'chat-1'],
  ]);
  assert.deepEqual(f.notices, ["Couldn't pause the goal: app-server is down", "Couldn't clear the goal: app-server is down"]);
  const paused = await mount(t, { ...original, status: 'paused' });
  await paused.open();
  failWith(new Error('x'));
  try {
    await paused.click('Resume');
  } finally {
    failWith(null);
  }
  assert.deepEqual(f.notices, ["Couldn't resume the goal: x"]);
  const limit = await mount(t, { ...original, status: 'budgetLimited', claude: { iterations: 20, lastReason: null, limit: 20 } } as any);
  await limit.open();
  failWith(new Error('y'));
  try {
    await limit.click('10 more rounds');
  } finally {
    failWith(null);
  }
  assert.deepEqual(f.notices, ["Couldn't add rounds to the goal: y"]);
});
