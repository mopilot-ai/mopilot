// What a paired `phone` may ask the Host (host/src/controllerRefusals.mjs PHONE_ALLOWED, #5616): exactly the methods the phone's own code sends today, nothing inherited from a controller and no family by prefix; everything else, a method nobody decided included, is refused at the one entry on a served Host, with an audit line. A phone feature that needs another method adds it with its reasoning, and the scan below fails until it does (and while a method is allowed that no phone code sends). A guard-rail and an audit trail, not a boundary (a chat's shell runs as the Host's OS user: #5617).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { PARSERS } from '../shared/host/schema.mjs';
// @ts-ignore
import { CONTROLLER_ALLOWED, PHONE_ALLOWED, kindAllows, refuseByKind } from '../host/src/controllerRefusals.mjs';
import { servedHost } from './support/hostClientsWorld.ts';

const root = new URL('..', import.meta.url).pathname;
/** The line protocol's methods, read from the server itself: every `req.method === '…'` and the paired-only set. */
function lineMethods() {
  const text = fs.readFileSync(new URL('../host/src/server.mjs', import.meta.url), 'utf8');
  const set = /const PAIRED_ONLY = new Set\(\[([\s\S]*?)\]\);/.exec(text)?.[1] ?? '';
  return [...text.matchAll(/req\.method === '([\w.]+)'/g), ...set.matchAll(/'([\w.]+)'/g)].map((m) => m[1]);
}
const ALL = [...new Set([...Object.keys(PARSERS), ...lineMethods()])];

/** Every `.mjs`, `.ts` and `.tsx` file under `dir`, without tests, declarations and vendored code. */
function sourcesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'vendor' ? [] : sourcesUnder(full);
    return /\.(mjs|ts|tsx)$/.test(e.name) && !/\.test\.|\.d\.ts$/.test(e.name) ? [full] : [];
  });
}
/** The code of a source, comments taken out (a method named in a comment is not a call). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/**
 * The Host methods the phone's own code sends. `host.*` is the Host's own namespace, so a literal of it anywhere in the phone's sources counts; a `chat.*` name is also the Mac channel's, so only the phone's Host client (`shared/remote/phone*.mjs`) counts for those. A name held in a `*_METHOD` constant (imported from its own file) counts too.
 */
/** The Host method names a phone source sends: `host.*` anywhere, other families only from the phone's Host client, and names held in a `*_METHOD` constant. */
const namesIn = (source: string, hostClient: boolean) =>
  [
    ...new Set([
      ...[...withoutComments(source).matchAll(/['"`]((?:host|chat|fs|git|browser|desktop)\.[A-Za-z.]+)['"`]/g)].map((m) => m[1]),
      ...[...withoutComments(source).matchAll(/\b\w*METHODS?\w*\s*=\s*['"`]([A-Za-z.]+)['"`]/g)].map((m) => m[1]),
    ]),
  ].filter((n) => ALL.includes(n) && (n.startsWith('host.') || hostClient));

/** The `shared/` files the phone's sources import, transitively (a step table the phone imports names Host methods the phone then sends). */
function sharedImportedByPhone(starts: string[], base = root) {
  const shared = new Set<string>();
  const seen = new Set(starts);
  const queue = [...starts];
  const resolve = (from: string, spec: string) => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    return (
      [base, `${base}.mjs`, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')].find(
        (c) => fs.existsSync(c) && fs.statSync(c).isFile(),
      ) ?? null
    );
  };
  for (let f = queue.pop(); f; f = queue.pop()) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const r = resolve(f, m[1]);
      if (!r || seen.has(r) || !/\.(mjs|ts|tsx)$/.test(r) || !r.startsWith(base)) continue;
      seen.add(r);
      queue.push(r);
      if (r.startsWith(path.join(base, 'shared') + path.sep)) shared.add(r);
    }
  }
  return [...shared];
}

/** The phone's own sources: its Host client and everything under mobile/src. */
function phoneSources() {
  const phoneClient = fs.readdirSync(path.join(root, 'shared/remote')).filter((f) => /^phone.*\.mjs$/.test(f));
  return [...phoneClient.map((f) => path.join(root, 'shared/remote', f)), ...sourcesUnder(path.join(root, 'mobile/src'))];
}

function calledByPhone() {
  const called = new Map<string, string>();
  for (const f of phoneSources()) {
    const rel = path.relative(root, f);
    for (const n of namesIn(fs.readFileSync(f, 'utf8'), /^shared\/remote\/phone[^/]*\.mjs$/.test(rel))) called.set(n, rel);
  }
  return called;
}

/** A Host method name built by a template literal. */
const TEMPLATE_NAME = /`host\.[A-Za-z.]*\$\{/;

/** Host methods named in the shared code the phone imports (step tables, shared clients): the phone may send them, so each must be allowed; such code may also serve the Mac, so an allowed method need not be found there. */
function namedInImportedShared() {
  const named = new Map<string, string>();
  const unresolvable: string[] = [];
  for (const f of sharedImportedByPhone(phoneSources())) {
    const rel = path.relative(root, f);
    const source = fs.readFileSync(f, 'utf8');
    for (const n of namesIn(source, false)) named.set(n, rel);
    if (TEMPLATE_NAME.test(withoutComments(source))) unresolvable.push(rel);
  }
  return { named, unresolvable };
}

test('the Host methods named in the shared code the phone imports are ones a phone may send, and none is built by a template', () => {
  const { named, unresolvable } = namedInImportedShared();
  assert.ok(sharedImportedByPhone(phoneSources()).length > 20, 'the import graph is followed');
  assert.ok(named.has('host.momoGoogle'), 'the scan finds a call made by shared code');
  assert.deepEqual(
    [...named].filter(([m]) => !PHONE_ALLOWED.includes(m)),
    [],
    'shared code the phone imports names a method a phone is refused: allow it on purpose or keep it out of the phone',
  );
  assert.deepEqual(unresolvable, [], 'a Host method built by a template cannot be checked: name it in full');
});

test('a step table the phone imports is followed: its method names count, and a template-built name is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.mkdirSync(path.join(dir, 'app'));
    fs.writeFileSync(
      path.join(dir, 'shared', 'steps.mjs'),
      "import { more } from './more.mjs';\nexport const STEPS = [{ call: 'host.orgLease' }, more];\n",
    );
    fs.writeFileSync(path.join(dir, 'shared', 'more.mjs'), 'export const more = { call: `host.momo${name}` };\n');
    fs.writeFileSync(path.join(dir, 'app', 'entry.ts'), "import { STEPS } from '../shared/steps.mjs';\nexport const x = STEPS;\n");
    const imported = sharedImportedByPhone([path.join(dir, 'app', 'entry.ts')], dir)
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(imported, ['more.mjs', 'steps.mjs'], 'the import graph is followed through the shared files');
    assert.deepEqual(
      namesIn(fs.readFileSync(path.join(dir, 'shared', 'steps.mjs'), 'utf8'), false),
      ['host.orgLease'],
      'the step table names a method a phone is refused',
    );
    assert.match(fs.readFileSync(path.join(dir, 'shared', 'more.mjs'), 'utf8'), TEMPLATE_NAME);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scan sees a call by literal, through an imported constant, and not a comment or the Mac channel’s own chat.* name', () => {
  assert.deepEqual(namesIn("request('host.orgLease', p)", false), ['host.orgLease']);
  assert.deepEqual(namesIn("export const RELAY_METHOD = 'host.relayEnroll';", false), ['host.relayEnroll']);
  assert.deepEqual(namesIn("// request('host.orgLease')\n/* 'host.modelKey' */ const x = 1;", false), []);
  assert.deepEqual(namesIn("runtime.request('chat.attach', p)", false), [], 'chat.* outside the Host client is the Mac channel’s');
  assert.deepEqual(namesIn("request('chat.attach', p)", true), ['chat.attach']);
});

test('a phone may ask exactly the methods its own code sends: a new call fails here until it is allowed on purpose, and an allowed method nothing calls fails too', () => {
  const called = calledByPhone();
  assert.ok(called.has('chat.send') && called.has('host.chats') && called.has('host.momoGoogle'), 'the scan finds what the phone sends');
  // what the phone sends is what its sources name and what the shared code they import names (a step table, a shared client)
  const sent = new Set([...called.keys(), ...namedInImportedShared().named.keys()]);
  assert.deepEqual(
    [...sent].sort(),
    [...PHONE_ALLOWED].sort(),
    'PHONE_ALLOWED is what the phone sends today, no more, no less: add a method with its reasoning when the phone starts sending it, remove it when nothing does',
  );
  for (const m of PHONE_ALLOWED) assert.ok(ALL.includes(m), `${m} is not a method`);
});

test('a phone is refused every other method: what a controller may do, the machine page’s, the lease, keys, relay, schedules, sign-in, files, git, the browser and the desktop, and a method nobody decided', () => {
  const refused = ALL.filter((m) => !PHONE_ALLOWED.includes(m));
  assert.ok(refused.length > 80 && refused.includes('host.orgLease') && refused.includes('fs.read') && refused.includes('host.momoNotes'));
  for (const m of [...refused, 'host.somethingNew', 'host.codePair.offer', '']) {
    assert.throws(
      () => refuseByKind({ kind: 'phone' }, m),
      { code: 'forbidden', message: 'This phone may not do that on this machine.' },
      m,
    );
  }
  for (const m of PHONE_ALLOWED) assert.doesNotThrow(() => refuseByKind({ kind: 'phone' }, m), m);
  assert.ok(CONTROLLER_ALLOWED.length > PHONE_ALLOWED.length, 'a phone has less than a controller');
  for (const kind of ['desktop', 'cli']) for (const m of refused) assert.equal(kindAllows(kind, m), true, `${kind} ${m}`);
  assert.throws(
    () => refuseByKind({ kind: 'controller' }, 'host.modelKey'),
    { message: 'This client may not do that.' },
    'the words of the others are as they were',
  );
});

test('a served Host serves a phone its chats and refuses it everything else, with an audit line: the lease, the relay, files, git, sign-in, install, the client list', async (t) => {
  const lines: any[] = [];
  const audit = { note: (e: any) => void lines.push(e), governed: (e: any) => (lines.push(e), true) };
  const w = await servedHost(t, {}, (r) => r, { audit });
  const id = w.identity('ph');
  w.pairing.add(id.publicKey, { name: 'Phone', kind: 'phone' });
  const conn = await w.reconnect(id);
  const lease = {
    harness: 'codex',
    identity: 'me@example.com',
    token: 'tok-1234567890123456',
    expiresAt: Date.now() + 3_600_000,
    gateways: { openai: 'https://evil.example/v1' },
  };
  for (const [method, params] of [
    ['host.orgLease', lease],
    ['host.modelKey', { harness: 'claude', key: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxx' }],
    ['host.relayEnroll', { relay: 'wss://evil.example', id: 'h_x', secret: 's' }],
    ['host.login', { harness: 'claude' }],
    ['host.loginInput', { harness: 'claude', code: 'x' }],
    ['host.install', { harness: 'claude' }],
    ['host.clients', {}],
    ['host.policy', {}],
    ['host.scheduleSync', { tasks: [] }],
    ['host.clientAdd', { publicKey: 'K', kind: 'desktop' }],
    ['host.commands', {}],
    ['fs.read', { path: '/etc/hosts' }],
    ['git.status', { path: '/tmp' }],
    ['browser.open', {}],
    ['desktop.state', {}],
    ['update', {}],
  ] as const) {
    const answer = await conn.call(method, params);
    assert.equal(answer.code, 'forbidden', `${method}: ${JSON.stringify(answer).slice(0, 120)}`);
  }
  // the audit coalesces a client's refusals (one line per method, at most eight methods a minute): the first ones are there by name
  assert.deepEqual(
    lines
      .filter((l) => l.kind === 'client.refused')
      .map((l) => [l.by.kind, l.what.tool])
      .slice(0, 3),
    [
      ['phone', 'host.orgLease'],
      ['phone', 'host.modelKey'],
      ['phone', 'host.relayEnroll'],
    ],
    'a refusal is a line in the audit record',
  );
  assert.equal((await conn.call('chat.send', { chatId: 'claude:c1', epoch: 1, key: 'key-00000001', text: 'hi' })).error, undefined);
  assert.equal(w.sends.length, 1);
  for (const method of ['host.status', 'host.chats', 'host.pending', 'chat.history'])
    assert.notEqual((await conn.call(method, method === 'chat.history' ? {} : {})).code, 'forbidden', method);
});
