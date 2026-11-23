// The iOS journey runner: the dev host's hands, the runner, the CLI, and every step of the journey against a stub client, so a step that calls something that does not exist, or compares the wrong numbers, fails here and not on a phone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Wda } from '../scripts/mobile-ios-journey/wda.mjs';
import { JourneyHost } from '../scripts/mobile-ios-journey/host.mjs';
import { runJourney } from '../scripts/mobile-ios-journey/run.mjs';
import { main, USAGE } from '../scripts/mobile-ios-journey/cli.mjs';
import { steps, digits, safetyNumberOf, phoneName } from '../scripts/mobile-ios-journey/steps.mjs';
import { fakeWda, sleepNone } from './support/journey-wda.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-test-'));

test('the host’s hands: a line into its input, the log from a mark on (by bytes), and a fresh pairing code', async () => {
  const dir = fs.mkdtempSync(path.join(scratch, 'host-'));
  const fifo = path.join(dir, 'in');
  const log = path.join(dir, 'log');
  const codeFile = path.join(dir, 'code');
  fs.writeFileSync(fifo, '');
  fs.writeFileSync(log, 'one ↳ two\n');
  let clock = 0;
  const host = new JourneyHost({ fifo, log, codeFile, sleep: async (ms) => void (clock += ms), now: () => clock });
  assert.equal(await new JourneyHost({ fifo, log, codeFile }).sleep(1), undefined, 'the default sleep is a real timer');
  host.send('run plan');
  assert.equal(fs.readFileSync(fifo, 'utf8'), 'run plan\n');
  assert.throws(
    () => new JourneyHost({ fifo: path.join(dir, 'none'), log, codeFile }).send('r'),
    /is not reading .*none; start it with scripts\/mobile-ios-journey\.sh host start/,
  );
  const mark = host.mark();
  fs.appendFileSync(log, 'later ↳ phone shows safety number 123456. Type y\n');
  assert.equal((await host.waitLog(/safety number (\d+)\./, { since: mark }))[1], '123456');
  await assert.rejects(() => host.waitLog(/never/, { since: mark, timeoutMs: 1000 }), /did not show \/never\/ within 1s/);
  assert.equal((await host.waitLog(/one/))[0], 'one');
  fs.writeFileSync(codeFile, 'OLD');
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(codeFile, past, past);
  let writes = 0;
  const writing = new JourneyHost({
    fifo,
    log,
    codeFile,
    sleep: async () => {
      // the first write the host makes is seen half done (empty); the second is the code
      fs.writeFileSync(codeFile, ++writes === 1 ? '' : 'NEW\n');
    },
    now: Date.now,
  });
  assert.equal(await writing.newPairingCode(), 'NEW', 'a code written before the ask is not the answer to it');
  assert.ok(writes >= 2);
  clock = 1000;
  const missing = path.join(dir, 'absent');
  const quiet = new JourneyHost({ fifo, log, codeFile: missing, sleep: async (ms) => void (clock += ms), now: () => clock });
  await assert.rejects(() => quiet.newPairingCode(), /did not write a new pairing code to .*absent/);
  const blocked = new JourneyHost({ fifo, log, codeFile: path.join(log, 'code'), sleep: sleepNone, now: () => clock });
  await assert.rejects(
    () => blocked.newPairingCode(),
    /ENOTDIR/,
    'a code file that cannot be read for another reason is a failure, not "not yet"',
  );
});

test('the runner takes a screenshot after each step, stops at the first failure naming it, and runs only the steps asked for', async () => {
  const shots: string[] = [];
  const wda = { shot: async (file: string) => void shots.push(path.basename(file)) } as any;
  const said: string[] = [];
  const base = { wda, host: {} as any, relaunch: async () => undefined, out: '/out', say: (l: string) => void said.push(l), now: () => 0 };
  const order: string[] = [];
  const plan = [
    { name: 'one', run: async () => void order.push('one') },
    { name: 'two', run: async () => void order.push('two') },
    {
      name: 'three',
      run: async () => {
        throw new Error('no button');
      },
    },
    { name: 'four', run: async () => void order.push('four') },
  ];
  const failed = await runJourney({ ...base, steps: plan });
  assert.deepEqual([failed.ok, failed.failed, failed.ran], [false, 'three', ['one', 'two']]);
  assert.deepEqual(shots, ['01-one.png', '02-two.png', '03-three-FAILED.png']);
  assert.ok(said.includes('FAIL three: no button'));
  assert.ok(said.includes('journey failed at step "three"; screenshots are in /out'));
  const some = await runJourney({ ...base, steps: plan, only: ['two', 'four'] });
  assert.deepEqual([some.ok, some.ran], [true, ['two', 'four']]);
  assert.match(said.at(-1)!, /^journey passed: 2 steps/);
  await assert.rejects(
    () => runJourney({ ...base, steps: plan, only: ['nine'] }),
    /no such step: nine; the steps are one, two, three, four/,
  );
  const noShots = await runJourney({
    ...base,
    wda: { shot: async () => Promise.reject(new Error('gone')) } as any,
    steps: plan.slice(0, 1),
  });
  assert.equal(noShots.ok, true, 'a screenshot that fails does not fail the step');
  assert.ok(said.includes('(no screenshot: gone)'), 'but it is said');
});

/** The client the steps get: it records what each step did and answers the few questions a step asks. */
function stubs(over: { labels?: string[]; macNumber?: string; phones?: string } = {}) {
  const did: string[] = [];
  const rec =
    (name: string) =>
    async (...args: any[]) =>
      void did.push(
        `${name} ${args
          .map((a) => (typeof a === 'function' ? '' : typeof a === 'object' ? '' : a))
          .join(' ')
          .trim()}`.trim(),
      );
  const wda: any = Object.fromEntries(
    [
      'tap',
      'fill',
      'type',
      'waitFor',
      'waitGone',
      'sleep',
      'acceptAlert',
      'background',
      'foreground',
      'pullDown',
      'scrollTo',
      'tapUntil',
    ].map((n) => [n, rec(n)]),
  );
  wda.waitForAny = rec('waitForAny');
  wda.whenPresent = async (label: string, then: () => Promise<void>) => {
    did.push(`whenPresent ${label}`);
    await then();
  };
  wda.labels = async () => over.labels ?? ['Safety number 9 5 1 2 6 0'];
  const host: any = {
    send: (line: string) => void did.push(`send ${line}`),
    mark: () => 0,
    newPairingCode: async () => 'CODE',
    waitLog: async (pattern: RegExp) =>
      /safety number/.test(pattern.source)
        ? ['', over.macNumber ?? '951260']
        : /paired/.test(pattern.source)
          ? ['', over.phones ?? `A (x9), ${phoneName} (k2), B (q7), C (m1)`]
          : [''],
  };
  return { did, wda, host, relaunch: async () => void did.push('relaunch') };
}

test('every step of the journey runs against the client it is given, compares the safety numbers, and revokes the phone that paired last', async () => {
  const s = stubs();
  for (const step of steps) await step.run(s);
  assert.equal(steps.length, new Set(steps.map((x) => x.name)).size, 'step names are unique');
  assert.ok(s.did.includes('send y'), 'the Mac is told to allow the pairing after the numbers matched');
  assert.ok(
    s.did.includes('send run revoke 2'),
    'the phone this run paired under is the one revoked, by its place in the Mac’s list and not by the id beside it',
  );
  assert.ok(s.did.includes(`fill Phone name ${phoneName}`), 'the run names its phone');
  // the steps that only the 1.0.1 onboarding has are taken when they are on screen (the stub says they are) and asked about otherwise
  for (const label of ['Look for my computer', 'Advanced', 'Check the number']) assert.ok(s.did.includes(`whenPresent ${label}`), label);
  for (const did of ['tapUntil Look for my computer Paste code instead', 'tap Advanced', 'tap Check the number'])
    assert.ok(s.did.includes(did), did);
  assert.ok(s.did.includes('send run chats 120'));
  assert.equal(s.did.filter((d) => d === 'relaunch').length, 2);
  assert.ok(s.did.includes('type echo journey-$((6*7))'));
  assert.equal(s.did.filter((d) => d === 'send y').length, 2, 'pairing runs twice: at the start and after the revoke');
});

test('the revoke step says so when the Mac does not list the phone it paired', async () => {
  const revoke = steps.find((x) => x.name === 'revoke-and-re-pair')!;
  await assert.rejects(
    () => revoke.run(stubs({ phones: 'A (1), B (2)' })),
    /the Mac does not list a phone named Journey \d+: A \(1\), B \(2\)/,
  );
});

test('pairing refuses when the phone and the Mac show different numbers, or the phone shows none', async () => {
  const pair = steps.find((x) => x.name === 'pair-with-safety-number')!;
  await assert.rejects(() => pair.run(stubs({ macNumber: '111111' })), /the safety numbers differ: the phone shows 951260, the Mac 111111/);
  await assert.rejects(() => pair.run(stubs({ labels: ['Pair a computer'], macNumber: '' })), /the phone shows none/);
  assert.equal(safetyNumberOf(['x', 'Safety number 1 2 3', 'y']), '123');
  assert.equal(safetyNumberOf(['Check that both screens show the same safety number.']), '');
  assert.equal(digits('12 34-5'), '12345');
});

test('the CLI lists the steps, explains itself, refuses a wrong call, and returns the journey’s result as its exit status', async () => {
  const said: string[] = [];
  const say = (l: string) => void said.push(l);
  assert.equal(await main(['--list'], {}, { say }), 0);
  assert.deepEqual(said.slice(0, 2), ['launch', 'sign-out']);
  said.length = 0;
  assert.equal(await main(['--help'], {}, { say }), 0);
  assert.equal(said[0], USAGE);
  assert.equal(await main(['--bogus'], {}, { say }), 2);
  assert.match(said.at(-1)!, /Unknown option '--bogus'/);
  assert.equal(await main([], {}, { say }), 2);
  assert.match(said.at(-1)!, /Set MOPILOT_WDA_BASE/);
  const env = {
    MOPILOT_WDA_BASE: 'http://wda:8100',
    MOPILOT_JOURNEY_FIFO: '/f',
    MOPILOT_JOURNEY_LOG: '/l',
    MOPILOT_JOURNEY_LAUNCH: 'true',
    MOPILOT_JOURNEY_CODE_FILE: '/c',
  };
  const ran: string[] = [];
  const made = { wda: undefined as any };
  const deps = {
    say,
    run: async (shell: string) => void ran.push(shell),
    makeWda: () => (made.wda = Object.assign(stubs().wda, { open: async () => made.wda, shot: async () => undefined })),
    makeHost: (o: any) => (ran.push(`host ${o.codeFile}`), stubs().host),
    now: () => new Date('2026-10-29T12:00:00Z'),
  };
  assert.equal(await main(['--only', 'launch,sign-out', '--out', '/o'], env, deps), 0);
  assert.deepEqual(ran, ['host /c', 'true']);
  assert.equal(await main(['--only', 'launch'], { ...env, MOPILOT_JOURNEY_CODE_FILE: undefined }, deps), 0);
  assert.match(ran.at(-2)!, /^host .*\.mopilot-mobile-dev-host.pairing-code\.txt$/);
  assert.match(said.at(-1)!, /journey-2026-10-29T12-00-00-000Z/);
  const failing = {
    ...deps,
    makeWda: () =>
      (made.wda = Object.assign(stubs().wda, {
        open: async () => made.wda,
        shot: async () => undefined,
        waitFor: async () => Promise.reject(new Error('missing')),
        waitForAny: async () => Promise.reject(new Error('missing')),
      })),
  };
  assert.equal(await main(['--only', 'sign-in'], env, failing), 1);
  assert.equal(await main(['--only', 'nope'], env, deps), 2);
  assert.match(said.at(-1)!, /no such step: nope/);
});

test('with its real parts the CLI starts a Wda on the given address, runs the launch command and shows what it did', async () => {
  const real = globalThis.fetch;
  const f = fakeWda({ screen: [{ label: 'Sign in' }] });
  globalThis.fetch = f.fetchImpl;
  const said: string[] = [];
  try {
    const env = {
      MOPILOT_WDA_BASE: 'http://wda:8100',
      MOPILOT_JOURNEY_FIFO: path.join(scratch, 'none'),
      MOPILOT_JOURNEY_LOG: path.join(scratch, 'none'),
      MOPILOT_JOURNEY_LAUNCH: 'true',
    };
    // the launch step relaunches (a real `true`) and waits 15 s on a real timer: too long for a test, so only the list is real here
    assert.equal(await main(['--only', 'sign-in'], env, { say: (l: string) => void said.push(l) }), 1);
    assert.match(said.join('\n'), /FAIL sign-in/);
    assert.ok(f.calls.some((c) => c.route === '/session'));
    assert.equal(await main(['--list'], {}), 0);
  } finally {
    globalThis.fetch = real;
  }
});

test('the launch step runs the launch command in a real shell, then finds the app’s first screen', async () => {
  const f = fakeWda({ screen: [{ label: 'Sign in' }] });
  const said: string[] = [];
  const marker = path.join(scratch, 'launched');
  const env = {
    MOPILOT_WDA_BASE: 'http://wda:8100',
    MOPILOT_JOURNEY_FIFO: '/f',
    MOPILOT_JOURNEY_LOG: '/l',
    MOPILOT_JOURNEY_LAUNCH: `touch '${marker}'`,
  };
  const code = await main(['--only', 'launch'], env, {
    say: (l: string) => void said.push(l),
    makeWda: (o: any) => new Wda({ ...o, fetchImpl: f.fetchImpl, sleep: sleepNone }),
    makeHost: () => ({}) as any,
  });
  assert.equal(code, 0, said.join('\n'));
  assert.ok(fs.existsSync(marker), 'the launch command ran');
  assert.ok(f.calls.filter((c) => c.route === '/session').length >= 2, 'a new session after the relaunch');
});
