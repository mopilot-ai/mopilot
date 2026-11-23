// A chat's review as its turns hold it: the latest review card, its re-reports and fix turn, each finding's status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixAnchorOf, latestReviewId, reviewState } from '../src/lib/reviewState.ts';
import { applyFixesRequest } from '../shared/reviewFindings.mjs';

const a = { file: 'a.ts', line: 1, summary: 'one' };
const b = { file: 'b.ts', line: 2, summary: 'two' };
const review = (id: string, findings: object[], level: string | null = 'high') => ({
  id,
  type: 'exitedReviewMode',
  review: '',
  level,
  findings,
});
let n = 0;
const turn = (status: string, ...items: object[]) => ({ id: `t${++n}`, status, items: items as any[] });
const asked = { id: 'u', type: 'userMessage' };

test("the latest review card is the chat's last review that is not a re-report", () => {
  assert.equal(latestReviewId(undefined), null);
  assert.equal(latestReviewId([turn('completed', { id: 'm', type: 'agentMessage' })]), null);
  const turns = [
    turn('completed', review('r1', [a])),
    turn('completed', { id: 'm', type: 'agentMessage' }, review('r2', [a, b])),
    turn('completed', review('r3', [{ ...a, outcome: 'fixed' }])),
    // Codex text in its format counts; other review text does not
    turn('completed', { id: 'x', type: 'exitedReviewMode', review: 'LGTM' }),
  ];
  assert.equal(latestReviewId(turns), 'r2');
  assert.equal(
    latestReviewId([
      ...turns,
      turn('completed', { id: 'c', type: 'exitedReviewMode', review: 'Review comment:\n\n- [P1] Bug — /r/a.ts:1-2' }),
    ]),
    'c',
  );
});

test("a review's state: its findings, level and statuses from later re-reports and its fix turn", () => {
  assert.equal(reviewState(undefined, 'r1'), null);
  const reviewed = turn('completed', review('r1', [a, b]));
  assert.deepEqual(reviewState([reviewed], 'r1'), { level: 'high', intro: '', findings: [a, b], statuses: ['open', 'open'] });
  // a re-report before the review, and one in the same turn after it
  const early = turn('completed', review('r0', [{ ...a, outcome: 'fixed' }]));
  const same = turn('completed', review('r1', [a, b]), review('r1b', [{ ...b, outcome: 'fixed' }]));
  assert.deepEqual(reviewState([early, same], 'r1')?.statuses, ['open', 'addressed']);
  // the fix asked after the review's turn: waiting for its message, running, ended well, stopped, or re-reported
  const marks = { status: { 0: 'fixing' as const }, fixAfter: fixAnchorOf([reviewed]) };
  assert.deepEqual(marks.fixAfter, { turnId: reviewed.id, items: 1 });
  assert.deepEqual(reviewState([reviewed], 'r1', marks)?.statuses, ['fixing', 'open']);
  assert.deepEqual(reviewState([reviewed, turn('inProgress', asked)], 'r1', marks)?.statuses, ['fixing', 'open']);
  assert.deepEqual(reviewState([reviewed, turn('completed', asked)], 'r1', marks)?.statuses, ['addressed', 'open']);
  assert.deepEqual(reviewState([reviewed, turn('interrupted', asked)], 'r1', marks)?.statuses, ['open', 'open']);
  assert.deepEqual(reviewState([reviewed, turn('completed', asked, review('r2', [{ ...a, outcome: 'skipped' }]))], 'r1', marks)?.statuses, [
    'open',
    'open',
  ]);
  // older turns loaded in front leave the anchor where it was
  assert.deepEqual(reviewState([turn('completed', asked), reviewed, turn('inProgress', asked)], 'r1', marks)?.statuses, ['fixing', 'open']);
  // a request steered into the running turn: that turn, from the request on, is the fix
  const running = turn('inProgress', review('r1', [a, b]));
  const steered = { status: { 0: 'fixing' as const }, fixAfter: fixAnchorOf([running]) };
  assert.deepEqual(reviewState([running], 'r1', steered)?.statuses, ['fixing', 'open']);
  const done = { ...running, status: 'completed', items: [...running.items, asked] };
  assert.deepEqual(reviewState([done], 'r1', steered)?.statuses, ['addressed', 'open']);
  // in the turn it was asked in: a re-report before the ask is not the fix's, one after it is
  const busy = turn('inProgress', review('r1', [a, b]), review('early', [{ ...a, outcome: 'fixed' }]));
  const mid = { status: { 0: 'fixing' as const }, fixAfter: fixAnchorOf([busy]) };
  assert.deepEqual(reviewState([busy], 'r1', mid)?.statuses, ['fixing', 'open']);
  const later = { ...busy, items: [...busy.items, asked, review('late', [{ ...a, outcome: 'fixed' }])] };
  assert.deepEqual(reviewState([later], 'r1', mid)?.statuses, ['addressed', 'open']);
  // the part of the chat it was asked in was rewound: the fix is over, and the finding open again
  assert.deepEqual(reviewState([reviewed], 'r1', { status: { 0: 'fixing' }, fixAfter: { turnId: 'gone', items: 0 } })?.statuses, [
    'open',
    'open',
  ]);
  // rewound, with a re-report: it counts as from before the fix, so it settles only what is not being fixed
  assert.deepEqual(
    reviewState(
      [
        reviewed,
        turn(
          'completed',
          review('r2', [
            { ...a, outcome: 'fixed' },
            { ...b, outcome: 'fixed' },
          ]),
        ),
      ],
      'r1',
      {
        status: { 0: 'fixing' },
        fixAfter: { turnId: 'gone', items: 0 },
      },
    )?.statuses,
    ['open', 'addressed'],
  );
  // asked before any turn: every re-report counts as after it
  assert.deepEqual(
    reviewState([reviewed, turn('completed', asked, review('r2', [{ ...a, outcome: 'fixed' }]))], 'r1', {
      status: { 0: 'fixing' },
      fixAfter: { turnId: null, items: 0 },
    })?.statuses,
    ['addressed', 'open'],
  );
  // a newer review's outcomes are not this one's
  assert.deepEqual(
    reviewState([reviewed, turn('completed', review('r9', [b])), turn('completed', review('r10', [{ ...b, outcome: 'fixed' }]))], 'r1')
      ?.statuses,
    ['open', 'open'],
  );
  // a Codex review: its parsed findings and no level
  const codex = turn('completed', {
    id: 'c',
    type: 'exitedReviewMode',
    review: 'Two bugs.\n\nReview comment:\n\n- [P1] Bug — /r/a.ts:1-2',
  });
  assert.deepEqual(reviewState([codex], 'c'), {
    level: null,
    intro: 'Two bugs.',
    findings: [{ file: '/r/a.ts', line: 1, endLine: 2, shortSummary: 'Bug', summary: 'Bug', category: 'P1' }],
    statuses: ['open'],
  });
});

/** A message in a turn: its text as the harness keeps it. */
const said = (id: string, text: string) => ({
  id,
  type: 'userMessage',
  content: [
    { type: 'text', text },
    { type: 'image', url: 'x' },
  ],
});
const ask = (id: string, findings: object[], reportTool = false) => said(id, applyFixesRequest(findings as any, { reportTool }));

test('a fix request in the turns, whoever sent it (main on its own, another window, before a restart), shows its findings fixing, then settled', () => {
  const reviewed = turn('completed', review('r1', [a, b]));
  // main sent it after the review's turn: no marks in this window
  assert.deepEqual(reviewState([reviewed, turn('inProgress', ask('f', [a, b]))], 'r1')?.statuses, ['fixing', 'fixing']);
  // Codex and basic harnesses: the fix turn's end settles them; a stopped one opens them again
  assert.deepEqual(reviewState([reviewed, turn('completed', ask('f', [a, b]))], 'r1')?.statuses, ['addressed', 'addressed']);
  assert.deepEqual(reviewState([reviewed, turn('interrupted', ask('f', [a, b]))], 'r1')?.statuses, ['open', 'open']);
  // Claude Code: its re-report says which; skipped opens one again
  const reported = turn(
    'completed',
    ask('f', [a, b], true),
    review('o', [
      { ...a, outcome: 'fixed' },
      { ...b, outcome: 'skipped' },
    ]),
  );
  assert.deepEqual(reviewState([reviewed, reported], 'r1')?.statuses, ['addressed', 'open']);
  // a message in other words, one before the review, and the review's own turn's prompt are no fix
  assert.deepEqual(reviewState([turn('completed', ask('early', [a])), reviewed, turn('completed', said('m', 'thanks'))], 'r1')?.statuses, [
    'open',
    'open',
  ]);
  // the same review's turn, after the review: steered into it
  const steeredIn = turn('completed', review('r1', [a, b]), ask('s', [b]));
  assert.deepEqual(reviewState([steeredIn], 'r1')?.statuses, ['open', 'addressed']);
});

test('several fix requests settle one after another; a dismissed finding stays dismissed', () => {
  const reviewed = turn('completed', review('r1', [a, b]));
  const first = turn('completed', ask('f1', [a]), review('o1', [{ ...a, outcome: 'skipped' }]));
  // the second asks again for what the first skipped
  assert.deepEqual(reviewState([reviewed, first], 'r1')?.statuses, ['open', 'open']);
  assert.deepEqual(reviewState([reviewed, first, turn('inProgress', ask('f2', [a]))], 'r1')?.statuses, ['fixing', 'open']);
  assert.deepEqual(reviewState([reviewed, first, turn('completed', ask('f2', [a]))], 'r1')?.statuses, ['addressed', 'open']);
  // the first one's fix stays settled while a later one fixes the other
  const done = turn('completed', ask('f1', [a]));
  assert.deepEqual(reviewState([reviewed, done, turn('inProgress', ask('f2', [b]))], 'r1')?.statuses, ['addressed', 'fixing']);
  assert.deepEqual(reviewState([reviewed, turn('inProgress', ask('f', [a, b]))], 'r1', { status: { 1: 'dismissed' } })?.statuses, [
    'fixing',
    'dismissed',
  ]);
});

test("a fix asked in this window waits for its message; once the message is there, it's the one that counts", () => {
  const reviewed = turn('completed', review('r1', [a, b]));
  const marks = { status: { 1: 'fixing' as const }, fixAfter: fixAnchorOf([reviewed]) };
  // not there yet: what the window marked
  assert.deepEqual(reviewState([reviewed], 'r1', marks)?.statuses, ['open', 'fixing']);
  // there: the message's own findings and turn
  assert.deepEqual(reviewState([reviewed, turn('completed', ask('f', [b]))], 'r1', marks)?.statuses, ['open', 'addressed']);
  // an earlier request (main's, before the click) settled first; the click's still waits
  const auto = turn('completed', ask('auto', [a]));
  const later = { status: { 1: 'fixing' as const }, fixAfter: fixAnchorOf([reviewed, auto]) };
  assert.deepEqual(reviewState([reviewed, auto], 'r1', later)?.statuses, ['addressed', 'fixing']);
  // asked before any turn: any request counts as its message
  const before = { status: { 1: 'fixing' as const }, fixAfter: { turnId: null, items: 0 } };
  assert.deepEqual(reviewState([reviewed, turn('inProgress', ask('f', [b]))], 'r1', before)?.statuses, ['open', 'fixing']);
  // asked in a part of the chat that was rewound: its message never comes, and the finding is open again
  const gone = { status: { 1: 'fixing' as const }, fixAfter: { turnId: 'gone', items: 0 } };
  assert.deepEqual(reviewState([reviewed, turn('completed', ask('f', [a]))], 'r1', gone)?.statuses, ['addressed', 'open']);
  // a request whose send failed leaves nothing fixing
  assert.deepEqual(reviewState([reviewed], 'r1', { status: {}, fixAfter: fixAnchorOf([reviewed]) })?.statuses, ['open', 'open']);
});

test("a newer review's fix requests are its own, even for the same finding; the turns are read again only when they change", () => {
  const first = turn('completed', review('r1', [a, b]));
  const second = turn('completed', review('r2', [a]));
  const fixed = turn('completed', ask('f', [a]));
  assert.deepEqual(reviewState([first, second, fixed], 'r1')?.statuses, ['open', 'open']);
  assert.deepEqual(reviewState([first, second, fixed], 'r2')?.statuses, ['addressed']);
  // in the review's own turn, a request before a newer review there is still this one's
  const both = turn('completed', review('r1', [a, b]), ask('f', [b]), review('r3', [b]));
  assert.deepEqual(reviewState([both], 'r1')?.statuses, ['open', 'addressed']);
  // the same turn objects read twice give the same answer (cached per turn), and a replaced turn is read again
  assert.deepEqual(reviewState([first, fixed], 'r1')?.statuses, ['addressed', 'open']);
  assert.deepEqual(reviewState([first, { ...fixed, status: 'interrupted' }], 'r1')?.statuses, ['open', 'open']);
});

test('a fix request reads only text parts, even an empty one; turns a history keeps without ids still settle it', () => {
  const reviewed = turn('completed', review('r1', [a, b]));
  const request = applyFixesRequest([a] as any, { reportTool: false });
  const parts = { id: 'p', type: 'userMessage', content: [{ type: 'text' }, { type: 'text', text: request }, null] };
  assert.deepEqual(reviewState([reviewed, turn('inProgress', parts)], 'r1')?.statuses, ['fixing', 'open']);
  // a history read with no turn ids: the request's turn is found from the start
  const bare = (status: string, ...items: object[]) => ({ status, items: items as any[] });
  assert.deepEqual(reviewState([bare('completed', review('r1', [a, b])), bare('completed', ask('f', [a]))], 'r1')?.statuses, [
    'addressed',
    'open',
  ]);
});
