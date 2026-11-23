// The managed policy document (shared/managedPolicy.mjs, plan W1): paths, trust rule, parser, strict fallback and the stricter-wins helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGED_VERSION,
  PERMISSION_LEVELS,
  COMPUTER_LEVELS,
  STRICT_FALLBACK,
  managedPolicyPath,
  untrustedReason,
  parseManagedPolicy,
  stricterOf,
  unionDeny,
  intersectAllow,
  minLimit,
  managedGeneration,
} from '../shared/managedPolicy.mjs';

const bad = (m: string) => new Error(m);
const parse = (extra: object) => parseManagedPolicy({ version: 1, ...extra }, bad);
const refuses = (extra: any, re: RegExp) => assert.throws(() => parse(extra), re);

test('paths per platform and product', () => {
  assert.equal(managedPolicyPath({ platform: 'darwin', product: 'app' }), '/Library/Application Support/MoPilot Code/managed-policy.json');
  assert.equal(managedPolicyPath({ platform: 'darwin', product: 'host' }), '/Library/Application Support/MoPilot Host/managed-policy.json');
  assert.equal(managedPolicyPath({ platform: 'linux', product: 'app' }), '/etc/mopilot-code/managed-policy.json');
  assert.equal(managedPolicyPath({ platform: 'linux', product: 'host' }), '/etc/mopilot-host/managed-policy.json');
  assert.equal(
    managedPolicyPath({ platform: 'win32', product: 'app', env: { ProgramData: 'D:\\PD' } }),
    'D:\\PD\\MoPilot Code\\managed-policy.json',
  );
  assert.equal(managedPolicyPath({ platform: 'win32', product: 'host' }), 'C:\\ProgramData\\MoPilot Host\\managed-policy.json');
});

test('a file the user can write is not trusted', () => {
  assert.equal(untrustedReason({ uid: 0, mode: 0o100644 }, 'darwin'), null);
  assert.match(untrustedReason({ uid: 501, mode: 0o100644 }, 'darwin')!, /not owned by root/);
  assert.match(untrustedReason({ uid: 0, mode: 0o100664 }, 'linux')!, /written by someone other than root/);
  assert.match(untrustedReason({ uid: 0, mode: 0o100646 }, 'linux')!, /written by someone/);
  assert.equal(untrustedReason({ uid: 501, mode: 0o100666 }, 'win32'), null);
});

test('an empty document parses to its version; unknown keys are dropped', () => {
  assert.deepEqual(parse({ future: { x: 1 } }), { version: MANAGED_VERSION });
});

test('every block parses, with its keys optional', () => {
  const doc = parse({
    organization: 'Acme',
    harnesses: { allow: ['claude', 'claude', 'codex'] },
    permission: { max: 'default' },
    accounts: { rotation: false },
    computerUse: { maxLevel: 'click', denyApps: ['com.x'], allowAlways: false },
    browser: { denySites: ['a.com'], allowSites: ['b.com'] },
    connectors: { allow: ['gh'] },
    hosts: { approvals: { pauseMinutesMax: 60 }, clients: { phone: false }, credentials: { orgOnly: true }, roots: ['/srv/work'] },
    orgAccess: {
      issuer: 'https://id.acme.example',
      clientId: 'c',
      scopes: ['openid'],
      gateways: { anthropic: 'https://a.example', openai: 'https://o.example' },
      leaseHours: 8,
    },
    endpoints: { relay: 'wss://relay.acme.example/v1/ws', api: 'https://mopilot.acme.example' },
    audit: { required: true, retentionDays: 365, detail: 'full' },
    spend: { dayUsdMax: 50, chatUsdMax: 20 },
    cloud: { allow: true, providers: ['p'], machinesMax: 3, idleMinutesMax: 60, hoursPerDayMax: 12, network: 'limited' },
  });
  assert.deepEqual(doc.harnesses, { allow: ['claude', 'codex'] });
  assert.equal(doc.orgAccess.gateways.openai, 'https://o.example');
  assert.equal(doc.cloud.network, 'limited');
  assert.equal(doc.audit.detail, 'full');
  for (const k of ['harnesses', 'permission', 'accounts', 'connectors']) assert.deepEqual(parse({ [k]: {} })[k], {});
  assert.deepEqual(parse({ hosts: {} }).hosts, {});
  assert.deepEqual(parse({ hosts: { approvals: {}, clients: {}, credentials: {} } }).hosts, {
    approvals: {},
    clients: {},
    credentials: {},
  });
  for (const k of ['computerUse', 'browser', 'orgAccess', 'endpoints', 'audit', 'spend', 'cloud'])
    assert.deepEqual(parse({ [k]: {} })[k], {});
  assert.deepEqual(parse({ orgAccess: { gateways: {} } }).orgAccess, { gateways: {} });
});

test('an invalid value refuses the whole document', () => {
  assert.throws(() => parseManagedPolicy('x', bad), /not a policy/);
  assert.throws(() => parseManagedPolicy([], bad), /not a policy/);
  assert.throws(() => parseManagedPolicy({ version: 2 }, bad), /version/);
  refuses({ organization: '' }, /organization/);
  refuses({ harnesses: [] }, /harnesses must be an object/);
  refuses({ harnesses: { allow: 'claude' } }, /list of text/);
  refuses({ harnesses: { allow: [1] } }, /list of text/);
  refuses({ harnesses: { allow: new Array(1001).fill('a') } }, /list of text/);
  refuses({ permission: { max: 'root' } }, /permission.max must be one of/);
  refuses({ permission: { max: 3 } }, /one of/);
  refuses({ accounts: { rotation: 'no' } }, /true or false/);
  refuses({ computerUse: { maxLevel: 'x' } }, /computerUse.maxLevel/);
  refuses({ computerUse: { denyApps: 1 } }, /denyApps/);
  refuses({ computerUse: { allowAlways: 1 } }, /allowAlways/);
  refuses({ browser: { denySites: 1 } }, /denySites/);
  refuses({ browser: { allowSites: 1 } }, /allowSites/);
  refuses({ hosts: { approvals: { pauseMinutesMax: 0 } } }, /pauseMinutesMax/);
  refuses({ hosts: { approvals: { pauseMinutesMax: 1.5 } } }, /pauseMinutesMax/);
  refuses({ hosts: { approvals: { pauseMinutesMax: 721 } } }, /pauseMinutesMax/);
  refuses({ hosts: { clients: { phone: 'x' } } }, /phone/);
  refuses({ hosts: { credentials: { orgOnly: 'x' } } }, /orgOnly/);
  refuses({ hosts: { roots: 'x' } }, /roots/);
  refuses({ orgAccess: { issuer: 'ftp://x' } }, /issuer/);
  refuses({ orgAccess: { issuer: 'nope' } }, /issuer/);
  refuses({ orgAccess: { issuer: 1 } }, /issuer/);
  refuses({ orgAccess: { clientId: 1 } }, /clientId/);
  refuses({ orgAccess: { scopes: 1 } }, /scopes/);
  refuses({ orgAccess: { gateways: { anthropic: 'x' } } }, /gateways.anthropic/);
  refuses({ orgAccess: { gateways: 1 } }, /gateways must be an object/);
  refuses({ orgAccess: { leaseHours: 0 } }, /leaseHours/);
  refuses({ endpoints: { relay: 'x' } }, /relay/);
  refuses({ audit: { required: 1 } }, /audit.required/);
  refuses({ audit: { retentionDays: 0 } }, /retentionDays/);
  refuses({ audit: { detail: 'all' } }, /audit.detail/);
  refuses({ spend: { dayUsdMax: 0 } }, /dayUsdMax/);
  refuses({ spend: { chatUsdMax: 'x' } }, /chatUsdMax/);
  refuses({ spend: { chatUsdMax: Infinity } }, /chatUsdMax/);
  refuses({ spend: { chatUsdMax: 2_000_000 } }, /chatUsdMax/);
  refuses({ cloud: { allow: 1 } }, /cloud.allow/);
  refuses({ cloud: { providers: 1 } }, /providers/);
  refuses({ cloud: { machinesMax: 0 } }, /machinesMax/);
  refuses({ cloud: { idleMinutesMax: 0 } }, /idleMinutesMax/);
  refuses({ cloud: { hoursPerDayMax: 25 } }, /hoursPerDayMax/);
  refuses({ cloud: { network: 'x' } }, /cloud.network/);
});

test('the strict fallback is stricter than every ceiling it sets', () => {
  assert.equal(STRICT_FALLBACK.permission.max, 'default');
  assert.equal(STRICT_FALLBACK.accounts.rotation, false);
  assert.equal(STRICT_FALLBACK.computerUse.allowAlways, false);
  assert.equal(STRICT_FALLBACK.hosts.clients.phone, false);
  assert.ok(COMPUTER_LEVELS.indexOf(STRICT_FALLBACK.computerUse.maxLevel) < COMPUTER_LEVELS.indexOf('full'));
  assert.doesNotThrow(() => parseManagedPolicy(JSON.parse(JSON.stringify(STRICT_FALLBACK)), bad));
});

test('merge helpers: stricter ceiling, deny union, allow intersection, smaller limit', () => {
  assert.equal(stricterOf(PERMISSION_LEVELS, 'full-access', 'default'), 'default');
  assert.equal(stricterOf(PERMISSION_LEVELS, 'read-only', 'default'), 'read-only');
  assert.equal(stricterOf(PERMISSION_LEVELS, undefined, 'default'), 'default');
  assert.equal(stricterOf(PERMISSION_LEVELS, 'default', undefined), 'default');
  assert.deepEqual(unionDeny(['a'], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(unionDeny(undefined, undefined), []);
  assert.deepEqual(intersectAllow(['a', 'b'], ['b', 'c']), ['b']);
  assert.deepEqual(intersectAllow(['a'], undefined), ['a']);
  assert.deepEqual(intersectAllow(undefined, ['c']), ['c']);
  assert.equal(minLimit(5, 3), 3);
  assert.equal(minLimit(2, 3), 2);
  assert.equal(minLimit(undefined, 3), 3);
  assert.equal(minLimit(2, undefined), 2);
});

test('the generation does not depend on key order', () => {
  assert.equal(managedGeneration({ a: 1, b: { c: 2, d: 3 } }), managedGeneration({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(managedGeneration({ a: 1 }), managedGeneration({ a: 2 }));
  assert.equal(managedGeneration([1, { z: 1, a: 2 }]), managedGeneration([1, { a: 2, z: 1 }]));
});
