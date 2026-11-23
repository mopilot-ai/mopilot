// Edge cases of the computer-use policy, the grant store and Sage's approval broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const policy = require('../electron/capabilities/contract/policy.cjs');
const { GrantStore, withGrant } = require('../electron/capabilities/grants.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cap-grants-'));

test('policy: no app id or no grants means no level and nothing denied', () => {
  assert.equal(policy.grantedLevel([{ bundleId: 'a', level: 'full' }], ''), null);
  assert.equal(policy.grantedLevel(null, 'a'), null);
  assert.equal(policy.grantedLevel([null, { bundleId: 'a', level: 'bogus' }], 'a'), null);
  assert.equal(policy.denied(['a'], ''), false);
  assert.equal(policy.denied(null, 'a'), false);
  assert.equal(policy.denied(['com.evil.*'], 'com.evil'), true);
  assert.equal(policy.denied(['com.evil.*'], 'com.evil.app'), true);
  assert.equal(policy.denied(['com.evil.*'], 'com.evilx'), false);
});

test('policy: a key or typed text that is missing is no irreversible action; long labels are clipped', () => {
  assert.equal(policy.irreversible('computer_key', {}, { app: { bundleId: 'com.apple.mail' } }), null);
  assert.equal(policy.irreversible('computer_type', {}, { app: { bundleId: 'com.apple.mail' } }), null);
  assert.equal(policy.irreversible('computer_key', { key: 'cmd + backspace' })?.verb, 'delete');
  // the names the helper also reads as Command, and a delete later in a sequence, ask the same way
  for (const key of ['meta+backspace', 'super+Delete', 'win+forward_delete', 'Command+Del', 'cmd+a cmd+backspace'])
    assert.equal(policy.irreversible('computer_key', { key })?.verb, 'delete', key);
  assert.equal(policy.irreversible('computer_key', { key: 'meta+a' }), null);
  assert.equal(policy.irreversible('computer_key', { key: 'ctrl+backspace' }), null);
  assert.equal(policy.irreversible('computer_key', { key: 'cmd+a enter' }, { app: { bundleId: 'com.apple.MobileSMS' } })?.verb, 'send');
  const long = `Delete ${'x'.repeat(100)}`;
  const r = policy.irreversible('computer_click', {}, { element: { title: long } });
  assert.equal(r.summary.length, 80);
  assert.ok(r.summary.endsWith('…'));
  assert.equal(policy.irreversible('computer_click', { irreversible: true, summary: 'wipe it' })?.summary, 'wipe it');
  assert.equal(policy.irreversible('computer_scroll'), null);
});

test('policy: anchorOf without a harness or permission is ask; acp modes map through anchors', () => {
  assert.equal(policy.anchorOf(), 'ask');
  assert.equal(policy.anchorOf({ harness: 'acp:x', acp: { modes: { currentModeId: 'm' }, anchors: { m: 'full' } } }), 'full');
  // a mode the harness declares as a config option (opencode) is read the same way
  const opencode = (cur: string) => ({
    harness: 'acp:opencode',
    acp: {
      modes: null,
      configOptions: [
        { id: 'mode', category: 'mode', type: 'select', currentValue: cur, options: [{ value: 'plan' }, { value: 'mopilot-full' }] },
      ],
      anchors: { plan: 'readOnly', 'mopilot-full': 'full' },
    },
  });
  assert.equal(policy.anchorOf(opencode('plan')), 'readOnly');
  assert.equal(policy.anchorOf(opencode('mopilot-full')), 'full');
  assert.equal(policy.anchorOf({ harness: 'acp:x', acp: { configOptions: [] } }), 'ask');
  assert.equal(policy.anchorOf({ harness: 'acp:x', acp: { modes: { currentModeId: 'm' }, anchors: { m: 'weird' } } }), 'ask');
  assert.equal(policy.anchorOf({ harness: 'acp:x' }), 'ask');
  assert.equal(policy.anchorOf({ permission: 'acceptEdits' }), 'auto');
  assert.equal(policy.anchorOf({ permission: 'bypassPermissions' }), 'full');
  assert.equal(policy.unattendedReason(), 'no turn you started');
  assert.equal(policy.unattendedReason({ turn: { human: true }, idleMs: policy.IDLE_MS }), 'no input for 10 minutes');
  assert.equal(policy.unattendedReason({ turn: { human: true }, idleMs: 5 }), null);
  assert.deepEqual(policy.grantFromAnswer({ decision: 'allow', scope: 'x', level: 'x' }, 'click'), { scope: 'once', level: 'click' });
  assert.equal(policy.grantFromAnswer({ decision: 'allow', level: 'view' }, 'full'), null);
  assert.equal(policy.grantFromAnswer(null, 'view'), null);
});

test('withGrant: names default to the id, an invalid entry is dropped, a weaker grant never lowers', () => {
  const list = withGrant(
    [{ bundleId: 'a', level: 'full', at: 'x' }, { bundleId: '', level: 'view' }, 'junk'],
    { bundleId: 'A' },
    'view',
    5,
  );
  assert.deepEqual(list, [{ bundleId: 'A', name: 'A', level: 'full', at: 5 }]);
  assert.deepEqual(withGrant(null, { bundleId: 'b', name: 'B' }, 'click', 1), [{ bundleId: 'b', name: 'B', level: 'click', at: 1 }]);
  assert.deepEqual(withGrant([{ bundleId: 'c', name: 'Cee', level: 'view', at: 3 }], { bundleId: 'c' }, null, 0), []);
});

test('GrantStore: a file holding null, a failing save, and wrong arguments', () => {
  const dir = tmp();
  const file = path.join(dir, 'computer.json');
  fs.writeFileSync(file, 'null');
  const changes: (string | null)[] = [];
  const metas = new Map<string, any>();
  const chats = {
    get: (id: string) => metas.get(id),
    patchMeta: (id: string, p: any) => (id === 'nope' ? false : (metas.set(id, { meta: p }), true)),
  };
  const store = new GrantStore({ file, chats, onChange: (c: string | null) => changes.push(c) });
  assert.deepEqual(store.global(), []);
  assert.deepEqual(store.deny(), []);
  assert.equal(store.grant('c1', { bundleId: 'a' }, 'bogus', 'chat'), false);
  assert.equal(store.grant('c1', null, 'view', 'chat'), false);
  assert.equal(store.grant('c1', { bundleId: 'a' }, 'view', 'once'), false);
  assert.equal(store.grant('nope', { bundleId: 'a' }, 'view', 'chat'), false);
  assert.equal(store.revoke('nope', 'a'), false);
  assert.equal(store.revoke(null, 'missing'), false);
  assert.throws(() => store.setDeny('not a list'), { code: 'save_failed' });
  // A failed write must leave the prior grants intact and report failure.
  fs.rmSync(file);
  fs.mkdirSync(file);
  assert.throws(() => store.grant(null, { bundleId: 'a', name: 'A' }, 'view', 'always'), { code: 'save_failed' });
  assert.equal(store.global().length, 0);
  assert.deepEqual(changes, []);
  // no onChange given: defaults to a no-op, and the clock defaults to Date.now
  const quiet = new GrantStore({ file: path.join(dir, 'other.json'), chats });
  assert.equal(quiet.grant(null, { bundleId: 'z' }, 'view', 'always'), true);
  assert.ok(quiet.global()[0].at > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ApprovalBroker: an unknown kind rejects; an answer without a result is null; a sweep with no list drops ours', async () => {
  const added: any[] = [];
  const broker = new ApprovalBroker({ controller: { addApproval: (_c: string, a: any) => added.push(a), resolveApproval: () => true } });
  await assert.rejects(broker.ask('c', 'bogus', {}), /unknown approval kind/);
  const a = broker.ask('c', 'computerAccess', { app: 'x' });
  assert.equal(added[0].method, 'sage/computerAccess');
  assert.equal(broker.answer(a.id, undefined), true);
  assert.equal(await a, null);
  assert.equal(broker.answer(a.id, {}), false);
  const b = broker.ask('c', 'visionConsent', {});
  const other = broker.ask('d', 'visionConsent', {});
  broker.sweep('c', null);
  assert.equal(await b, null);
  assert.equal(broker.pending.has(other.id), true);
});
