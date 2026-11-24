// Use this Mac's sign-in for one clone on a machine (shared/host/schema.mjs, host/src/hostGit.mjs, electron/host/macSignIn.cjs + folders.cjs, HostFolderPicker): only https, only the address's host, the secret only in the git child's environment and never in the ledger, .git/config, argv or an error (A: wrong credential, redirect to another host, older Host, ssh URL).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { createElement } from 'react';
import { render, click, type, flush } from './support/shell-chrome-kit.ts';
import { useFakeNative } from './support/ports/native.ts';
import { mockSource } from './support/stubs.ts';
// @ts-ignore: plain ESM without declarations
import { CLONE_CREDENTIAL_FEATURE, FEATURES, parseParams, requireFeatures } from '../shared/host/schema.mjs';
// @ts-ignore: plain ESM without declarations
import { HostRefusal, createHostFs } from '../host/src/hostFs.mjs';
// @ts-ignore: plain ESM without declarations
import { createHostGit, credentialLoan } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
import { cloneNeedsSignIn, folderNotice, httpsHostOf } from '../src/lib/hostFolders.ts';

const require = createRequire(import.meta.url);
const { macSignIn, httpsHost, run: readWith } = require('../electron/host/macSignIn.cjs');
const { createHostFolders } = require('../electron/host/folders.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');
const { HostError } = require('../electron/host/interface.cjs');
mockSource('src/lib/host.ts', { useHostAccess: () => true, useHostAnswered: () => true, hostAllowedNow: () => true });
const { HostFolderPicker } = await import('../src/components/composer/HostFolderPicker.tsx');

const SECRET = 'sekret-token-9f3a';
const CRED = { username: 'octo', password: SECRET };
const URL = 'https://git.example.test/org/app.git';
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clone-signin-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const root = path.join(base, 'root');
fs.mkdirSync(root, { recursive: true });
const hostFs = createHostFs({ roots: [root] });

test('the wire: a credential is https-only, bounded and clean; any clone that lends one needs the feature (older Host, ssh URL)', () => {
  const q = { key: 'attempt-001', url: URL, dest: '/home/u/app' };
  assert.deepEqual(parseParams('git.clone', { ...q, credential: { ...CRED, extra: 1 } }).credential, CRED);
  assert.equal('credential' in parseParams('git.clone', q), false);
  for (const credential of [
    'x',
    {},
    { username: 'u' },
    { username: '', password: 'p' },
    { username: 'u', password: 'a\nb' },
    { username: 'u', password: 'a'.repeat(2049) },
  ])
    assert.throws(() => parseParams('git.clone', { ...q, credential }), /cannot be used/);
  for (const url of ['git@github.com:org/app.git', 'ssh://git@host/org/app.git'])
    assert.throws(() => parseParams('git.clone', { ...q, url, credential: CRED }), /cannot be used/);
  assert.ok(FEATURES.includes(CLONE_CREDENTIAL_FEATURE));
  const older = { features: ['dedupe'] };
  requireFeatures('git.clone', older, {});
  assert.throws(
    () => requireFeatures('git.clone', older, { credential: CRED }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes(CLONE_CREDENTIAL_FEATURE),
  );
  requireFeatures('git.clone', { features: ['dedupe', CLONE_CREDENTIAL_FEATURE] }, { credential: CRED });
  requireFeatures('git.clone', older);
});

test('the loan is scoped to the address’s host: git hands the secret to that host and to no other, and it is not in argv', () => {
  const { config, env } = credentialLoan(URL, CRED);
  const args = config.flatMap((c: string) => ['-c', c]);
  const fill = (host: string) =>
    execFileSync('git', [...args, 'credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { PATH: process.env.PATH, HOME: base, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...env },
      encoding: 'utf8',
    });
  assert.match(fill('git.example.test'), new RegExp(`username=octo\\npassword=${SECRET}`));
  // a redirect elsewhere (another host, a lookalike) gets nothing: with prompts off, git fails to fill
  assert.throws(() => fill('other.example.test'));
  assert.throws(() => fill('git.example.test.evil.test'));
  assert.equal(JSON.stringify(config).includes(SECRET), false);
  assert.deepEqual(credentialLoan('https://h.test:8443/a.git', CRED).config[1].split('.helper')[0], 'credential.https://h.test:8443');
});

/** A git whose clone makes its folder (or fails with `fail`); every command and environment it was given is kept. */
function git(fail?: string) {
  const runs: { args: string[]; env?: Record<string, string> }[] = [];
  const run = async (args: string[], opts: { env?: Record<string, string>; onLine?: (l: string) => void } = {}) => {
    runs.push({ args, env: opts.env });
    if (args.includes('clone')) {
      if (fail) return { ok: false, stdout: '', stderr: fail };
      fs.mkdirSync(args[args.length - 1], { recursive: true });
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { run, runs };
}

test('the secret reaches only the clone’s child environment: not argv, the ledger, the result, or a failure’s text', async () => {
  const dir = path.join(base, 'ledger-ok');
  const g = git();
  const host = createHostGit({ hostFs, run: g.run as any, ledger: createLedger(dir, { report: () => undefined }) });
  const dest = path.join(root, 'ok');
  const done = await host.clone({ key: 'attempt-001', url: URL, dest, credential: CRED });
  await host.clone({ key: 'attempt-007', url: URL, dest: path.join(root, 'onbranch'), branch: 'main', credential: CRED });
  assert.ok(g.runs.some((r) => r.args.includes('--branch=main') && r.args[0] === '-c'));
  assert.equal(done.existed, false);
  const clone = g.runs.find((r) => r.args.includes('clone'))!;
  assert.equal(clone.env?.MOPILOT_GIT_SECRET, SECRET);
  assert.equal(clone.args.join('\n').includes(SECRET), false, 'not in argv');
  assert.deepEqual(clone.args.slice(0, 4), [
    '-c',
    'credential.helper=',
    '-c',
    'credential.https://git.example.test.helper=' + clone.args[3].split('.helper=')[1],
  ]);
  assert.equal(clone.args.includes(URL), true, 'the address is the plain one');
  // a clone without a credential sets neither a helper nor an environment
  await host.clone({ key: 'attempt-002', url: URL, dest: path.join(root, 'plain') });
  const plain = g.runs.filter((r) => r.args.includes('clone'))[2];
  assert.equal(plain.env, undefined);
  assert.equal(plain.args[0], 'clone');
  // a failure that quotes the secret is scrubbed before it becomes the refusal, the ledger entry and the wire text
  const bad = createHostGit({
    hostFs,
    run: git(`remote: Invalid password ${SECRET}`).run as any,
    ledger: createLedger(path.join(base, 'ledger-bad'), { report: () => undefined }),
  });
  await assert.rejects(
    bad.clone({ key: 'attempt-003', url: URL, dest: path.join(root, 'bad'), credential: CRED }),
    (e: any) => e instanceof HostRefusal && e.code === 'clone_failed' && !e.message.includes(SECRET) && e.message.includes('***'),
  );
  const files = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...files(dir), ...files(path.join(base, 'ledger-bad'))])
    assert.equal(fs.readFileSync(f, 'utf8').includes(SECRET), false, f);
  // a failure that does not quote it keeps git's own words
  const plainFail = createHostGit({ hostFs, run: git('fatal: Authentication failed').run as any });
  await assert.rejects(
    plainFail.clone({ key: 'attempt-004', url: URL, dest: path.join(root, 'f2'), credential: CRED }),
    /Authentication failed/,
  );
  const empty = createHostGit({ hostFs, run: git(' ').run as any });
  await assert.rejects(empty.clone({ key: 'attempt-005', url: URL, dest: path.join(root, 'f3'), credential: CRED }), /The clone failed\./);
});

test('real git: a clone with the loan leaves the secret out of .git/config and the address', { skip: !hasGit() }, async () => {
  const src = path.join(base, 'src');
  fs.mkdirSync(src);
  const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  sh(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'f'), 'x');
  sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'f');
  sh(src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
  const host = createHostGit({ hostFs });
  // a local path address is not https: the schema refuses a credential for it, and the Host never builds a loan from one
  assert.throws(() => credentialLoan(src, CRED));
  const done = await host.clone({ key: 'attempt-006', url: src, dest: path.join(root, 'real') });
  const config = fs.readFileSync(path.join(done.path, '.git', 'config'), 'utf8');
  assert.equal(config.includes(SECRET), false);
});
function hasGit() {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

test('this Mac’s sign-in: git credential fill for exactly the host, else gh; none, a failure or a non-https address is no sign-in', async () => {
  const seen: { read: string; host?: string; input?: string }[] = [];
  const exec =
    (answers: Record<string, string | null>) =>
    async (read: string, o: { input?: string; host?: string } = {}) => {
      seen.push({ read, input: o.input, host: o.host });
      return answers[read] ?? null;
    };
  assert.deepEqual(await macSignIn(URL, { run: exec({ fill: 'protocol=https\nhost=git.example.test\nusername=octo\npassword=pw\n' }) }), {
    username: 'octo',
    password: 'pw',
  });
  assert.equal(seen[0].input, 'protocol=https\nhost=git.example.test\n\n');
  assert.equal(seen[0].read, 'fill');
  seen.length = 0;
  assert.deepEqual(
    await macSignIn('https://github.com:8443/a/b.git', { run: exec({ fill: 'username=\npassword=\n', token: 'ghp_tok\n' }) }),
    {
      username: 'x-access-token',
      password: 'ghp_tok',
    },
  );
  assert.deepEqual(seen[1], { read: 'token', input: undefined, host: 'github.com' });
  assert.equal(await macSignIn(URL, { run: exec({}) }), null);
  assert.equal(await macSignIn(URL, { run: exec({ token: '  \n' }) }), null);
  for (const url of ['git@github.com:a/b.git', 'ssh://git@h/a', 'http://h.test/a', 'https://u:p@h.test/a', 'nonsense', '/local/path'])
    assert.equal(await macSignIn(url, { run: async () => assert.fail('must not read a sign-in') }), null, url);
  assert.equal(httpsHost('https://h.test:9/a'), 'h.test:9');
  assert.equal(httpsHost('http://h.test/a'), null);
});

test('the reader runs its command with the input on stdin and answers its output, or null when it fails', async () => {
  const node = (code: string) => () => [process.execPath, ['-e', code]] as [string, string[]];
  const reads = { fill: node('process.stdin.pipe(process.stdout)'), token: node('process.exit(3)') };
  assert.equal(await readWith('fill', { input: 'protocol=https\n' }, reads), 'protocol=https\n');
  assert.equal(await readWith('token', {}, reads), null);
  // enterprise tokens in this Mac's environment are never offered to a read (gh answers them for any host)
  process.env.GH_ENTERPRISE_TOKEN = 'ent-token';
  process.env.GITHUB_ENTERPRISE_TOKEN = 'ent-token';
  try {
    const seen = await readWith(
      'fill',
      {},
      {
        ...reads,
        fill: node(
          'process.stdout.write(String(process.env.GH_ENTERPRISE_TOKEN) + String(process.env.GITHUB_ENTERPRISE_TOKEN) + process.env.GIT_TERMINAL_PROMPT)',
        ),
      },
    );
    assert.equal(seen, 'undefinedundefined0');
  } finally {
    delete process.env.GH_ENTERPRISE_TOKEN;
    delete process.env.GITHUB_ENTERPRISE_TOKEN;
  }
  // a missing program is no answer, not a crash
  assert.equal(await readWith('fill', {}, { ...reads, fill: () => ['/nonexistent/tool', []] }), null);
  // an answer without a user name or secret falls through to the next source
  const calls: string[] = [];
  const exec = async (read: string) => (calls.push(read), read === 'fill' ? 'protocol=https\nhost=h.test\n' : null);
  assert.equal(await macSignIn(URL, { run: exec as any }), null);
  assert.deepEqual(calls, ['fill', 'token']);
});

test('the real reader fails closed: a missing tool, and a command that finishes, are read without prompting', async () => {
  const saved = process.env.PATH;
  process.env.PATH = base; // neither git nor gh is found
  try {
    assert.equal(await macSignIn(URL), null);
  } finally {
    process.env.PATH = saved;
  }
  if (hasGit()) await macSignIn('https://sign-in.invalid/a.git'); // git answers (nothing) or fails; either way it returns without a prompt
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-folders-')), 'host-ownership.json');
function service(found: { username: string; password: string } | null) {
  const calls: any[] = [];
  const folders = createHostFolders({
    open: async () => ({
      call: async (method: string, params: any) => (calls.push({ method, params }), { path: '/home/u/app', existed: false }),
      close: () => undefined,
    }),
    store: new OwnershipStore(tmpFile()),
    macSignIn: async (u: string) => (u === URL ? found : null),
  });
  return { folders, calls };
}

test('main lends the sign-in only when asked, and answers with the folder, never the credential; none means nothing is sent', async () => {
  const q = { key: 'attempt-001', url: URL, dest: '/home/u/app' };
  const s = service(CRED);
  const placed = await s.folders.clone('box', { ...q, useMacSignIn: true });
  assert.deepEqual(placed, { path: '/home/u/app', existed: false });
  assert.deepEqual(s.calls[0].params.credential, CRED);
  assert.equal(JSON.stringify(placed).includes(SECRET), false);
  await s.folders.clone('box', { ...q, key: 'attempt-002' });
  assert.equal('credential' in s.calls[1].params, false, 'no click, no sign-in');
  assert.equal('useMacSignIn' in s.calls[1].params, false);
  const none = service(null);
  await assert.rejects(
    none.folders.clone('box', { ...q, useMacSignIn: true }),
    (e: any) => e instanceof HostError && e.code === 'no_mac_signin',
  );
  assert.equal(none.calls.length, 0);
  // the default reader is main's own (this Mac): a non-https address has none, whatever is installed
  const dflt = createHostFolders({ open: async () => assert.fail('no connection'), store: new OwnershipStore(tmpFile()) });
  await assert.rejects(dflt.clone('box', { ...q, url: 'git@github.com:a/b.git', useMacSignIn: true }), /no sign-in/);
  await assert.rejects(dflt.clone('box', { ...q, url: undefined, useMacSignIn: true }), /not one Git can clone/);
});

test('the notices: an older Host says to update, no sign-in says so, and only an https sign-in failure offers the button', () => {
  const err = (m: string, code: string) => Object.assign(new Error(m), { code });
  assert.equal(
    folderNotice(err('The host cannot do this safely yet (it lacks cloneCredential). Update it.', 'feature_missing')),
    'Update Host on that machine to use this Mac’s sign-in.',
  );
  assert.equal(folderNotice(err('x', 'no_mac_signin')), 'This Mac has no sign-in for that address.');
  assert.equal(folderNotice(err('other lack', 'feature_missing')), 'other lack');
  assert.equal(cloneNeedsSignIn(err('fatal: Authentication failed', 'clone_failed')), true);
  assert.equal(cloneNeedsSignIn(err('fatal: Could not resolve host', 'clone_failed')), false);
  assert.equal(cloneNeedsSignIn(err('Authentication failed', 'other')), false);
  assert.equal(cloneNeedsSignIn(null), false);
  assert.equal(httpsHostOf(' https://github.com/a/b '), 'github.com');
  assert.equal(httpsHostOf('git@github.com:a/b'), '');
  assert.equal(httpsHostOf('http://x.test/a'), '');
});

const HOME = { path: '/home/u', roots: ['/home/u'], entries: [] };
const refused = (message: string, code: string) => ({ error: { message, code } });
const button = (host: Element, label: string) =>
  [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(label)) as HTMLButtonElement | undefined;
const field = (host: Element, label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const notice = (host: Element) => host.querySelector('.host-picker-notice')?.textContent ?? '';

test('the picker: a sign-in failure on https offers this Mac’s sign-in; the click is the consent, with a new key; none on the Mac says so with no button', async (t) => {
  const asked: any[] = [];
  let next: any = refused("fatal: could not read Username for 'https://git.example.test': terminal prompts disabled", 'clone_failed');
  useFakeNative(t, {
    host: {
      fsList: async () => ({ value: HOME }),
      onCloneProgress: () => () => undefined,
      clone: async (_id: string, q: any) => (asked.push(q), next),
    },
  });
  const picked: string[] = [];
  const { host, unmount } = await render(
    createElement(HostFolderPicker, { hostId: 'box', name: 'box', onPick: (p: string) => picked.push(p), onClose: () => undefined }),
  );
  await flush();
  await click(button(host, 'Clone repository…')!);
  await type(field(host, 'Repository address'), URL);
  await click(button(host, 'Clone')!);
  await flush();
  assert.equal(notice(host), 'This machine can’t sign in to that repository.');
  assert.ok(button(host, 'Use this Mac’s sign-in'));
  assert.match(host.querySelector('.host-picker-signin')?.textContent ?? '', /Used once, not saved on the machine\./);
  assert.equal(asked[0].useMacSignIn, undefined, 'the first attempt borrows nothing');
  // this Mac has none: one line, and the button is gone
  next = refused('This Mac has no sign-in for that address.', 'no_mac_signin');
  await click(button(host, 'Use this Mac’s sign-in')!);
  await flush();
  assert.equal(asked[1].useMacSignIn, true);
  assert.notEqual(asked[1].key, asked[0].key, 'a retry with the sign-in is a new attempt');
  assert.equal(notice(host), 'This Mac has no sign-in for that address.');
  assert.equal(button(host, 'Use this Mac’s sign-in'), undefined);
  // a new clone attempt that works hands the folder back, and no offer remains
  next = { value: { path: '/home/u/app', existed: false } };
  await click(button(host, 'Clone')!);
  await flush();
  assert.deepEqual(picked, ['/home/u/app']);
  assert.equal(button(host, 'Use this Mac’s sign-in'), undefined);
  await unmount();
});

test('the picker: no offer for an ssh address or for a failure that is not a sign-in', async (t) => {
  let next: any = refused('Permission denied (publickey).', 'clone_failed');
  useFakeNative(t, {
    host: { fsList: async () => ({ value: HOME }), onCloneProgress: () => () => undefined, clone: async () => next },
  });
  const { host, unmount } = await render(
    createElement(HostFolderPicker, { hostId: 'box', name: 'box', onPick: () => undefined, onClose: () => undefined }),
  );
  await flush();
  await click(button(host, 'Clone repository…')!);
  await type(field(host, 'Repository address'), 'git@github.com:org/app.git');
  await click(button(host, 'Clone')!);
  await flush();
  assert.equal(button(host, 'Use this Mac’s sign-in'), undefined, 'ssh keys are never lent');
  next = refused('fatal: unable to access x: Could not resolve host: x', 'clone_failed');
  await type(field(host, 'Repository address'), URL);
  await click(button(host, 'Clone')!);
  await flush();
  assert.equal(button(host, 'Use this Mac’s sign-in'), undefined);
  await unmount();
});

test('a failed GitHub clone keeps the form while giving Host update instructions and allowing an explicit retry', async (t) => {
  const asked: any[] = [];
  let result: any = refused('fatal: Authentication failed', 'clone_failed');
  const api = useFakeNative(t, {
    host: {
      fsList: async () => ({ value: HOME }),
      onCloneProgress: () => () => undefined,
      signin: async (hostId: string, harness: string, recoveryKey: string) => ({
        hostId,
        harness,
        state: 'failed',
        reason: 'host_update',
        recoveryKeys: [recoveryKey],
      }),
      clone: async (_id: string, p: any) => {
        asked.push(p);
        return result;
      },
    },
  });
  const ui = await render(
    createElement(HostFolderPicker, { hostId: 'ssh:box', name: 'Build box', onPick: () => undefined, onClose: () => undefined }),
  );
  t.after(() => ui.unmount());
  await click(button(ui.host, 'Clone repository…')!);
  await type(field(ui.host, 'Repository address'), 'https://github.com/org/private');
  await click(button(ui.host, 'Clone')!);
  assert.ok(button(ui.host, 'Sign in to GitHub'));
  assert.match(ui.host.querySelector('[data-git-signin-note]')?.textContent ?? '', /github.com on Build box/);
  await click(button(ui.host, 'Sign in to GitHub')!);
  const card = ui.host.querySelector('[data-git-signin-note]')!;
  assert.match(card.textContent!, /Build box in Settings › Connections › Control other devices/);
  assert.ok(button(card, 'Try sign-in after updating'));
  assert.equal(button(card, 'My machines'), undefined, 'the clone form stays open');
  assert.deepEqual(api.callsTo('host.update'), []);
  assert.equal(field(ui.host, 'Repository address').value, 'https://github.com/org/private');
  assert.equal(asked.length, 1, 'recovering sign-in never replays the clone');
  assert.equal(asked[0].useMacSignIn, undefined);
  result = { value: { path: '/home/u/private', existed: false } };
  await click(button(ui.host, 'Clone')!);
  assert.notEqual(asked[0].key, asked[1].key);
  assert.equal(asked[1].useMacSignIn, undefined);
});
