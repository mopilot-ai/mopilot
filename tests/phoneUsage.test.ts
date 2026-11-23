// Phone quota projection: local account identity, reset/freshness semantics, strict wire parsing and late request ownership.
import './support/phone/register.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { scripted } = await import('./support/phone/m3.ts');
const usagePath = '../mobile/src/remote/usage.ts';
const clientPath = '../mobile/src/remote/client.ts';
const { loadUsage, parseUsage, usageLines, usageReader } = await import(usagePath);
const { ownedRequest } = await import(clientPath);
const require = createRequire(import.meta.url);
const { readPhoneUsage } = require('../electron/remote/usage.cjs');
const { createIdentityApi } = require('../electron/harness/claude/identityApi.cjs');
const at = Date.now();
const window = { label: '5h', usedPercent: 62, resetsAt: at / 1000 + 3600, at, stale: false };
const row = { harness: 'codex', account: 'work', label: 'Work', state: 'available', windows: [window] };
const reply = { scope: 'local', accounts: [row] };
const deferred = () => {
  let resolve!: (v: any) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<any>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test('usage.get is advertised and reaches the phone through the real remote schema and dispatcher', async () => {
  const { RemoteService } = require('../electron/remote/service.cjs');
  const params: any[] = [];
  const svc = new RemoteService({
    ops: {
      usage: async (p: any) => {
        params.push(p);
        return reply;
      },
    },
  });
  const phone = { kind: 'phone', pairId: 'p1', follows: new Set() };
  assert.ok((await svc.call(phone, 'machine.hello', {})).capabilities.methods.includes('usage.get'));
  assert.deepEqual(await svc.call(phone, 'usage.get', { hostId: 'ignored' }), reply);
  assert.deepEqual(await svc.call(phone, 'usage.get', { refresh: true }), reply);
  assert.deepEqual(params, [{ refresh: false }, { refresh: true }]);
});

function world() {
  let serverId = 'who';
  const accounts: any[] = [
    { harness: 'claude', account: 'work', billing: 'subscription', label: 'Work', status: 'ok', active: true },
    { harness: 'codex', account: 'work', billing: 'subscription', label: 'Codex Work', status: 'ok' },
    { harness: 'codex', account: 'key', billing: 'apiKey', status: 'ok' },
    { harness: 'acp', account: 'gemini', billing: 'harness', status: 'ok' },
    { harness: 'claude', account: 'old', billing: 'subscription', status: 'expired' },
  ];
  const claude: any = {
    accounts: () => ({ view: () => ({ accounts: [{ id: 'work', serverId }] }) }),
    readUsageResult: async () => ({
      state: 'success',
      account: 'who',
      text: 'Current session: 62% used',
      measuredAt: at - 900000,
      live: { at, windows: [window] },
    }),
  };
  const driver: any = {
    usage: async () => ({
      at: at - 900000,
      primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: window.resetsAt },
      secondary: { usedPercent: 5, windowDurationMins: 10080 },
    }),
  };
  const live = { identity: { instances: (h?: string) => accounts.filter((a) => !h || h === a.harness), driver: () => driver } };
  return {
    live,
    claude,
    accounts,
    driver,
    change: () => {
      serverId = 'other';
    },
  };
}

test('local projection retains each account, measured time and newer live windows, excluding credentials and Host data', async () => {
  const w = world();
  const raw = await readPhoneUsage(w.live, w.claude, at);
  const rows = parseUsage(raw);
  assert.equal(rows[0].windows[0].at, at);
  assert.equal(rows[0].windows[0].usedPercent, 62);
  assert.equal(rows[1].windows[0].stale, true);
  assert.deepEqual(
    rows[1].windows.map((w) => w.label),
    ['5h', 'Weekly'],
  );
  assert.deepEqual(
    rows.slice(2).map((a) => a.state),
    ['unsupported', 'unsupported', 'signin'],
  );
  assert.equal(rows[2].label, 'key');
  assert.equal(raw.scope, 'local');
});

test('unknown/reset quota never turns into zero usage, malformed wire data never succeeds', () => {
  assert.equal(usageLines({ ...window, resetsText: null }, at).value, '38% left');
  assert.equal(usageLines({ ...window, resetsAt: at / 1000, resetsText: null }, at).value, 'Refresh needed');
  assert.match(usageLines({ ...window, stale: true, resetsAt: null, resetsText: 'tomorrow' }, at).value, /Last known/);
  assert.equal(usageLines({ ...window, at: 0, resetsAt: null, resetsText: null }, at).detail, 'Reset time unavailable');
  for (const bad of [
    null,
    [],
    {},
    { ...reply, scope: 'host' },
    { ...reply, accounts: [null] },
    { ...reply, accounts: [{ ...row, windows: [] }] },
    { ...reply, accounts: [{ ...row, windows: [{ ...window, usedPercent: 101 }] }] },
    { ...reply, accounts: [{ ...row, windows: [{ ...window, resetsAt: 'now' }] }] },
  ])
    assert.throws(() => parseUsage(bad));
});

test('a replaced Claude credential retires an in-flight reading even if its label is unchanged', async () => {
  const w = world(),
    d = deferred();
  w.claude.readUsageResult = () => d.promise;
  const pending = readPhoneUsage(w.live, w.claude, at);
  w.change();
  d.resolve({ state: 'success', account: 'who', measuredAt: at, text: 'Current session: 90% used' });
  await assert.rejects(pending, /account changed/);
});

test('unavailable/retired/foreign Claude readings expose no figures or raw failure text; other accounts still load', async () => {
  for (const answer of [
    { state: 'error', error: 'secret' },
    { state: 'retired' },
    { state: 'success', account: 'other', text: 'Current session: 12% used' },
    { state: 'success', account: 'who', text: 'unknown' },
  ]) {
    const w = world();
    w.claude.readUsageResult = async () => answer;
    const raw = await readPhoneUsage(w.live, w.claude, at);
    assert.equal(raw.accounts[0].state, 'unavailable');
    assert.deepEqual(raw.accounts[0].windows, []);
    assert.doesNotMatch(JSON.stringify(raw), /secret/);
  }
  await assert.rejects(readPhoneUsage({}, {}, at), /not ready/);
});

test('Claude structured surface reads preserve the scheduler result; text API keeps its failures', async () => {
  const result = { state: 'success', text: 'text', measuredAt: at };
  let answer: any = result;
  const api = createIdentityApi({
    state: {},
    auth: { configIdOf: (id: string) => id },
    cli: { findBinary: async () => '/bin/claude' },
    usageSchedule: {
      usage: async (...args: any[]) => {
        assert.equal(args[2], 'surface');
        return answer;
      },
    },
  });
  assert.equal(await api.readUsageResult('work'), result);
  assert.equal(await api.readUsage('work'), 'text');
  answer = { state: 'retired' };
  await assert.rejects(api.readUsage('work'), /login changed/);
  answer = { state: 'error', error: 'unavailable' };
  await assert.rejects(api.readUsage('work'), /unavailable/);
  const missing = createIdentityApi({
    state: {},
    auth: { configIdOf: (id: string) => id },
    cli: { findBinary: async () => null },
    usageSchedule: {},
  });
  assert.equal((await missing.readUsageResult('work')).state, 'error');
});

test('older Macs are explained; latest refresh wins in both orders and disposal drops errors', async () => {
  const old = scripted(() => undefined);
  await assert.rejects(loadUsage(ownedRequest(old.runtime)), /Update MoPilot/);
  for (const reverse of [false, true]) {
    const reads = [deferred(), deferred()];
    let n = 0;
    const s = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : reads[n++].promise));
    const shown: any[] = [];
    const reader = usageReader(ownedRequest(s.runtime), (...args) => shown.push(args));
    const a = reader.refresh(),
      b = reader.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    if (reverse) {
      reads[1].resolve(reply);
      await b;
      reads[0].reject(new Error('old'));
      await a;
    } else {
      reads[0].resolve(reply);
      await a;
      reads[1].resolve(reply);
      await b;
    }
    assert.equal(shown.filter((a) => a[0]).length, 1);
    assert.equal(shown.at(-1)[2], false);
    reader.dispose();
  }
  const d = deferred();
  const s = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : d.promise));
  const shown: any[] = [];
  const r = usageReader(ownedRequest(s.runtime), (...args) => shown.push(args));
  const pending = r.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  r.dispose();
  d.reject(new Error('late'));
  await pending;
  assert.equal(shown.length, 1);
});

test('changing pair or connection generation rejects late results and a new owner can retry', async () => {
  for (const field of ['selectedPair', 'generation']) {
    const d = deferred();
    const s = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : d.promise));
    const shown: any[] = [];
    const r = usageReader(ownedRequest(s.runtime), (...args) => shown.push(args));
    const pending = r.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    s.state.snap = { ...s.state.snap, [field]: field === 'generation' ? 2 : 'other' };
    d.resolve(reply);
    await pending;
    assert.equal(shown.at(-1)[0], null);
    assert.match(shown.at(-1)[1], /computer changed/);
    const fresh = usageReader(ownedRequest(s.runtime), (...args) => shown.push(args));
    await fresh.refresh();
    assert.equal(shown.at(-1)[0][0].account, 'work');
  }
});

test('an account that finishes before a different account waits is checked again at publication', async () => {
  const w = world(),
    d = deferred();
  w.driver.usage = () => d.promise;
  const pending = readPhoneUsage(w.live, w.claude, at);
  await new Promise((resolve) => setImmediate(resolve));
  w.change();
  d.resolve(null);
  await assert.rejects(pending, /account changed/);
});

test('ACP degraded states use the real account driver and never mislabel unavailable as signed out', async () => {
  const { AcpDriver } = require('../electron/identity/drivers/acp.cjs');
  const { Registry } = require('../electron/identity/contract/registry.cjs');
  const registry = new Registry();
  registry.register(
    new AcpDriver({
      list: () => ['admitted', 'signin', 'checking', 'unsupported', 'off', 'missing'].map((state) => ({ id: state, state })),
    }),
  );
  const rows = parseUsage(await readPhoneUsage({ identity: registry }, {}, at));
  assert.deepEqual(
    rows.map((a) => a.state),
    ['unsupported', 'signin', 'unavailable', 'unavailable', 'unavailable'],
  );
});

test('explicit refresh forwards now while opening the surface keeps the account schedule', async () => {
  const w = world(),
    reasons: any[] = [];
  w.driver.usage = async (_id: any, reason: any) => {
    reasons.push(reason);
    return null;
  };
  await readPhoneUsage(w.live, w.claude, at);
  await readPhoneUsage(w.live, w.claude, at, 'now');
  assert.deepEqual(reasons, ['surface', 'now']);
});

test('Codex quota uses the actual driver, honors read reasons and credential retirement', async () => {
  const { CodexDriver } = require('../electron/identity/drivers/codex.cjs');
  const { Registry } = require('../electron/identity/contract/registry.cjs');
  let epoch = 0;
  const raw = {
    id: 'same',
    email: 'same@example.com',
    status: 'ok',
    limits: { at, primary: { usedPercent: 12, windowDurationMins: 45 }, secondary: { usedPercent: 20, windowDurationMins: 1440 } },
  };
  const reasons: any[] = [];
  const pool: any = {
    state: { accounts: [raw] },
    active: () => raw,
    get: () => raw,
    limited: () => false,
    usageRefresh: {
      capture: () => {
        const started = epoch;
        return () => started === epoch;
      },
    },
    refreshUsage: async (_ids: any, reason: any) => reasons.push(reason),
  };
  const registry = new Registry();
  registry.register(new CodexDriver(pool));
  const rows = parseUsage(await readPhoneUsage({ identity: registry }, {}, at, 'now'));
  assert.deepEqual(reasons, ['now']);
  assert.deepEqual(
    rows[0].windows.map((w) => w.label),
    ['45m', '1d'],
  );
  const d = deferred();
  pool.refreshUsage = () => d.promise;
  const pending = readPhoneUsage({ identity: registry }, {}, at);
  epoch++;
  d.resolve(null);
  await assert.rejects(pending, /account changed/);
});

test('missing Codex limits and failures are unavailable, and unknown durations retain their neutral label', async () => {
  const w = world();
  w.driver.usage = async () => null;
  assert.equal((await readPhoneUsage(w.live, w.claude, at)).accounts[1].state, 'unavailable');
  w.driver.usage = async () => {
    throw new Error('private provider error');
  };
  assert.equal((await readPhoneUsage(w.live, w.claude, at)).accounts[1].state, 'unavailable');
  w.driver.usage = async () => ({ primary: { usedPercent: 1 } });
  const row = parseUsage(await readPhoneUsage(w.live, w.claude, at))[1];
  assert.equal(row.windows[0].label, 'Limit');
  assert.equal(row.windows[0].stale, true);
});

test('a selected key cannot supply quota for a Claude subscription login', async () => {
  const api = createIdentityApi({
    state: {},
    auth: { configIdOf: () => 'key' },
    cli: {
      findBinary: async () => {
        throw new Error('must not read');
      },
    },
    usageSchedule: {},
  });
  assert.equal((await api.readUsageResult('work')).state, 'error');
});

test('wire validation rejects each malformed owner/window field and accepts absent optional display text', () => {
  for (const change of [
    { harness: '' },
    { account: null },
    { label: [] },
    { state: 'unknown' },
    { windows: null },
    { windows: [null] },
    { windows: [{ ...window, label: null }] },
    { windows: [{ ...window, usedPercent: -1 }] },
    { windows: [{ ...window, usedPercent: NaN }] },
    { windows: [{ ...window, at: 'now' }] },
    { windows: [{ ...window, stale: undefined }] },
  ])
    assert.throws(() => parseUsage({ ...reply, accounts: [{ ...row, ...change }] }));
  assert.equal(parseUsage(reply)[0].windows[0].resetsText, null);
  assert.equal(parseUsage({ ...reply, accounts: [{ ...row, active: true }] })[0].active, true);
  assert.match(usageLines({ ...window, at: at - 600001, resetsText: null }, at).value, /Last known/);
});

test('a retired reader cannot publish a late success or start another request; stale rejection cannot clear a new pending read', async () => {
  const d = deferred(),
    shown: any[] = [];
  const s = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : d.promise));
  const r = usageReader(ownedRequest(s.runtime), (...args: any[]) => shown.push(args));
  const pending = r.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  r.dispose();
  d.resolve(reply);
  await pending;
  await r.refresh();
  assert.equal(shown.length, 1);
  const reads = [deferred(), deferred()];
  let n = 0;
  const s2 = scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : reads[n++].promise));
  const result: any[] = [];
  const reader = usageReader(ownedRequest(s2.runtime), (...args: any[]) => result.push(args));
  const first = reader.refresh(),
    second = reader.refresh(true);
  await new Promise((resolve) => setImmediate(resolve));
  reads[0].reject(new Error('obsolete'));
  await first;
  assert.equal(result.at(-1)[2], true);
  reads[1].resolve(reply);
  await second;
  assert.equal(result.at(-1)[2], false);
});

test('Claude key-mode changes during binary lookup or quota read cannot publish key quota for an unknown login identity', async () => {
  for (const stage of ['binary', 'quota']) {
    let mode = 'subscription';
    const binary = deferred();
    const quota = deferred();
    let queried = 0;
    const account = { harness: 'claude', account: 'default', billing: 'subscription', status: 'ok', label: 'CLI login', active: true };
    const api = createIdentityApi({
      state: { accts: { view: () => ({ accounts: [{ id: 'default', serverId: null }] }) } },
      auth: { configIdOf: (id: string) => (mode === 'subscription' ? id : 'apiKey') },
      cli: { findBinary: () => (stage === 'binary' ? binary.promise : Promise.resolve('/bin/claude')) },
      usageSchedule: {
        usage: () => {
          queried++;
          return quota.promise;
        },
      },
    });
    const pending = readPhoneUsage({ identity: { instances: () => [account] } }, api);
    await new Promise((resolve) => setImmediate(resolve));
    mode = 'apiKey';
    binary.resolve('/bin/claude');
    quota.resolve({ state: 'success', account: null, text: 'Current session: 91% used', measuredAt: Date.now() });
    const result = await pending;
    assert.equal(result.accounts[0].state, 'unavailable', stage);
    assert.deepEqual(result.accounts[0].windows, [], stage);
    if (stage === 'binary') assert.equal(queried, 0, 'a retired key-mode lookup must not start quota work');
  }
});

test('a reader binds the displayed connection owner rather than a newer runtime snapshot', async () => {
  const s = scripted(() => reply);
  const shown: any[] = [];
  const reader = usageReader(ownedRequest(s.runtime, { selectedPair: 'previous', generation: 1 }), (...args: any[]) => shown.push(args));
  await reader.refresh();
  assert.equal(s.calls.length, 0);
  assert.match(shown.at(-1)[1], /computer changed/);
  assert.equal(shown.at(-1)[2], false);
});

test('an owned Claude read failure is unavailable while other accounts remain readable, and reset text survives projection', async () => {
  const w = world();
  w.claude.readUsageResult = async () => ({ state: 'error', account: 'who', error: 'private provider diagnostic' });
  const failed = parseUsage(await readPhoneUsage(w.live, w.claude, at));
  assert.equal(failed[0].state, 'unavailable');
  assert.equal(failed[1].state, 'available');
  assert.deepEqual(failed[0].windows, []);
  w.claude.readUsageResult = async () => ({
    state: 'success',
    account: 'who',
    measuredAt: at,
    text: 'Current session: 35% used · resets tomorrow',
  });
  const recovered = parseUsage(await readPhoneUsage(w.live, w.claude, at))[0];
  assert.equal(recovered.state, 'available');
  assert.equal(recovered.windows[0].usedPercent, 35);
  assert.equal(recovered.windows[0].resetsText, 'tomorrow');
});

test('a non-Error failure has generic readable recovery and a subsequent usage retry succeeds', async () => {
  let failing = true;
  const shown: any[] = [];
  const request = async (method: string) => {
    if (failing) throw { privateDiagnostic: 'credential-specific failure' };
    return method === 'machine.hello' ? { capabilities: { methods: ['usage.get'] } } : reply;
  };
  const reader = usageReader(request, (...args: any[]) => shown.push(args));
  await reader.refresh();
  assert.deepEqual(shown.at(-1), [null, 'Could not read usage. Try again.', false]);
  failing = false;
  await reader.refresh();
  assert.equal(shown.at(-1)[0][0].account, 'work');
  assert.equal(shown.at(-1)[1], null);
  assert.equal(shown.at(-1)[2], false);
});
