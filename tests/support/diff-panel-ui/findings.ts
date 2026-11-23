// Diff-panel UI unit cases for findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SHA, store, DIFF, git, ok, act, scrolled, mount, mode, one, menuItem, label, settle } from './fixture.ts';

export function registerFindings() {
  test("a review's findings show under their lines in the review's chat, the one in focus scrolled to and outlined", async () => {
    const findings = [
      {
        file: 'src/a.ts',
        line: 2,
        endLine: 4,
        summary: 'new is wrong',
        failureScenario: 'it breaks',
        category: 'correctness',
        verdict: 'CONFIRMED',
      },
      { file: 'missing.ts', line: 1, summary: 'not changed here' },
      { file: '/repo/new.py', line: null, summary: 'no line' },
      { file: 'src/a.ts', line: 9, summary: 'past the hunk' },
    ];
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', level: 'high', findings }] }];
    // settled: the scope stays Uncommitted though missing.ts is in no diff (moving to Branch is tested below)
    const walk = (current: number, chatId = 't1') => ({ scope: 'uncommitted', walk: { chatId, reviewId: 'r1', current, settled: true } });
    store.set({ reviewMarks: { t1: { r1: { status: { 2: 'fixing' } } } } });
    const r = await mount(walk(0), 't1', { t1: { turns } });
    await settle(act, 60);
    const cards = () => [...r.host.querySelectorAll<HTMLElement>('[data-finding]')];
    const inFile = (p: string) =>
      [...r.host.querySelectorAll(`[data-inline="${p}"] [data-finding]`)].map((n) => n.getAttribute('data-finding'));
    assert.deepEqual(inFile('src/a.ts'), ['0', '3']);
    assert.deepEqual(inFile('new.py'), ['2']);
    assert.deepEqual(
      [...r.host.querySelectorAll('[data-inline="src/a.ts"] [data-note-line]')].map((n) => n.getAttribute('data-note-line')),
      ['2', '9'],
    );
    assert.equal(r.host.querySelector('[data-inline="new.py"] [data-note-line]')!.getAttribute('data-note-line'), '1');
    // the finding not in this diff is reported for the transcript's row, once
    assert.deepEqual(
      store.calls.filter((c) => c[0] === 'setUnanchored'),
      [['setUnanchored', 't1', 'r1', [1]]],
    );
    assert.deepEqual(scrolled, ['finding 0']);
    // the card: who found it, where, its badges and text; the one in focus is outlined
    const first = cards()[0];
    assert.equal(first.querySelector('.finding-annotation')!.className, 'finding-annotation current');
    assert.equal(first.querySelector('.finding-annotation')!.getAttribute('aria-current'), 'true');
    assert.ok(first.querySelector('svg.harness-icon.claude'));
    assert.equal(first.querySelector('.finding-annotation-author')!.textContent, 'Claude');
    assert.equal(first.querySelector('.finding-annotation-lines')!.textContent, 'Lines 2\u20134');
    assert.deepEqual(
      [...first.querySelectorAll('.finding-annotation-badges .finding-badge')].map((b) => b.textContent),
      ['Confirmed', 'Correctness'],
    );
    assert.equal(first.querySelector('.finding-annotation-summary')!.textContent, 'new is wrong');
    assert.equal(first.querySelector('.finding-annotation-scenario')!.textContent, 'it breaks');
    // one being fixed has no Next or Fix this one; one with no line names none
    const fixing = cards().find((c) => c.dataset.finding === '2')!;
    assert.equal(fixing.querySelector('.finding-badge')!.textContent, 'Fixing\u2026');
    assert.ok(!fixing.querySelector('[title="Next finding"]'));
    assert.ok(!fixing.querySelector('.finding-annotation-foot'));
    assert.ok(!fixing.querySelector('.finding-annotation-lines'));
    const last = cards().find((c) => c.dataset.finding === '3')!;
    assert.equal(last.querySelector('.finding-annotation-lines')!.textContent, 'Line 9');
    assert.equal(last.querySelector('.finding-annotation-badges')!.children.length, 0);
    // Next goes on (to one not in the diff too), Fix this one asks for that finding alone, Dismiss moves the focus on
    await act(async () => (first.querySelector('[aria-label="Next finding after the one on line 2"]') as HTMLElement).click());
    await act(async () => (first.querySelector('.finding-annotation-foot button') as HTMLElement).click());
    await act(async () => (first.querySelector('[aria-label="Dismiss finding"]') as HTMLElement).click());
    await act(async () => (last.querySelector('[aria-label="Next finding after the one on line 9"]') as HTMLElement).click());
    await act(async () => (last.querySelector('[aria-label="Dismiss finding"]') as HTMLElement).click());
    assert.deepEqual(
      store.calls.filter((c) => ['focusFinding', 'askFixes', 'dismissFinding'].includes(String(c[0]))),
      [
        ['focusFinding', 1],
        ['askFixes', 't1', 'r1', findings, [0]],
        ['focusFinding', 1],
        ['dismissFinding', 't1', 'r1', 0],
        ['focusFinding', 0],
        ['dismissFinding', 't1', 'r1', 3],
      ],
    );
    await r.unmount();
  });

  test("the finding in focus unfolds its file; another chat's walk, or none left, shows nothing", async () => {
    const findings = [
      { file: 'src/a.ts', line: 2, summary: 'one' },
      { file: 'gone.md', line: 1, summary: 'two' },
    ];
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', findings }] }];
    store.set({ reviewMarks: {} });
    const r = await mount({ scope: 'uncommitted' }, 't1', { t1: { turns } });
    await act(async () => one(r.host, '.cp-file[data-path="src/a.ts"] .cp-file-head').click());
    assert.ok(!r.host.querySelector('[data-inline="src/a.ts"]'));
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } } }));
    await settle(act, 60);
    assert.ok(r.host.querySelector('[data-inline="src/a.ts"] [data-finding="0"]'), 'its file opened');
    // the same finding opened again scrolls to it again
    const before = scrolled.filter((x) => x === 'finding 0').length;
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } } }));
    await settle(act, 60);
    assert.equal(scrolled.filter((x) => x === 'finding 0').length, before + 1);
    // a single finding left has no Next; a basic harness has no mark
    store.exports.__basic = 'kimi';
    store.set({ reviewMarks: { t1: { r1: { status: { 1: 'dismissed' } } } } });
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 1 } } }));
    await settle(act, 60);
    assert.ok(!r.host.querySelector('[title="Next finding"]'));
    assert.ok(!r.host.querySelector('.finding-annotation svg.harness-icon'));
    assert.equal(
      r.host.querySelector('.finding-annotation-author')!.textContent,
      'Claude Code',
      "a basic harness by the chat's harness name",
    );
    assert.equal(
      r.host.querySelector('.finding-annotation')!.className,
      'finding-annotation current',
      'a dismissed focus falls to the first shown',
    );
    store.exports.__basic = null;
    // in split view too
    await act(async () => mode(r.host, 'Split').click());
    assert.ok(r.host.querySelector('[data-split="src/a.ts"] [data-finding="0"]'));
    // every finding dismissed, another chat's walk, a review no longer in the chat
    store.set({ reviewMarks: { t1: { r1: { status: { 0: 'dismissed', 1: 'dismissed' } } } } });
    await settle(act);
    assert.equal(r.host.querySelectorAll('[data-finding]').length, 0);
    store.set({ reviewMarks: {} });
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't2', reviewId: 'r1', current: 0 } } }));
    assert.equal(r.host.querySelectorAll('[data-finding]').length, 0);
    await act(async () => store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'gone', current: 0 } } }));
    assert.equal(r.host.querySelectorAll('[data-finding]').length, 0);
    await r.unmount();
  });

  test('a finding reported fixed leaves the diff; the open one stays, in focus', async () => {
    const findings = [
      { file: 'src/a.ts', line: 2, summary: 'one' },
      { file: 'src/a.ts', line: 9, summary: 'two' },
    ];
    const fixed = { id: 'r2', type: 'exitedReviewMode', review: '', findings: [{ ...findings[0], outcome: 'fixed' }] };
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', findings }, fixed] }];
    store.set({ reviewMarks: {} });
    const r = await mount({ scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0, settled: true } }, 't1', {
      t1: { turns },
    });
    await settle(act, 60);
    assert.deepEqual(
      [...r.host.querySelectorAll('[data-finding]')].map((n) => n.getAttribute('data-finding')),
      ['1'],
    );
    assert.equal(r.host.querySelector('.finding-annotation')!.className, 'finding-annotation current');
    await r.unmount();
  });

  test("a walk whose scope lacks a finding's file (its fixes were committed) moves to Branch once, then keeps the user's pick", async () => {
    const committed = ['diff --git a/docs/x.md b/docs/x.md', '--- a/docs/x.md', '+++ b/docs/x.md', '@@ -1 +1 @@', '-a', '+b'].join('\n');
    git.run = (args) => (args[0] === 'merge-base' ? ok(BASE_SHA) : args[0] === 'diff' ? ok(`${DIFF}\n${committed}`) : ok());
    const findings = [{ file: 'docs/x.md', line: 1, summary: 'committed' }];
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', findings }] }];
    const r = await mount({ scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } }, 't1', { t1: { turns } });
    await settle(act, 60);
    assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Branch'), true);
    assert.ok(r.host.querySelector('[data-inline="docs/x.md"] [data-finding="0"]'), 'the finding is under its line');
    assert.deepEqual(store.calls.filter((c) => c[0] === 'setUnanchored').at(-1), ['setUnanchored', 't1', 'r1', []]);
    // the user picks Uncommitted: the walk stays there, the finding reads as not in this diff
    await act(async () => label(r.host, 'Changes options').click());
    await act(async () => menuItem(r.host, 'Show uncommitted changes').click());
    await settle(act, 60);
    assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Uncommitted'), true);
    assert.equal(store.calls.filter((c) => c[0] === 'widenFindingsWalk').length, 1);
    assert.deepEqual(store.calls.filter((c) => c[0] === 'setUnanchored').at(-1), ['setUnanchored', 't1', 'r1', [0]]);
    await r.unmount();
  });

  test('a walk moves only from the scope it asked for, never from Branch, nor from the last turn when last turn only is on', async () => {
    const findings = [
      { file: 'src/a.ts', line: 2, summary: 'here' },
      { file: 'elsewhere.ts', line: 1, summary: 'in no diff' },
    ];
    const turns = [{ id: 't', status: 'completed', items: [{ id: 'r1', type: 'exitedReviewMode', review: '', findings }] }];
    // the pane still shows the last turn (no changes) when the walk asks for Uncommitted, which holds src/a.ts
    const r = await mount({ scope: 'turn' }, 't1', { t1: { turns } });
    await act(async () =>
      store.set({ diffPanel: { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } }, reviewMarks: {} }),
    );
    await settle(act, 60);
    assert.ok(r.host.querySelector('[data-inline="src/a.ts"] [data-finding="0"]'));
    // elsewhere.ts is in neither diff: Uncommitted moves to Branch once, and Branch stays
    assert.equal(one(r.host, '.cp-scope').textContent?.startsWith('Branch'), true);
    assert.equal(store.calls.filter((c) => c[0] === 'widenFindingsWalk').length, 1);
    await r.unmount();
    store.calls.length = 0;
    const b = await mount({ scope: 'branch', walk: { chatId: 't1', reviewId: 'r1', current: 0 } }, 't1', { t1: { turns } });
    await settle(act, 60);
    assert.equal(store.calls.filter((c) => c[0] === 'widenFindingsWalk').length, 0);
    await b.unmount();
    // "last turn only" keeps the pane on the last turn: the walk's scope is not the one shown, so it does not move
    store.calls.length = 0;
    const u = await mount(
      { scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } },
      't1',
      { t1: { turns } },
      {
        changesLastTurnOnly: true,
      },
    );
    await settle(act, 60);
    assert.equal(one(u.host, '.cp-scope').textContent?.startsWith('Last Turn'), true);
    assert.equal(store.calls.filter((c) => c[0] === 'widenFindingsWalk').length, 0);
    await u.unmount();
  });

  test('findings wait for the diff before saying which files are not in it', async () => {
    let release!: () => void;
    const loaded = new Promise<void>((done) => (release = done));
    git.diff = async () => (await loaded, DIFF);
    const turns = [
      {
        id: 't',
        status: 'completed',
        items: [{ id: 'r1', type: 'exitedReviewMode', review: '', findings: [{ file: 'x.ts', line: 1, summary: 's' }] }],
      },
    ];
    const r = await mount({ scope: 'uncommitted', walk: { chatId: 't1', reviewId: 'r1', current: 0 } }, 't1', { t1: { turns } });
    assert.equal(store.calls.filter((c) => c[0] === 'setUnanchored').length, 0);
    release();
    await settle(act, 60);
    assert.deepEqual(store.calls.filter((c) => c[0] === 'setUnanchored').at(-1), ['setUnanchored', 't1', 'r1', [0]]);
    await r.unmount();
  });
}
