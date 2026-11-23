// Signing in on a remote Host from the app (electron/host/signin.cjs): the link is relayed and opened only when safe, completion is confirmed by a fresh read (I2), cancel and an expired link end it (B2), and a replaced attempt's answers are dropped (A4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSignin, openable, onVendorSite, MAX_OPENED, EXPIRE_MS, NO_PAGE_MS } = require('../electron/host/signin.cjs');

test('GitHub device sign-in opens only its exact credential-free device page', () => {
  assert.equal(onVendorSite('git:github.com', 'https://github.com/login/device'), true);
  for (const url of [
    'https://github.com/login/device?token=secret',
    'https://github.com.evil.test/login/device',
    'https://api.github.com/login/device',
    'https://github.com/other',
  ])
    assert.equal(onVendorSite('git:github.com', url), false);
});

test('overlapping cancellations serialize before a replacement, and a cancelled queued start never dispatches', async () => {
  const stops: (() => void)[] = [];
  let starts = 0;
  const signin = createSignin({
    call: async (_id: string, method: string) => {
      if (method === 'loginCancel')
        return new Promise<void>((r) => {
          stops.push(r);
        });
      if (method === 'login') starts++;
      return { state: 'waiting' };
    },
    openExternal() {},
    verify: async () => ({ signedIn: true }),
    pollMs: 1,
  });
  const first = signin.start({ hostId: 'h', harness: 'git:github.com' });
  signin.cancel('h', 'git:github.com');
  await first;
  const second = signin.start({ hostId: 'h', harness: 'git:github.com' });
  signin.cancel('h', 'git:github.com');
  await second;
  const third = signin.start({ hostId: 'h', harness: 'git:github.com' });
  assert.equal(starts, 1);
  assert.equal(stops.length, 1, 'the second cancel waits for the first');
  stops[0]();
  await until(() => stops.length === 2);
  assert.equal(starts, 1);
  stops[1]();
  await until(() => starts === 2);
  signin.dispose();
  assert.equal((await third).state, 'cancelled');
});

const until = async (fn: () => any, ms = 3000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** A Host whose `loginStatus` answers come from `script` (the last one repeats). */
function world(script: any[] = [], o: any = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const changes: any[] = [];
  const refreshed: string[] = [];
  let at = 0;
  const w: any = {
    calls,
    opened,
    changes,
    refreshed,
    reported: [] as string[],
    verified: { signedIn: true } as any,
    verifies: 0,
    signin: createSignin({
      call: async (hostId: string, method: string, params: any) => {
        calls.push(method);
        if (o.call) return o.call(hostId, method, params);
        if (method === 'loginStatus') {
          const s = script[Math.min(at++, script.length - 1)];
          if (s instanceof Error) throw s;
          return s;
        }
        return { ok: true };
      },
      openExternal: async (url: string) => {
        opened.push(url);
        if (o.openFails) throw new Error('no browser');
      },
      verify: async () => {
        w.verifies++;
        if (o.verify) return o.verify();
        return w.verified;
      },
      refresh: (id: string) => {
        refreshed.push(id);
        if (o.refreshFails) return Promise.reject(new Error('x'));
      },
      onChange: (v: any) => changes.push(v),
      report: (e: any) => w.reported.push(String(e?.message ?? e)),
      pollMs: 2,
      expireMs: o.expireMs,
      noPageMs: o.noPageMs,
    }),
  };
  return w;
}
const waiting = (extra: object = {}) => ({ state: 'waiting', links: [], codes: [], error: null, ...extra });

test('the link is opened once on the Mac, the code is shown, and a done sign-in is confirmed by a fresh read', async () => {
  const w = world([
    waiting(),
    waiting({ links: ['https://auth.openai.com/codex/device'], codes: ['ABCD-1234'] }),
    waiting({ links: ['https://auth.openai.com/codex/device'], codes: ['ABCD-1234'] }),
    { ...waiting(), state: 'done' },
  ]);
  const done = w.signin.start({ hostId: 'h1', harness: 'codex', methodId: 'web' });
  assert.equal(w.signin.start({ hostId: 'h1', harness: 'codex' }), done, 'a second ask joins the one under way');
  assert.equal(w.signin.status('h1', 'codex').state, 'starting');
  const end = await done;
  assert.equal(end.state, 'signed-in');
  assert.deepEqual(w.opened, ['https://auth.openai.com/codex/device']);
  assert.ok(w.changes.some((c: any) => c.codes[0] === 'ABCD-1234' && c.state === 'waiting'));
  assert.equal(w.verifies, 1);
  assert.deepEqual(w.refreshed, ['h1']);
  assert.equal(w.signin.status('h2', 'codex'), null);
  // a finished attempt can be followed by a new one
  assert.notEqual(w.signin.start({ hostId: 'h1', harness: 'codex' }), done);
  w.signin.dispose();
});

test('a link that is not a plain https page is never opened, and a browser that fails to open does not stop the sign-in (B1)', async () => {
  const bad = [
    'http://a.example',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://u:p@a.example',
    'not a url',
    7,
    `https://a.example/${'x'.repeat(2100)}`,
  ];
  assert.deepEqual(
    bad.map(openable),
    bad.map(() => null),
  );
  const w = world([waiting({ links: [...bad, 'https://claude.ai/oauth/authorize'], codes: 'nope' }), { state: 'done', links: [] }], {
    openFails: true,
  });
  assert.equal((await w.signin.start({ hostId: 'h', harness: 'claude' })).state, 'signed-in');
  assert.deepEqual(w.opened, ['https://claude.ai/oauth/authorize']);
  await until(() => w.reported.includes('no browser'));
});

test('a status that is not a status, or none at all because the Host restarted, fails the sign-in (B1)', async () => {
  for (const reply of [null, 'x', { state: 5 }]) {
    const w = world([reply]);
    const end = await w.signin.start({ hostId: 'h', harness: 'codex' });
    assert.equal(end.state, 'failed');
    assert.match(end.error, /lost the sign-in/);
  }
});

test("the Host reporting failure or its own cancel ends the attempt with the Host's words", async () => {
  const failed = await world([{ state: 'failed', error: 'denied' }]).signin.start({ hostId: 'h', harness: 'codex' });
  assert.deepEqual([failed.state, failed.error], ['failed', 'denied']);
  const blank = await world([{ state: 'failed' }]).signin.start({ hostId: 'h', harness: 'codex' });
  assert.equal(blank.error, 'The sign-in failed.');
  const cancelled = await world([{ state: 'cancelled' }]).signin.start({ hostId: 'h', harness: 'codex' });
  assert.equal(cancelled.state, 'cancelled');
  // the vendor's code ran out on the Host: an expired attempt, which one click starts again
  const w = world([{ state: 'expired', error: 'x' }]);
  const expired = await w.signin.start({ hostId: 'h', harness: 'claude' });
  assert.deepEqual([expired.state, expired.error], ['expired', 'That code expired. Get a new one.']);
  w.signin.start({ hostId: 'h', harness: 'claude' });
  assert.equal(w.signin.status('h', 'claude').state, 'starting', 'a new attempt, not the ended one');
});

test('cancel stops the attempt and the sign-in on the Host, and says false when none is under way', async () => {
  const w = world([waiting()]);
  assert.equal(w.signin.cancel('h', 'codex'), false);
  const done = w.signin.start({ hostId: 'h', harness: 'codex' });
  await until(() => w.calls.includes('loginStatus'));
  assert.equal(w.signin.cancel('h', 'codex'), true);
  assert.equal((await done).state, 'cancelled');
  await until(() => w.calls.includes('loginCancel'));
  assert.equal(w.signin.cancel('h', 'codex'), false);
  // the poll loop notices the end and sends nothing more
  const seen = w.calls.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(w.calls.length, seen);
});

test('a link that outlives the wait expires: the Host is told to stop and the user to start again (B2)', async () => {
  const w = world([waiting({ links: ['https://auth.example/d'] })], { expireMs: 15 });
  const end = await w.signin.start({ hostId: 'h', harness: 'codex' });
  assert.equal(end.state, 'expired');
  assert.match(end.error, /expired/);
  assert.ok(w.calls.includes('loginCancel'));
  assert.ok(EXPIRE_MS > 15 * 60_000);
});

test('an unreachable Host ends the sign-in after three failed reads in a row, not on one blip', async () => {
  const blip = world([new Error('down'), waiting(), new Error('down'), new Error('down'), { state: 'done' }]);
  assert.equal((await blip.signin.start({ hostId: 'h', harness: 'codex' })).state, 'signed-in');
  const gone = world([new Error('tunnel down')]);
  const end = await gone.signin.start({ hostId: 'h', harness: 'codex' });
  assert.deepEqual([end.state, end.error], ['unreachable', 'tunnel down']);
  const none = world([], { call: async () => Promise.reject(new Error('no tunnel')) });
  assert.equal((await none.signin.start({ hostId: 'h', harness: 'codex' })).state, 'unreachable');
});

test('done is not believed unless a fresh read agrees, and the account named is checked against it (I2)', async () => {
  const w = world([{ state: 'done' }]);
  w.verified = { signedIn: false };
  const no = await w.signin.start({ hostId: 'h', harness: 'codex' });
  assert.deepEqual([no.state, no.error], ['failed', 'The machine says it is not signed in.']);
  const other = world([{ state: 'done' }]);
  other.verified = { signedIn: true, account: 'bob@example.com' };
  const mismatch = await other.signin.start({ hostId: 'h', harness: 'codex', expectAccount: 'alice@example.com' });
  assert.match(mismatch.error, /different account than alice@example.com/);
  const same = world([{ state: 'done' }]);
  same.verified = { signedIn: true, account: 'alice@example.com' };
  assert.equal((await same.signin.start({ hostId: 'h', harness: 'codex', expectAccount: 'alice@example.com' })).state, 'signed-in');
  const broke = world([{ state: 'done' }], { verify: () => Promise.reject(new Error('timeout')), refreshFails: true });
  assert.match((await broke.signin.start({ hostId: 'h', harness: 'codex' })).error, /Could not confirm the sign-in: timeout/);
  const bare = world([{ state: 'done' }], { verify: () => Promise.reject('plain') });
  assert.match((await bare.signin.start({ hostId: 'h', harness: 'codex' })).error, /plain/);
});

test('retiring a Host drops the read in flight and the answers still queued behind it (A4)', async () => {
  let release: (v: any) => void = () => undefined;
  const w = world([{ state: 'done' }], { verify: () => new Promise((r) => (release = r)) });
  const first = w.signin.start({ hostId: 'h', harness: 'codex' });
  await until(() => w.verifies === 1);
  w.signin.retire('h');
  assert.equal((await first).state, 'cancelled');
  // the account that was switched away from answers late: it changes nothing
  release({ signedIn: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.signin.status('h', 'codex').state, 'cancelled');
  // a failing read that lands after the retire is dropped too
  let fail: (e: Error) => void = () => undefined;
  const late = world([{ state: 'done' }], { verify: () => new Promise((_, rej) => (fail = rej)) });
  const second = late.signin.start({ hostId: 'h', harness: 'codex' });
  await until(() => late.verifies === 1);
  late.signin.retire('h');
  late.signin.retire('other');
  fail(new Error('late'));
  assert.equal((await second).state, 'cancelled');
  // a status reply that lands after a cancel, and a new attempt started since, are not mixed up
  let answer: (v: any) => void = () => undefined;
  const slow = world([], {
    call: (_h: string, m: string) => (m === 'loginStatus' ? new Promise((r) => (answer = r)) : Promise.resolve({})),
  });
  const old = slow.signin.start({ hostId: 'h', harness: 'codex' });
  await until(() => slow.calls.includes('loginStatus'));
  slow.signin.cancel('h', 'codex');
  await old;
  answer({ state: 'done' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(slow.verifies, 0);
  // a failed status read that lands after a cancel is dropped
  let rejectStatus: (e: Error) => void = () => undefined;
  const dropped = world([], {
    call: (_h: string, m: string) => (m === 'loginStatus' ? new Promise((_, rej) => (rejectStatus = rej)) : Promise.resolve({})),
  });
  const gone = dropped.signin.start({ hostId: 'h', harness: 'codex' });
  await until(() => dropped.calls.includes('loginStatus'));
  dropped.signin.dispose();
  rejectStatus(new Error('late'));
  assert.equal((await gone).state, 'cancelled');
});

test('two harnesses on one Host, and one harness on two Hosts, sign in independently', async () => {
  const w = world([waiting()]);
  const a = w.signin.start({ hostId: 'h1', harness: 'codex' });
  const b = w.signin.start({ hostId: 'h1', harness: 'claude' });
  const c = w.signin.start({ hostId: 'h2', harness: 'codex' });
  assert.equal(new Set([a, b, c]).size, 3);
  w.signin.cancel('h1', 'codex');
  assert.equal(w.signin.status('h1', 'claude').state === 'cancelled', false);
  w.signin.dispose();
  await Promise.all([a, b, c]);
});

test('a cancel while the Host is still starting the sign-in wins over the start failing, and the defaults stand in for unset options', async () => {
  let fail: (e: unknown) => void = () => undefined;
  const w = world([], { call: (_h: string, m: string) => (m === 'login' ? new Promise((_, rej) => (fail = rej)) : Promise.resolve({})) });
  const done = w.signin.start({ hostId: 'h', harness: 'codex' });
  w.signin.cancel('h', 'codex');
  fail(new Error('late'));
  assert.equal((await done).state, 'cancelled');
  const plain = world([], { call: () => Promise.reject('plain text') });
  assert.equal((await plain.signin.start({ hostId: 'h', harness: 'codex' })).error, 'plain text');
  const text = world([], { call: (_h: string, m: string) => (m === 'login' ? Promise.resolve({}) : Promise.reject('boom')) });
  assert.equal((await text.signin.start({ hostId: 'h', harness: 'codex' })).error, 'boom');
  // a sign-in made with only the required options
  const bare = createSignin({
    call: async (_h: string, m: string) => (m === 'loginStatus' ? { state: 'done', links: ['https://a.example'] } : {}),
    openExternal: () => Promise.reject(new Error('no browser')),
    verify: async () => ({ signedIn: true }),
  });
  assert.equal((await bare.start({ hostId: 'h', harness: 'codex' })).state, 'signed-in');
});

test('cancelHost ends every sign-in under way for a Host, tells the Host to stop each one, and leaves other Hosts and finished ones alone', async () => {
  const w = world([{ state: 'waiting', links: [], codes: [] }]);
  const a = w.signin.start({ hostId: 'h1', harness: 'gemini' });
  w.signin.start({ hostId: 'h1', harness: 'qwen' });
  w.signin.start({ hostId: 'h2', harness: 'gemini' });
  await until(() => w.calls.filter((c: string) => c === 'loginStatus').length >= 3);
  await w.signin.cancelHost('h1');
  assert.equal((await a).state, 'cancelled');
  assert.equal(w.calls.filter((c: string) => c === 'loginCancel').length, 2);
  assert.equal(w.signin.status('h2', 'gemini').state, 'waiting');
  assert.equal(w.signin.cancelHost('h1'), null, 'nothing left to stop');
  w.signin.dispose();
});

test('input sends one typed line to the sign-in under way and says whether the Host took it; none under way, or an ended one, is false', async () => {
  const sent: any[] = [];
  const w = world([{ state: 'waiting', links: ['https://claude.ai/login'], codes: [] }], {
    call: async (_h: string, method: string, params: any) => {
      if (method === 'loginInput') {
        sent.push(params);
        if (params.text === 'refused') throw new Error('unknown method loginInput');
        return { accepted: params.text !== 'late' };
      }
      return method === 'loginStatus' ? { state: 'waiting', links: ['https://claude.ai/login'], codes: [] } : { ok: true };
    },
  });
  assert.equal(await w.signin.input('h1', 'claude', 'abc'), false, 'nothing under way');
  w.signin.start({ hostId: 'h1', harness: 'claude' });
  await until(() => w.opened.length === 1);
  assert.equal(w.signin.status('h1', 'claude').link, true, 'the view says a page was opened');
  assert.equal(await w.signin.input('h1', 'claude', 'abc'), true);
  assert.equal(await w.signin.input('h1', 'claude', 'late'), false, 'the Host did not take it');
  await assert.rejects(w.signin.input('h1', 'claude', 'refused'), /unknown method/);
  assert.deepEqual(sent[0], { harness: 'claude', text: 'abc' });
  w.signin.cancel('h1', 'claude');
  assert.equal(await w.signin.input('h1', 'claude', 'abc'), false, 'an ended sign-in takes nothing');
  assert.equal(sent.length, 3);
});

test('M7: a sign-in opens at most three links, and for claude and codex only on the vendor’s own sites; a refused site is told, not opened', async () => {
  const phishing = [
    'https://claude.ai.evil.example/login',
    'https://evilclaude.ai/x',
    'https://auth.openai.com/codex/device',
    'https://anthropic.com@evil.example/x',
  ];
  const w = world([waiting({ links: phishing }), { state: 'done', links: phishing }]);
  assert.equal((await w.signin.start({ hostId: 'h', harness: 'claude' })).state, 'signed-in');
  assert.deepEqual(w.opened, [], 'not one of them is a Claude site');
  assert.deepEqual(
    w.signin.status('h', 'claude').blocked,
    ['claude.ai.evil.example', 'evilclaude.ai', 'auth.openai.com'],
    'a link with user info is refused earlier, as before',
  );
  assert.ok(
    w.changes.some((c: any) => c.blocked.length > 0),
    'the window is told',
  );
  // the vendor's sites and their subdomains pass; a lookalike suffix does not
  assert.equal(onVendorSite('claude', 'https://console.anthropic.com/oauth'), true);
  assert.equal(onVendorSite('claude', 'https://claude.com/cai/oauth'), true);
  assert.equal(onVendorSite('codex', 'https://auth.openai.com/codex/device'), true);
  assert.equal(onVendorSite('codex', 'https://chatgpt.com/auth'), true);
  assert.equal(onVendorSite('codex', 'https://notopenai.com/'), false);
  assert.equal(onVendorSite('codex', 'https://CHATGPT.COM.evil.example/'), false);
  // a harness with no listed sites is held to https and the cap, and "__proto__" is no harness with sites
  assert.equal(onVendorSite('gemini', 'https://anywhere.example/'), true);
  assert.equal(onVendorSite('__proto__', 'https://anywhere.example/'), true);
  // the cap
  const many = Array.from({ length: 8 }, (_, i) => `https://auth.example/${i}`);
  const c = world([waiting({ links: many }), { state: 'done', links: many }]);
  assert.equal((await c.signin.start({ hostId: 'h', harness: 'gemini' })).state, 'signed-in');
  assert.equal(c.opened.length, MAX_OPENED);
  assert.deepEqual(c.opened, many.slice(0, MAX_OPENED));
});

test('the view carries the first page opened, so the row can open it again; none before a page opened', async () => {
  const w = world([waiting({ links: ['http://x.test/no', 'https://claude.ai/oauth/a', 'https://claude.com/b'] }), waiting()]);
  void w.signin.start({ hostId: 'h', harness: 'claude' });
  assert.equal(w.signin.status('h', 'claude').url, null);
  await until(() => w.opened.length === 2);
  assert.equal(w.signin.status('h', 'claude').url, 'https://claude.ai/oauth/a');
  w.signin.cancel('h', 'claude');
});

test('B: a sign-in that waits with no link and no code ends as one that opened no page, and the machine is told to stop', async () => {
  assert.equal(NO_PAGE_MS, 20_000);
  const w = world([waiting()], { noPageMs: 20 });
  const end = await w.signin.start({ hostId: 'h1', harness: 'grok' });
  assert.deepEqual([end.state, end.reason], ['failed', 'no_page']);
  assert.ok(w.calls.includes('loginCancel'), 'the Host stops its sign-in');
  assert.deepEqual(w.opened, []);
});

test('a sign-in that showed a link, a code, or a blocked link in time is never ended for showing no page; one still starting waits', async () => {
  for (const shown of [
    { links: ['https://accounts.google.com/o/oauth2'] },
    { codes: ['WXYZ-1234'] },
    { links: ['https://evil.example/x'] },
  ]) {
    const w = world([waiting(shown), waiting(shown), waiting(shown), { ...waiting(shown), state: 'done' }], {
      noPageMs: 0,
    });
    const end = await w.signin.start({ hostId: 'h1', harness: shown.links?.[0]?.includes('evil') ? 'codex' : 'gemini' });
    assert.notEqual(end.reason, 'no_page');
  }
  // the Host has not begun to wait (still starting the agent): no clock runs yet
  const starting = world(
    [
      { ...waiting(), state: 'starting' },
      { ...waiting(), state: 'starting' },
      { ...waiting(), state: 'done' },
    ],
    {
      noPageMs: 0,
    },
  );
  assert.equal((await starting.signin.start({ hostId: 'h1', harness: 'gemini' })).state, 'signed-in');
});
