// The owner policy document (shared/host/policy.mjs, plan U2): parsing, defaults, the stricter-wins merge and the generation hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import * as P from '../shared/host/policy.mjs';
// @ts-ignore: plain ESM without declarations
import { parseParams, requireFeatures, FEATURES, SchemaError } from '../shared/host/schema.mjs';

const bad = (m: string) => new Error(m);
const parse = (d: unknown) => P.parseOwnerPolicy(d, bad);

test('a bare document takes every default', () => {
  assert.deepEqual(parse({ version: 1 }), JSON.parse(JSON.stringify(P.DEFAULT_POLICY)));
});

test('unknown keys are dropped and valid keys kept', () => {
  const q = { start: '22:00', end: '07:00', tz: 'America/Los_Angeles' };
  const out = parse({
    version: 1,
    permissionMax: 'default',
    approvals: { remindMinutes: 5, pauseMinutes: 60, junk: 1 },
    notify: {
      needsYou: false,
      done: true,
      paused: false,
      detail: 'full',
      quiet: q,
      extra: 1,
    },
    stray: true,
  });
  assert.equal(out.stray, undefined);
  assert.equal(out.permissionMax, 'default');
  assert.deepEqual(out.approvals, { remindMinutes: 5, pauseMinutes: 60 });
  assert.deepEqual(out.notify, {
    needsYou: false,
    done: true,
    paused: false,
    detail: 'full',
    quiet: q,
  });
  assert.equal(parse({ version: 1, notify: { quiet: null } }).notify.quiet, null);
});

test('an invalid document is refused whole', () => {
  const cases: unknown[] = [
    null,
    [],
    { version: 2 },
    { version: 1, permissionMax: 'root' },
    { version: 1, approvals: 3 },
    { version: 1, approvals: { pauseMinutes: 4 } },
    { version: 1, approvals: { pauseMinutes: 721 } },
    { version: 1, approvals: { remindMinutes: 1.5 } },
    { version: 1, notify: 'x' },
    { version: 1, notify: { needsYou: 'yes' } },
    { version: 1, notify: { detail: 'all' } },
    {
      version: 1,
      notify: { quiet: { start: '25:00', end: '07:00', tz: 'UTC' } },
    },
    {
      version: 1,
      notify: { quiet: { start: '22:00', end: '07:00', tz: 'Mars/Base' } },
    },
    { version: 1, notify: { quiet: { start: '22:00', end: '07:00', tz: '' } } },
    { version: 1, notify: { quiet: 'night' } },
  ];
  for (const c of cases) assert.throws(() => parse(c), /./, JSON.stringify(c));
});

test('ceilings: order, phone cap', () => {
  assert.equal(P.stricterMode('full-access', 'default'), 'default');
  assert.equal(P.stricterMode('read-only', 'auto-review'), 'read-only');
  assert.ok(P.withinCeiling('default', 'auto-review'));
  assert.ok(!P.withinCeiling('full-access', 'auto-review'));
  assert.ok(!P.withinCeiling('bogus', 'full-access'));
  // Plan only reads and plans: it stands where read-only does, and is never a ceiling of its own
  assert.ok(P.withinCeiling('plan', 'read-only'));
  assert.ok(P.withinCeiling('plan', 'full-access'));
  assert.equal(P.stricterMode('plan', 'default'), 'plan');
  assert.equal(P.stricterMode('full-access', 'plan'), 'plan');
  assert.ok(!P.PERMISSION_ORDER.includes('plan'));
  assert.equal(P.ceilingFor('full-access', 'phone'), 'auto-review');
  assert.equal(P.ceilingFor('default', 'phone'), 'default');
  assert.equal(P.ceilingFor('full-access', 'desktop'), 'full-access');
});

test('merge: no managed layer leaves the owner document', () => {
  const o = parse({ version: 1 });
  assert.deepEqual(P.mergePolicy(o, null), { doc: o, locked: [] });
});

test('merge: the stricter value wins per key and is locked', () => {
  const o = parse({
    version: 1,
    permissionMax: 'full-access',
    approvals: { remindMinutes: 10, pauseMinutes: 30 },
  });
  const m = { permissionMax: 'default', approvals: { pauseMinutes: 15 } };
  const { doc, locked } = P.mergePolicy(o, m);
  assert.equal(doc.permissionMax, 'default');
  assert.deepEqual(doc.approvals, { remindMinutes: 10, pauseMinutes: 15 });
  assert.deepEqual(locked, ['permissionMax', 'approvals.pauseMinutes']);
  const looser = P.mergePolicy(parse({ version: 1, permissionMax: 'read-only' }), {
    permissionMax: 'full-access',
    approvals: { remindMinutes: 99 },
  });
  assert.equal(looser.doc.permissionMax, 'read-only');
  assert.equal(looser.doc.approvals.remindMinutes, 10);
  assert.deepEqual(P.mergePolicy(o, {}).locked, []);
  assert.equal(o.approvals.pauseMinutes, 30, 'the owner document is not changed');
});

test('extra blocks parse, merge and are not duplicated', () => {
  P.addPolicyBlock({
    name: 'zz',
    parse: (r: any) => ({ n: r.n }),
    merge: (a: any, b: any) => ({ n: Math.min(a?.n ?? Infinity, b.n) }),
  });
  P.addPolicyBlock({ name: 'zz', parse: () => 'again' });
  P.addPolicyBlock({ name: 'yy', parse: (r: any) => r });
  assert.deepEqual(parse({ version: 1, zz: { n: 5 } }).zz, { n: 5 });
  assert.equal(parse({ version: 1 }).zz, undefined);
  const o = parse({ version: 1, zz: { n: 5 }, yy: 1 });
  const { doc, locked } = P.mergePolicy(o, { zz: { n: 3 }, yy: 2 });
  assert.deepEqual(doc.zz, { n: 3 });
  assert.equal(doc.yy, 1, "a block with no merge rule stays the owner's");
  assert.deepEqual(locked, ['zz']);
});

test('generation is stable under key order and changes with content', () => {
  const a = P.policyGeneration({ b: 1, a: { y: 1, x: 2 } });
  assert.equal(a, P.policyGeneration({ a: { x: 2, y: 1 }, b: 1 }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, P.policyGeneration({ a: { x: 2, y: 1 }, b: 2 }));
});

test('wire: host.policy is a known method gated on the policy feature', () => {
  assert.ok(FEATURES.includes('policy'));
  const out = parseParams('host.policy', {
    doc: { version: 1, permissionMax: 'default' },
  });
  assert.equal(out.doc.permissionMax, 'default');
  assert.throws(() => parseParams('host.policy', { doc: { version: 9 } }), SchemaError);
  assert.throws(() => parseParams('host.policy', {}), SchemaError);
  assert.throws(() => requireFeatures('host.policy', { features: [] }), /./);
  assert.doesNotThrow(() => requireFeatures('host.policy', { features: ['policy'] }));
});

test('clampToCeiling: a chat’s own mode and the mode Plan runs under never exceed the ceiling; Plan stays Plan; nothing known leaves the config as it is', async () => {
  const { clampToCeiling } = await import('../shared/host/policy.mjs');
  assert.deepEqual(clampToCeiling({ model: 'm', permission: 'full-access' }, 'default'), { model: 'm', permission: 'default' });
  assert.deepEqual(clampToCeiling({ permission: 'plan', planBasePermission: 'auto-review' }, 'read-only'), {
    permission: 'plan',
    planBasePermission: 'read-only',
  });
  // Plan entered from no mode runs under the default one
  assert.deepEqual(clampToCeiling({ permission: 'plan' }, 'read-only'), { permission: 'plan', planBasePermission: 'read-only' });
  assert.deepEqual(clampToCeiling({ permission: 'plan' }, 'default'), { permission: 'plan' });
  const within = { permission: 'default', planBasePermission: 'read-only' };
  assert.equal(clampToCeiling(within, 'full-access'), within, 'the same object when nothing changes');
  // a chat with no mode of its own runs under the default one: clamped when that is above the ceiling, nothing to do when it is not
  assert.deepEqual(clampToCeiling(null, 'read-only'), { permission: 'read-only' });
  assert.deepEqual(clampToCeiling(undefined, 'read-only'), { permission: 'read-only' });
  assert.deepEqual(clampToCeiling({ model: 'm' }, 'read-only'), { model: 'm', permission: 'read-only' });
  assert.equal(clampToCeiling(null, 'default'), null);
  assert.equal(clampToCeiling(undefined, 'full-access'), null);
  assert.deepEqual(clampToCeiling({ permission: 'full-access' }, undefined), { permission: 'full-access' });
  assert.deepEqual(clampToCeiling({ permission: 'full-access' }, 'plan'), { permission: 'full-access' }, 'Plan is not a ceiling');
});
