// Where MoMo's Google tokens may live and where they may not: only the named files touch them, none logs or exposes one, at rest they are only in the home's data-key files (which travel and are wiped), and the device never holds one (it hands the home a one-time code, sealed to the home's key).
// The two source scans are LEXICAL: they read words and import paths, so they catch a token named in a new place, a log, a process or a forbidden import, and they cannot catch a computed key (a.tokens['refresh' + 'Token'], Object.values(a.tokens)), an alias made elsewhere or a value passed along without a name. The runtime tests below (a Google that echoes the token, every file at rest, the wire) are what cover those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMomoGoogle } from '../host/src/momoGoogle.mjs';
import { composeGoogle } from '../shared/momoGoogle/compose.mjs';
import { sealHandoff } from '../shared/momoGoogle/handoff.mjs';
import { signInToGoogle } from '../shared/momoGoogle/signIn.mjs';
import { READ_SCOPES } from '../shared/momoGoogle/types.mjs';
import { idToken } from './support/fakeGoogle.ts';
import { fakeCatcher, homeWorld, sealer } from './support/momoGoogleHostKit.ts';

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tracked = (...specs: string[]) =>
  execFileSync('git', ['ls-files', '--', ...specs], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

/** What a Google token is called in code. */
const TOKEN_WORDS = /\b(accessToken|refreshToken|access_token|refresh_token|id_token|idToken)\b/;
const isSource = (f: string) => /\.(mjs|cjs|js|jsx|mts|cts|ts|tsx)$/.test(f) && !/\.d\.(mts|cts|ts)$/.test(f);
const GOOGLE_WORDS = /momoGoogle|googleapis|gmail|google-auth|accounts\.google|oauth2\.google/i;
/** The folders that hold the app's source. */
const SOURCE_DIRS = ['host', 'shared', 'electron', 'mobile/src', 'src'];

/** The files that hold or touch a Google token, each with why. A new one needs a reason here. */
const TOKEN_FILES: Record<string, string> = {
  'shared/momoGoogle/account.mjs': 'the account: the sealed record, the single-flight refresh and the revoke',
  'shared/momoGoogle/consent.mjs': "the home's half of the sign-in: exchanges the one-time code and hands the tokens to the account",
  'shared/momoGoogle/client.mjs': 'the read client: puts the short-lived access token on one Google request',
  'shared/momoGoogle/send.mjs': 'the send step: the same access token, spent only with a gate-minted single-use grant',
  'host/src/momoGoogle.mjs':
    'the Host holder: builds the account on the home and, for a move check, seeds placeholder values no Google has seen',
};
/** Files that name a token word and Google for another reason, each with why: none of them holds one of MoMo's Google tokens. */
const UNRELATED: Record<string, string> = {
  'shared/browser.mjs':
    'the browser pane’s sign-in page detector: it lists accounts.google.com as a sign-in host and id_token as a callback parameter name to hide, nothing more',
  'electron/momo/connectors/hub.cjs':
    'the connector hub of the older per-connector tokens (the vault): it runs a tool with that connector’s own access token and never holds one of the Google connector’s',
};
/** The device's half of the sign-in: it never sees a token, only the one-time code it seals to the home. */
const DEVICE_FILES = [
  'shared/momoGoogle/signIn.mjs',
  'shared/momoGoogle/handoff.mjs',
  'shared/momoGoogle/seal.mjs',
  'shared/momoGoogle/intents.mjs',
  'shared/momoGoogle/view.mjs',
  'shared/momoGoogle/compose.mjs',
  'shared/momoGoogle/state.mjs',
  'electron/momo/googleCatcher.cjs',
  'mobile/src/momo/googleCatcher.ts',
  'mobile/src/momo/googleSignIn.ts',
];
/** The modules of shared/momoGoogle that hold no token and may be imported from anywhere (the device files in that folder, and the pure ones). */
const SAFE_MODULES = new Set([
  ...DEVICE_FILES.filter((f) => f.startsWith('shared/momoGoogle/')).map((f) => path.basename(f)),
  'types.mjs',
  'clientConfig.mjs',
  'errors.mjs',
  'store.mjs',
]);
/** Who may import a module of shared/momoGoogle that is not safe: the Host's Google service is the one door. */
const DOOR = 'host/src/momoGoogle.mjs';

/** What a Google token holder may not reach (a log, a process, a direct file write). */
const FORBIDDEN_USE = [
  [/\bconsole\./, 'a console'],
  [/process\.(stdout|stderr|argv)/, 'the process streams or argv'],
  [/\bchild_process\b/, 'a child process'],
  [/\b(writeFileSync|appendFile|appendFileSync)\b/, 'a direct file write'],
] as const;
/** The module a path names, without folders or extension: the audit, push, notice, gate, chat or task modules a holder may not import. */
const FORBIDDEN_IMPORT = /^(momo(Audit|Push|Notice|Gate|Rows|Chats|Daily|Scheduler|Tasks)|audit|push|approvalGate)/i;

/** The source without its comments, so a word in a comment is not taken for a use. */
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1');
const importsOf = (text: string) =>
  [...stripComments(text).matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|export\s+\*\s+from\s+)['"]([^'"]+)['"]/g)].map(
    (m) => m[1] as string,
  );
const stemOf = (spec: string) => path.basename(spec).replace(/\.[cm]?[jt]sx?$/, '');

/** The files (path → text) that name a token and have to do with Google but are not a listed holder or an explained unrelated file. */
const unlistedTouching = (files: Record<string, string>) =>
  Object.keys(files).filter(
    (f) =>
      isSource(f) &&
      TOKEN_WORDS.test(files[f] as string) &&
      GOOGLE_WORDS.test(`${f}\n${files[f]}`) &&
      !(f in TOKEN_FILES) &&
      !(f in UNRELATED),
  );
/** The files that import a module of shared/momoGoogle that holds a token (a barrel in that folder counts, it is not safe) without being the door or in that folder. */
const wrongImporters = (files: Record<string, string>) =>
  Object.keys(files).filter(
    (f) =>
      isSource(f) &&
      f !== DOOR &&
      !f.startsWith('shared/momoGoogle/') &&
      importsOf(files[f] as string).some((s) => /momoGoogle\//.test(s) && !SAFE_MODULES.has(path.basename(s))),
  );
/** What a holder does that it may not: its uses, then its imports. */
const forbiddenIn = (text: string) => {
  const code = stripComments(text);
  return [
    ...FORBIDDEN_USE.filter(([re]) => re.test(code)).map(([, what]) => `uses ${what}`),
    ...importsOf(text)
      .filter((s) => FORBIDDEN_IMPORT.test(stemOf(s)))
      .map((s) => `imports ${s}`),
  ];
};
const sourcesOfApp = () =>
  Object.fromEntries(
    tracked(...SOURCE_DIRS)
      .filter(isSource)
      .map((f) => [f, read(f)]),
  );

test('only the named files touch Google tokens, and every one of them says why', () => {
  const app = sourcesOfApp();
  assert.deepEqual(
    unlistedTouching(app),
    [],
    'a new place that names a Google token: keep the token in the files below, or add it to TOKEN_FILES with a reason',
  );
  for (const f of [...Object.keys(TOKEN_FILES), ...Object.keys(UNRELATED)])
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is listed but gone`);
  // every module of the Google folder is a holder or a known safe one: a new file has to be put in one list, with its reason
  for (const f of tracked('shared/momoGoogle').filter(isSource))
    assert.ok(f in TOKEN_FILES || SAFE_MODULES.has(path.basename(f)), `${f} is in neither TOKEN_FILES nor the safe modules`);
  // nothing else imports a holder, however it is reached (a barrel in the folder is not safe): the Host's Google service is the one door
  assert.deepEqual(wrongImporters(app), []);
  // and the device-side files have none at all
  for (const f of DEVICE_FILES) assert.doesNotMatch(read(f), TOKEN_WORDS, `${f} is the device's half: it must never name a Google token`);
});

test('none of the holders logs, starts a process, writes a file directly or reaches the audit, push, notice or chat lanes', () => {
  for (const f of Object.keys(TOKEN_FILES))
    assert.deepEqual(
      forbiddenIn(read(f)),
      [],
      `${f} must not log, start a process, write a file or import an audit, push, notice or chat module`,
    );
  // the only thing the Host reports is an error's own message, never a record or a token
  for (const line of read('host/src/momoGoogle.mjs')
    .split('\n')
    .filter((l) => /\breport\(/.test(l) && !/report = |report:|@param/.test(l)))
    assert.match(line, /\.message/, `a report line must carry only an error's message: ${line.trim()}`);
  // the device's files do not write anything anywhere: no file, no app storage
  for (const f of DEVICE_FILES)
    assert.doesNotMatch(read(f), /writeFile|localStorage|AsyncStorage|SecureStore|MMKV|fs\./, `${f} keeps nothing on the device`);
});

test('the scans catch the bypasses a review found, do not trip on words in comments, and say what they cannot see', () => {
  const leak = 'const t = account.tokens.refreshToken; // gmail';
  // caught: a connectors folder is not blanket-exempt, a source of any extension is read, a barrel in the Google folder is not a safe door
  assert.deepEqual(unlistedTouching({ 'host/src/connectors/leak.mjs': leak }), ['host/src/connectors/leak.mjs']);
  for (const ext of ['mts', 'cts', 'jsx']) assert.deepEqual(unlistedTouching({ [`host/src/x.${ext}`]: leak }), [`host/src/x.${ext}`]);
  assert.deepEqual(unlistedTouching({ 'host/src/x.d.mts': leak }), [], 'declarations are not source');
  assert.deepEqual(unlistedTouching({ 'electron/momo/connectors/hub.cjs': leak }), [], 'the one explained connector file is allowed');
  assert.deepEqual(wrongImporters({ 'host/src/x.mjs': "export * from '../../shared/momoGoogle/index.mjs'" }), ['host/src/x.mjs']);
  assert.deepEqual(wrongImporters({ 'host/src/x.mjs': "import { A } from '../../shared/momoGoogle/account.mjs'" }), ['host/src/x.mjs']);
  assert.deepEqual(wrongImporters({ 'host/src/x.mjs': "import('../../shared/momoGoogle/send.mjs')" }), ['host/src/x.mjs']);
  assert.deepEqual(wrongImporters({ [DOOR]: "import { A } from '../../shared/momoGoogle/account.mjs'" }), [], 'the door may');
  assert.deepEqual(
    wrongImporters({ 'host/src/x.mjs': "import { A } from '../../shared/momoGoogle/view.mjs'" }),
    [],
    'a device module is safe to import',
  );
  assert.deepEqual(forbiddenIn('console.log(1)'), ['uses a console']);
  assert.deepEqual(forbiddenIn("import x from './momoAudit.mjs'"), ['imports ./momoAudit.mjs']);
  assert.deepEqual(forbiddenIn("import x from '../push.cjs'"), ['imports ../push.cjs']);
  // not caught, and not to be: a word in a comment, a module that only contains the letters
  assert.deepEqual(forbiddenIn('// console.log(1)\n/* process.argv */\nconst a = 1;'), []);
  assert.deepEqual(forbiddenIn("import x from './rowsOf.mjs'"), [], 'only the listed names start a forbidden module');
  assert.deepEqual(forbiddenIn("import x from '../../shared/relaunchPushes/x.mjs'"), [], 'only the module itself is matched, not a folder');
  // documented, not caught: the scans are lexical, so a computed key or a bulk read is invisible to them (the runtime tests are what cover those)
  const invisible = "const t = a.tokens['refresh' + 'Token']; const all = Object.values(a.tokens);";
  assert.deepEqual(unlistedTouching({ 'host/src/x.mjs': `${invisible} // gmail` }), []);
});

const ACCESS = 'ACCESS-SECRET-7f3a9c';
const REFRESH = 'REFRESH-SECRET-7f3a9c';
const everyFile = (dir: string, out: string[] = []): string[] => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) everyFile(p, out);
    else out.push(p);
  }
  return out;
};

async function rig(t: { after(f: () => void): void }) {
  const said: string[] = [];
  const w = await homeWorld(t, {
    token: () => ({
      body: {
        access_token: ACCESS,
        refresh_token: REFRESH,
        expires_in: 3600,
        scope: READ_SCOPES.join(' '),
        id_token: idToken('me@example.com'),
      },
    }),
    // a Google that echoes the bearer token into its error text, the worst case for a leak into a message
    gmail: (r) =>
      r.path.includes('/calendar/')
        ? {
            status: 403,
            body: {
              error: {
                code: 403,
                message: `Bearer ${ACCESS} refresh ${REFRESH} was refused`,
                errors: [{ reason: 'insufficientPermissions' }],
              },
            },
          }
        : {
            status: 500,
            body: { error: { code: 500, message: `Bearer ${ACCESS} refresh ${REFRESH} broke`, errors: [{ reason: 'backendError' }] } },
          },
  });
  const guarded = ((url: string, init: any) =>
    w.fake.fetch(url === 'https://oauth2.googleapis.com/revoke' ? `${w.fake.url}/revoke` : url, init)) as typeof fetch;
  const google = createMomoGoogle({
    home: w.home,
    fetch: guarded,
    now: w.clock.now,
    report: (m) => said.push(m),
    sleep: async () => undefined,
    oauth: { authUri: `${w.fake.url}/auth`, tokenUri: `${w.fake.url}/token`, revokeUri: `${w.fake.url}/revoke` },
    endpoints: { gmail: `${w.fake.url}/`, calendar: `${w.fake.url}/` },
  });
  w.home.provide('google', google);
  w.home.use('google', { start: () => undefined, pause: () => google.pause(), wipe: () => google.wipe() });
  await google.configure({ desktopJson: w.json });
  const host = { call: (op: string, p: object = {}) => (google as any)[op]({ op, ...p }) };
  return { w, google, host, said };
}
const leaks = (text: string) => text.includes(ACCESS) || text.includes(REFRESH);

test('no token reaches a message, a state, a view or an error, even from a Google that echoes it', async (t) => {
  const { w, google, host, said } = await rig(t);
  const heard: string[] = [];
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    const was = console[k];
    console[k] = (...a: unknown[]) => void heard.push(a.map(String).join(' '));
    t.after(() => (console[k] = was));
  }
  const out = await signInToGoogle({ host, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' });
  assert.equal(out.ok, true);
  // a read that Google refuses with a body full of the token: the error that comes out is Google's reason, not its text
  const reader = await google.reader();
  assert.deepEqual(Object.keys(reader).sort(), ['client', 'versions'], 'the reader hands out a client and cursors, never the account');
  const errors: string[] = [];
  const client = reader.client as any;
  // Gmail answers 500 with the token in its text (a GoogleApiError); Calendar answers a scope refusal with it (the grant ends, in fixed words)
  for (const run of [
    () => client.listThreads({ afterMs: 0, beforeMs: w.clock.at, maxResults: 5 }),
    () => client.getMail('t1'),
    () => client.getThreadMeta('t1'),
    () => client.calendarEtag(),
  ])
    await run().catch((e: Error) => errors.push(`${e?.name} ${e?.message} ${JSON.stringify(e)}`));
  assert.equal(errors.length, 4, 'Google refused every read, in both ways');
  assert.match(errors.join('\n'), /backendError|500/);
  assert.match(errors.join('\n'), /AccountError|sign/i);
  const shown = [
    ...errors,
    ...said,
    ...heard,
    JSON.stringify(await google.status()),
    JSON.stringify(await composeGoogle({ call: async (_m, p: any) => (google as any)[p.op](p) })),
    JSON.stringify(out),
  ];
  for (const s of shown) assert.ok(!leaks(s), `a token reached: ${s.slice(0, 120)}`);
  // a refused hand-over and a refused client are worded without the token too
  const words: string[] = [];
  await google.complete({ flowId: 'x'.repeat(16), sealed: 'zz' }).catch((e: Error) => words.push(`${e.message}`));
  await google.configure({ desktopJson: w.json }).catch((e: Error) => words.push(`${e.message}`));
  for (const s of words) assert.ok(!leaks(s));
  assert.ok(w.fake.requests.length > 0);
});

test('at rest the tokens are only in files of the home folder sealed with the data key, never in the clear, and a disconnect or a reset takes them away', async (t) => {
  const { w, google, host } = await rig(t);
  assert.equal(
    (await signInToGoogle({ host, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' })).ok,
    true,
  );
  await (await google.reader()).versions.set('gmail:t1', 'v1');
  await google.pause();

  const seen = everyFile(w.dir).filter(
    (f) => fs.readFileSync(f).toString('latin1').includes(ACCESS) || fs.readFileSync(f).toString('latin1').includes(REFRESH),
  );
  assert.deepEqual(seen, [], 'no file anywhere under the Host data or config folder holds a token in the clear');
  // the files Google keeps are in the home's folder, are the shared sealed envelope, and open with the DATA key (the one a move carries)
  const mine = everyFile(path.join(w.momoDir, 'google'));
  assert.deepEqual(mine.map((f) => path.basename(f)).sort(), ['google-account.sealed', 'google-clients.sealed', 'google-versions.sealed']);
  for (const f of mine) {
    const env = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.equal(env.enc, 'safe', f);
    JSON.parse(w.home.data.safeStorage.decryptString(Buffer.from(env.data, 'base64')));
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${f} is owner-only`);
  }
  const account = JSON.parse(
    w.home.data.safeStorage.decryptString(
      Buffer.from(JSON.parse(fs.readFileSync(path.join(w.momoDir, 'google', 'google-account.sealed'), 'utf8')).data, 'base64'),
    ),
  );
  assert.equal(account.tokens.refreshToken, REFRESH, 'what the sealed file holds is the real token: the check above is not vacuous');

  // remove: the account is gone from disk, and Google was told to revoke
  await google.disconnect();
  assert.equal(fs.existsSync(path.join(w.momoDir, 'google', 'google-account.sealed')), false);
  assert.ok(
    w.fake.requests.some((r) => r.path === '/revoke'),
    'the grant was revoked at Google',
  );

  // reset: connect again, then Reset MoMo takes every Google file with the rest
  assert.equal(
    (await signInToGoogle({ host, startCatcher: fakeCatcher(() => ({ code: 'c' })), sealer, purpose: 'read', client: 'desktop' })).ok,
    true,
  );
  await w.home.reset();
  assert.deepEqual(
    fs.existsSync(path.join(w.momoDir, 'google')) ? everyFile(path.join(w.momoDir, 'google')) : [],
    [],
    'Reset leaves no Google file',
  );
});

test('the device hands the home only a one-time code, sealed to the home, over the Host method; it keeps nothing and sees no token', async (t) => {
  const { w, google } = await rig(t);
  const calls: { op: string; params: any }[] = [];
  const host = {
    call: async (op: string, params: object = {}) => {
      calls.push({ op, params });
      return (google as any)[op]({ op, ...params });
    },
  };
  let closed = 0;
  const catcher = fakeCatcher(() => ({ code: 'the-one-time-code' }));
  const out = await signInToGoogle({
    host,
    startCatcher: async () => {
      const c = await catcher();
      return { ...c, close: () => void closed++ };
    },
    sealer,
    purpose: 'read',
    client: 'desktop',
  });
  assert.equal(out.ok, true);
  assert.equal(closed, 1, 'the catcher is closed once the home has answered');
  // what the device said to the home: the begin, then ONE complete whose only payload is the sealed box
  assert.deepEqual(
    calls.map((c) => c.op),
    ['begin', 'complete'],
  );
  const complete = calls[1]?.params as { flowId: string; sealed: string };
  assert.deepEqual(Object.keys(complete).sort(), ['flowId', 'sealed']);
  for (const s of [JSON.stringify(calls), JSON.stringify(out)]) {
    assert.ok(!s.includes('the-one-time-code'), 'the code is not in the clear on the wire');
    assert.ok(!leaks(s), 'and no token passed through the device');
  }
  // sealed for the home: a box made for another key is refused and the flow still stands for the right one
  const begun = await google.begin({ purpose: 'read', client: 'desktop', redirectUri: 'http://127.0.0.1:53682/callback' });
  const state = new URL(begun.authUrl).searchParams.get('state') as string;
  const forged = sealHandoff(sealer, begun.flowId, sealer.generateKeyPair().publicKey, {
    state,
    redirectUri: 'http://127.0.0.1:53682/callback',
    code: 'c',
  });
  await assert.rejects(google.complete({ flowId: begun.flowId, sealed: forged }));
  // only an owner's granted client may call the Host method at all
  const lane = (await import('../host/src/methods/momoGoogle.mjs')).default({ momo: w.home as never });
  const veil = lane.veils['host.momoGoogle'] as (principal: unknown) => boolean;
  assert.equal(veil(null), false, 'a stranger gets nothing');
  // a principal that is present but is not one of the owner's devices is refused too: the home's own, the local CLI
  for (const kind of ['home', 'cli']) assert.equal(veil({ kind, fingerprint: 'x' }), false, `a ${kind} principal is refused`);
  for (const kind of ['desktop', 'phone']) assert.equal(veil({ kind, fingerprint: 'x' }), true, `an owner's ${kind} is allowed`);
});
