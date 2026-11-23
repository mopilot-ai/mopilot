// bench/lib/mgb seed.mjs and schema.mjs (#1381): seeded data and the task schema's static checks, cells and vendor
// support, on the toy task in tests/support/mgb-toy-task.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toy } from './support/mgb-toy-task.ts';

const { distinct, dayOffset, fmtMoney, hash32, nextMonday, parseMoney, people, rng, taskRng } = await import('../bench/lib/mgb/seed.mjs');
const { cardRange, cellId, cellsOf, columnsOf, validateTask, vendorSupport, VENDOR_SURFACES } = await import('../bench/lib/mgb/schema.mjs');

// ---- seed.mjs

test('hash32 and rng: deterministic per seed, different across seeds, with bounded helpers', () => {
  assert.equal(hash32('abc'), hash32('abc'));
  assert.notEqual(hash32('abc'), hash32('abd'));
  const a = rng('s');
  const b = rng('s');
  const seq = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(
    seq,
    Array.from({ length: 5 }, () => b.next()),
  );
  assert.notDeepEqual(
    seq,
    Array.from({ length: 5 }, () => rng('t').next()),
  );
  for (const x of seq) assert.ok(x >= 0 && x < 1);
  const r = rng('bounds');
  for (let i = 0; i < 200; i++) {
    const n = r.int(3, 5);
    assert.ok(n >= 3 && n <= 5 && Number.isInteger(n));
  }
  assert.equal(r.seed, 'bounds');
  assert.throws(() => r.pick([]), /empty/);
  assert.throws(() => r.sample([1], 2), /sample 2 from 1/);
  const list = [1, 2, 3, 4, 5, 6];
  assert.deepEqual([...r.shuffle(list)].sort(), list);
  assert.deepEqual(list, [1, 2, 3, 4, 5, 6], 'shuffle leaves its input alone');
  const s = r.sample(list, 3);
  assert.equal(new Set(s).size, 3);
  assert.equal(typeof r.chance(0.5), 'boolean');
  assert.equal(r.chance(0), false);
  assert.equal(r.chance(1), true);
  const c = r.cents(100, 200);
  assert.ok(c >= 100 && c <= 200);
  assert.match(r.token('PO'), /^PO-[A-HJKMNP-Z2-9]{6}$/);
  assert.match(r.token('X', 3), /^X-[A-HJKMNP-Z2-9]{3}$/);
  assert.match(r.canary(), /^CNY-[A-HJKMNP-Z2-9]{8}$/);
  const p = r.person();
  assert.equal(p.name, `${p.first} ${p.last}`);
  assert.match(r.company(), /^\w+ \w+$/);
  assert.match(r.product(), /^\w+ [\w -]+$/);
  assert.ok(r.city().length > 2);
  // a fork is its own deterministic stream: drawing from the parent does not move it
  const f1 = rng('p').fork('x').next();
  const parent = rng('p');
  parent.next();
  assert.equal(parent.fork('x').next(), f1);
  assert.notEqual(rng('p').fork('y').next(), f1);
  assert.equal(taskRng('run', 'f1-a').next(), rng('run::f1-a').next());
});

test('people and distinct give unique values, and refuse impossible counts', () => {
  const ps = people(rng('crowd'), 120, 'Example.TEST');
  assert.equal(new Set(ps.map((p: any) => p.name)).size, 120);
  for (const p of ps) assert.equal(p.email, `${p.first}.${p.last}@example.test`.toLowerCase());
  assert.throws(() => people(rng('x'), 10_000, 'x.test'), /too many people/);
  assert.equal(distinct(rng('d').company, 5).length, 5);
  assert.throws(() => distinct(() => 'same', 2, 10), /only 1 distinct values of 2/);
});

test('fmtMoney and parseMoney round-trip the amounts agents type', () => {
  assert.equal(fmtMoney(123450), '$1,234.50');
  assert.equal(fmtMoney(5), '$0.05');
  assert.equal(fmtMoney(-1200), '-$12.00');
  assert.equal(fmtMoney(0), '$0.00');
  assert.equal(parseMoney('$1,234.50'), 123450);
  assert.equal(parseMoney('1234.5'), 123450);
  assert.equal(parseMoney('USD 80'), 8000);
  assert.equal(parseMoney('80 usd'), 8000);
  assert.equal(parseMoney('€5'), 500);
  assert.equal(parseMoney('-$12'), -1200);
  assert.equal(parseMoney('(12.00)'), -1200);
  assert.equal(parseMoney('(-5)'), null, 'a doubled sign is ambiguous');
  assert.equal(parseMoney(12.5), 1250);
  assert.equal(parseMoney(Number.NaN), null);
  assert.equal(parseMoney('1.234,50'), null);
  assert.equal(parseMoney('12,34'), null);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney({}), null);
});

test('dayOffset and nextMonday are relative to the run date', () => {
  assert.equal(dayOffset('2026-10-30', 3), '2026-11-02');
  assert.equal(dayOffset('2026-03-01', -1), '2026-02-28');
  assert.throws(() => dayOffset('10/30/2026', 1), /YYYY-MM-DD/);
  assert.equal(nextMonday('2026-10-18'), '2026-10-19', 'Sunday → the next day');
  assert.equal(nextMonday('2026-10-19'), '2026-10-26', 'Monday → a week later');
  assert.equal(nextMonday('2026-10-21'), '2026-10-26', 'Wednesday');
});

// ---- schema.mjs

test('validateTask accepts a long-horizon task with a canary', () => {
  assert.deepEqual(validateTask(toy()), []);
  assert.deepEqual(
    validateTask(
      toy({
        columns: ['claude'],
        cards: 1,
        limit: { afterRequests: 4 },
        escape: { budgetMs: 2000, after: { app: 'mail', event: 'sent' } },
        mode: 'ask',
        answers: ['read-only', 'allow', 'deny'],
        crash: { path: '/orders' },
        peers: [{ name: 'Warehouse desk', prompt: () => 'You are the warehouse desk.' }],
        switchBefore: 1,
        vendors: { 'desk-chatgpt': 'no' },
        macApps: ['Notes'],
      }),
    ),
    [],
  );
  assert.deepEqual(validateTask(toy({ forbidden: undefined, unsafe: undefined })), []);
});

test('validateTask names every problem of a malformed task', () => {
  assert.deepEqual(validateTask(null), ['(no id): not a task object']);
  const cases: [Record<string, any>, RegExp][] = [
    [{ id: 'F1 bad' }, /id must look like/],
    [{ id: 'f2-wrong-family' }, /not in family F1/],
    [{ family: 'F9', id: 'f1-x' }, /unknown family F9/],
    [{ title: ' ' }, /no title/],
    [{ surfaces: [] }, /surfaces must be/],
    [{ surfaces: ['web'] }, /surfaces must be/],
    [{ surfaces: 'iab' }, /surfaces must be/],
    [{ surfaces: ['iab', 'iab'] }, /listed twice/],
    [{ columns: [] }, /columns must be/],
    [{ columns: ['gemini'] }, /columns must be/],
    [{ columns: 'claude' }, /columns must be/],
    [{ tier: 'nightly' }, /tier must be/],
    [{ apps: 'mail' }, /apps must be a list/],
    [{ apps: ['mail', ''] }, /apps must be a list/],
    [{ macApps: 'Notes' }, /macApps must be a list/],
    [{ macApps: [3] }, /macApps must be a list/],
    [{ apps: ['mail'] }, /works in 1 app\(s\)/],
    [{ apps: [], macApps: undefined }, /works in 0 app\(s\)/],
    [{ actions: [3, 10] }, /actions must be/],
    [{ actions: [20, 90] }, /actions must be/],
    [{ actions: [40, 20] }, /actions must be/],
    [{ actions: 'many' }, /actions must be/],
    [{ actions: [15.5, 20] }, /actions must be/],
    [{ solve: undefined }, /solve must be a function/],
    [{ checkpoints: toy().checkpoints.slice(0, 3) }, /has 3 checkpoints/],
    [{ checkpoints: 'x' }, /has 0 checkpoints/],
    [{ checkpoints: [...toy().checkpoints, { id: 'Bad Id', title: 'x', check: () => true }] }, /must be kebab-case/],
    [{ checkpoints: [...toy().checkpoints, null] }, /checkpoint id undefined must be kebab-case/],
    [{ checkpoints: [...toy().checkpoints, { ...toy().checkpoints[0] }] }, /ticket-a is listed twice/],
    [{ checkpoints: [...toy().checkpoints, { id: 'nocheck', title: 'x' }] }, /nocheck has no check/],
    [
      { checkpoints: [...toy().checkpoints, { id: 'opt-canary', title: 'x', canary: true, required: false, check: () => true }] },
      /cannot be optional/,
    ],
    [{ checkpoints: [...toy().checkpoints, { id: 'w', title: 'x', weight: 0, check: () => true }] }, /weight must be positive/],
    [{ checkpoints: toy().checkpoints.filter((c: any) => !c.canary) }, /no canary/],
    [{ checkpoints: toy().checkpoints.map((c: any) => (c.canary ? c : { ...c, required: false })) }, /no required checkpoint besides/],
    [{ forbidden: 'x' }, /forbidden must be a list/],
    [{ forbidden: [null] }, /forbidden undefined needs an id/],
    [{ forbidden: [{ id: 'nope' }] }, /forbidden nope needs an id and a check/],
    [{ forbidden: [{ id: 'reply', title: 'x', check: () => false }] }, /reuses a checkpoint id/],
    [{ unsafe: undefined }, /need unsafe\(\)/],
    [{ cards: -1 }, /cards must be/],
    [{ cards: { min: 2, max: 1 } }, /cards must be/],
    [{ cards: 1.5 }, /cards must be/],
    [{ escape: { budgetMs: 0 } }, /escape needs/],
    [{ escape: {} }, /escape needs/],
    [{ switchBefore: 0 }, /switchBefore must be/],
    [{ escape: { budgetMs: 10, after: { app: 'bank', event: 'sent' } } }, /escape.after must name/],
    [{ escape: { budgetMs: 10, after: { app: 'mail', event: '' } } }, /escape.after must name/],
    [{ escape: { budgetMs: 10, after: null } }, /escape.after must name/],
    [{ mode: 'yolo' }, /mode must be full or ask/],
    [{ answers: ['allow', 'maybe'] }, /answers must be/],
    [{ answers: 'allow' }, /answers must be/],
    [{ crash: { path: 'orders' } }, /crash.path must be/],
    [{ crash: {} }, /crash.path must be/],
    [{ peers: [] }, /peers must be a list/],
    [{ peers: 'desk' }, /peers must be a list/],
    [{ peers: [{ name: ' ', prompt: () => '' }] }, /peers must be a list/],
    [{ peers: [{ name: 'Desk' }] }, /peers must be a list/],
    [{ peers: [null] }, /peers must be a list/],
    [
      {
        peers: [
          { name: 'Desk', prompt: () => '' },
          { name: 'Desk', prompt: () => '' },
        ],
      },
      /share a name/,
    ],
    [{ limit: { afterRequests: 0 }, columns: ['claude'] }, /afterRequests must be/],
    [{ limit: {}, columns: ['claude'] }, /afterRequests must be/],
    [{ limit: { afterRequests: 3 } }, /runs only on the claude column/],
    [{ limit: { afterRequests: 3 }, columns: 'claude' }, /columns must be/],
    [{ vendors: { 'desk-gemini': 'x' } }, /unknown vendor arm/],
    [{ vendors: { 'desk-claude': '' } }, /needs an N\/A reason/],
  ];
  for (const [over, want] of cases) {
    const problems = validateTask(toy(over));
    assert.ok(
      problems.some((p: string) => want.test(p)),
      `${JSON.stringify(Object.keys(over))}: ${problems.join(' | ')}`,
    );
  }
  assert.ok(validateTask(toy({ id: 3 })).some((p: string) => p.startsWith('3: id must')));
  assert.ok(validateTask({}).some((p: string) => p.startsWith('(no id): ')));
});

test('cells, columns, card ranges and vendor support', () => {
  assert.deepEqual(columnsOf(toy()), ['claude', 'codex', 'switch', 'acp']);
  assert.deepEqual(columnsOf(toy({ columns: ['codex'] })), ['codex']);
  assert.equal(cellId('cu', 'acp'), 'cu×acp');
  assert.deepEqual(cellsOf(toy({ surfaces: ['iab', 'bu'], columns: ['claude', 'switch'] })), [
    'iab×claude',
    'iab×switch',
    'bu×claude',
    'bu×switch',
  ]);
  assert.deepEqual(cardRange(toy({ cards: 2 })), { min: 2, max: 2 });
  assert.deepEqual(cardRange(toy({ cards: undefined })), { min: 0, max: 0 });
  assert.deepEqual(cardRange(toy()), { min: 0, max: 1 });
  assert.deepEqual(vendorSupport(toy(), 'desk-claude'), { supported: true });
  assert.deepEqual(vendorSupport(toy({ surfaces: ['cu'] }), 'desk-chatgpt'), { supported: true });
  assert.equal(vendorSupport(toy(), 'desk-x').supported, false);
  assert.deepEqual(vendorSupport(toy({ vendors: { 'desk-claude': 'no pane' } }), 'desk-claude'), { supported: false, why: 'no pane' });
  // Claude in Chrome is the native browser-use arm (#1381): supported, "pending" in the scorecard until it is set up
  assert.deepEqual(vendorSupport(toy({ surfaces: ['iab', 'bu'] }), 'desk-claude'), { supported: true });
  // a surface a vendor has no equivalent for is N/A with its reason
  (VENDOR_SURFACES as any)['desk-chatgpt'].cu = 'no computer use in this build';
  try {
    assert.deepEqual(vendorSupport(toy({ surfaces: ['iab', 'cu'] }), 'desk-chatgpt'), {
      supported: false,
      why: 'no computer use in this build',
    });
  } finally {
    (VENDOR_SURFACES as any)['desk-chatgpt'].cu = null;
  }
  // what the driver injects through MoPilot's control plane has no hook in a vendor app
  assert.deepEqual(vendorSupport(toy({ crash: { path: '/x' }, escape: { budgetMs: 1 } }), 'desk-claude'), {
    supported: false,
    why: "the driver injects a crashed tab, Esc mid-run through MoPilot's control plane",
  });
  assert.match((vendorSupport(toy({ mode: 'ask' }), 'desk-chatgpt') as any).why, /Ask-mode permission answer/);
  assert.match(
    (vendorSupport(toy({ limit: { afterRequests: 3 }, columns: ['claude'] }), 'desk-claude') as any).why,
    /provider usage limit/,
  );
  assert.deepEqual(vendorSupport(toy({ surfaces: ['bu'] }), 'desk-chatgpt'), { supported: true });
  assert.match((vendorSupport(toy({ family: 'F6', id: 'f6-x' }), 'desk-chatgpt') as any).why, /Harness switch/);
  assert.match((vendorSupport(toy({ family: 'F8', id: 'f8-x' }), 'desk-claude') as any).why, /Cross-session/);
});
