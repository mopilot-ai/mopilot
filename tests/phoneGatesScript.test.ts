// The phone gates: the sample maths on fixed inputs, each gate's flow against a fake driver, and the command line's refusals (the owner's app, too few samples, a missing option).
import { test } from 'node:test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Wda } from '../scripts/mobile-ios-journey/wda.mjs';
import assert from 'node:assert/strict';
import {
  CORE_SCREENS,
  CRITICAL_AUDIT_TYPES,
  GATES,
  buildResult,
  criticalCount,
  hitchRatio,
  median,
  parseTraceRow,
  stepSamples,
  worst,
} from '../scripts/phone-gates/stats.mjs';
import {
  checkBundleId,
  mjpegFrameTimes,
  readAbout,
  runA11y,
  runChatOpen,
  runDecision,
  runHalfOpen,
  runHitch,
  runLaunch,
} from '../scripts/phone-gates/gates.mjs';
import { USAGE, main, makeAsk, realDeps } from '../scripts/phone-gates/cli.mjs';

const ABOUT = [
  'Last launches',
  'Nov 14',
  'relay-token 9058 · list-sent 76674 · list-shown 520',
  '77 s',
  'open 0 · follow-answered 743 · rows-shown 245',
  'open 0 · rows-shown 180',
];

test('median and worst, and the hitch ratio of fixed frame times', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(worst([3, 9, 2]), 9);
  assert.throws(() => median([]), /no samples/);
  assert.throws(() => worst([]), /no samples/);
  // 60 fps with one frame 50 ms late over about 183 ms: (50 - 16.667) excess
  const times = [0, 16.667, 33.333, 83.333, 100, 116.667, 133.333, 150, 166.667, 183.333];
  assert.ok(Math.abs(hitchRatio(times) - 33.333 / 183.333) < 1e-3);
  assert.equal(hitchRatio([0, 16, 33, 50]), 0, 'jitter inside the tolerance is not a hitch');
  assert.ok(hitchRatio([0, 100, 200], { expectedMs: 50, tolerance: 1 }) > 0.4);
  assert.throws(() => hitchRatio([5]), /at least 2 frames/);
});

test('trace rows of About: parsed into steps, one step across rows, criticals counted', () => {
  assert.deepEqual(parseTraceRow('relay-token 9058 · list-shown 76990 · odd'), {
    'relay-token': 9058,
    'list-shown': 76990,
  });
  assert.deepEqual(parseTraceRow('77 s'), {});
  assert.deepEqual(stepSamples(ABOUT, 'rows-shown'), [245, 180]);
  assert.deepEqual(stepSamples(ABOUT, 'list-shown'), [520]);
  assert.equal(criticalCount([{ auditType: CRITICAL_AUDIT_TYPES[0] }, { auditType: 'XCUIAccessibilityAuditTypeTrait' }, {}]), 1);
});

test('a result records the build and its samples, passes inside the limit, and fails with too few samples or a miss', () => {
  const base = {
    device: 'iPhone 13 Pro Max',
    os: 'iOS 27.3',
    sha: 'abc',
    flag: 'new-ui=off',
  };
  const ok = buildResult({
    ...base,
    gate: 'launch',
    samples: [500, 520, 510, 530, 540, 490, 500, 505, 515, 525],
  });
  assert.equal(ok.pass, true);
  assert.equal(ok.reason, 'ok');
  assert.equal(ok.median, 512.5);
  assert.equal(ok.worst, 540);
  assert.deepEqual([ok.device, ok.os, ok.sha, ok.flag], ['iPhone 13 Pro Max', 'iOS 27.3', 'abc', 'new-ui=off']);
  const few = buildResult({ ...base, gate: 'launch', samples: [1, 2, 3] });
  assert.deepEqual([few.pass, few.reason], [false, 'only 3 of 10 samples']);
  const none = buildResult({
    ...base,
    gate: 'decision',
    samples: [],
    notes: ['n'],
  });
  assert.deepEqual([none.pass, none.median, none.worst, none.notes], [false, null, null, ['n']]);
  const slow = buildResult({
    ...base,
    gate: 'chat-open',
    samples: Array(10).fill(250),
  });
  assert.match(slow.reason, /median 250 is not within the limit 250/);
  const audit = buildResult({
    ...base,
    gate: 'a11y',
    samples: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  assert.equal(audit.pass, true);
  const bad = buildResult({
    ...base,
    gate: 'a11y',
    samples: [0, 0, 0, 0, 1, 0, 0, 0, 0],
  });
  assert.match(bad.reason, /worst 1 is not within the limit 0/);
  assert.equal(GATES.a11y.samples, CORE_SCREENS.length);
});

test('the owner’s app is refused, and so is no bundle id', () => {
  assert.equal(checkBundleId('ai.mopilot.phone.dev'), 'ai.mopilot.phone.dev');
  assert.throws(() => checkBundleId('ai.mopilot.phone'), /owner's app/);
  assert.throws(() => checkBundleId('ai.mopilot.remote'), /owner's app/);
  assert.throws(() => checkBundleId(undefined), /--bundle-id/);
});

type Call = [string, ...unknown[]];
function fakeDriver(o: { aboutLabels?: string[][]; gone?: number } = {}) {
  const calls: Call[] = [];
  const about = [...(o.aboutLabels ?? [ABOUT])];
  const wda: any = {
    calls,
    s: (r: string) => `/session/x${r}`,
    open: async () => void calls.push(['open']),
    tap: async (label: string, opts?: unknown) => void calls.push(['tap', label, opts]),
    waitFor: async (label: string, opts?: unknown) => void calls.push(['waitFor', label, opts]),
    waitGone: async (label: string, opts?: unknown) => void calls.push(['waitGone', label, opts]),
    labels: async () => about.shift() ?? ABOUT,
    call: async (method: string, route: string, body?: unknown) => {
      calls.push(['call', method, route, body]);
      return {
        value:
          route === '/status'
            ? { os: { name: 'iOS', version: '27.3' } }
            : [
                {
                  auditType: CRITICAL_AUDIT_TYPES[1],
                  compactDescription: 'small',
                },
              ],
      };
    },
  };
  return wda;
}

test('About is read through the menu and closed again', async () => {
  const wda = fakeDriver();
  assert.deepEqual(await readAbout(wda as never), ABOUT);
  assert.deepEqual(
    wda.calls.map((c) => c[1]),
    ['Open menu', 'Settings', 'About', 'Back', 'Close'],
  );
});

test('launch: ended, started, and the list-shown signpost read each time; no signpost is an error', async () => {
  const wda = fakeDriver();
  let ended = 0;
  const out = await runLaunch({
    wda: wda as never,
    terminate: async () => void (ended += 1),
    count: 3,
  });
  assert.deepEqual(out.samples, [520, 520, 520]);
  assert.equal(ended, 3);
  await assert.rejects(
    () =>
      runLaunch({
        wda: fakeDriver({ aboutLabels: [['nothing']] }) as never,
        terminate: async () => undefined,
        count: 1,
      }),
    /no list-shown signpost/,
  );
});

test('chat open: count + 1 opens, then rows-shown read once and cut to count', async () => {
  const wda = fakeDriver();
  const out = await runChatOpen({
    wda: wda as never,
    chat: 'Release notes',
    count: 1,
  });
  assert.deepEqual(out.samples, [245]);
  assert.equal(wda.calls.filter((c) => c[0] === 'tap' && c[1] === 'Open chat Release notes').length, 2);
});

test('MJPEG frames: a boundary counted once however the chunks cut it', async () => {
  const marker = '--BoundaryString';
  const cut = marker.length >> 1;
  async function* chunks() {
    yield Buffer.from(`xx${marker}jpg${marker.slice(0, cut)}`);
    yield Buffer.from(`${marker.slice(cut)}jpg`);
    yield Buffer.from('no boundary');
    yield Buffer.from(marker);
  }
  let t = 0;
  assert.deepEqual(await mjpegFrameTimes(chunks(), () => (t += 10)), [10, 20, 40]);
});

test('hitch: one capture per sample, the stream started each time', async () => {
  let started = 0;
  const out = await runHitch({
    startStream: async () => void (started += 1),
    capture: async () => [0, 16, 32, 48],
    count: 2,
  });
  assert.deepEqual(out.samples, [0, 0]);
  assert.equal(started, 2);
});

test('half-open: frozen, timed until the label goes, and thawed even when it never goes', async () => {
  let clock = 0;
  const events: string[] = [];
  const wda = fakeDriver();
  const now = () => (clock += 400);
  const out = await runHalfOpen({
    wda: wda as never,
    freeze: () => void events.push('freeze'),
    thaw: () => void events.push('thaw'),
    now,
    count: 2,
  });
  assert.deepEqual(out.samples, [400, 400]);
  assert.deepEqual(events, ['freeze', 'thaw', 'freeze', 'thaw']);
  const stuck = {
    ...wda,
    waitGone: async () => Promise.reject(new Error('still there')),
  };
  const e2: string[] = [];
  await assert.rejects(
    () =>
      runHalfOpen({
        wda: stuck as never,
        freeze: () => void e2.push('freeze'),
        thaw: () => void e2.push('thaw'),
        now,
        count: 1,
      }),
    /still there/,
  );
  assert.deepEqual(e2, ['freeze', 'thaw']);
});

test('decision stopwatch and accessibility audit on each screen', async () => {
  const prompts: string[] = [];
  let clock = 0;
  const out = await runDecision({
    ask: async (p) => void prompts.push(p),
    now: () => (clock += 1500),
    count: 2,
  });
  assert.deepEqual(out.samples, [1500, 1500]);
  assert.equal(prompts.length, 4);
  const audited = await runA11y({
    ask: async () => undefined,
    audit: async () => [{ auditType: CRITICAL_AUDIT_TYPES[0], compactDescription: 'no label' }, { auditType: 'other' }],
    screens: ['a', 'b'],
  });
  assert.deepEqual(audited.samples, [1, 1]);
  assert.ok(audited.notes.includes('a: XCUIAccessibilityAuditTypeElementDescription: no label'));
  assert.ok(audited.notes.includes('b: other: '));
  const quiet = await runA11y({
    ask: async () => undefined,
    audit: async () => [{}],
  });
  assert.equal(quiet.samples.length, CORE_SCREENS.length);
  assert.ok(quiet.notes.includes('chats-home: unknown: '));
});

function harness(o: { wda?: ReturnType<typeof fakeDriver>; sha?: string } = {}) {
  const said: string[] = [];
  const written: Record<string, string> = {};
  const shells: string[] = [];
  const signals: [number, string][] = [];
  let clock = 0;
  const wda = o.wda ?? fakeDriver();
  const deps: any = {
    say: (l: string) => void said.push(l),
    makeWda: () => ({ open: async () => wda }),
    shell: async (c: string) => void shells.push(c),
    exec: async () => ({ stdout: 'Tunnel IP Address: fd00::1\n' }),
    kill: (pid: number, sig: string) => void signals.push([pid, sig]),
    ask: async () => undefined,
    now: () => (clock += 300),
    mjpeg: async () =>
      (async function* () {
        yield Buffer.from('--BoundaryString');
        yield Buffer.from('--BoundaryString');
      })(),
    readText: async (f: string) => JSON.stringify(f.endsWith('a.json') ? [0, 16, 32, 48] : [0, 16, 100, 116]),
    writeText: async (f: string, t: string) => void (written[f] = t),
    sha: () => o.sha ?? 'cafe12345',
  };
  return { deps, said, written, shells, signals };
}
const WDA = { MOPILOT_WDA_BASE: 'http://wda:8100' };
const common = ['--bundle-id', 'ai.mopilot.phone.dev', '--device', 'iPhone 13 Pro Max', '--flag', 'none', '--out', '/out'];

test('the command line: usage, wrong calls, and the refusal of the owner’s app', async () => {
  const h = harness();
  assert.equal(await main(['--help'], {}, h.deps), 0);
  assert.equal(h.said[0], USAGE);
  assert.equal(await main(['--nope'], {}, h.deps), 2);
  assert.equal(await main([], {}, h.deps), 2);
  assert.equal(await main(['bogus'], {}, h.deps), 2);
  assert.equal(await main(['launch', '--bundle-id', 'ai.mopilot.phone', '--device', 'd', '--flag', 'none'], WDA, h.deps), 2);
  assert.match(h.said.at(-1) as string, /owner's app/);
  assert.equal(await main(['launch', '--bundle-id', 'ai.mopilot.phone.dev'], WDA, h.deps), 2);
  assert.match(h.said.at(-1) as string, /--device and --flag/);
  assert.equal(await main(['launch', ...common, '--count', '0'], WDA, h.deps), 2);
  assert.equal(await main(['launch', ...common], {}, h.deps), 2);
  assert.match(h.said.at(-1) as string, /MOPILOT_WDA_BASE or MOPILOT_IOS_UDID/);
  assert.deepEqual(h.written, {});
});

test('the command line: a launch run passes, is written with the build, and the tunnel address is found from the udid', async () => {
  const wda = fakeDriver();
  const h = harness({ wda });
  assert.equal(await main(['launch', ...common, '--count', '10'], { MOPILOT_IOS_UDID: 'UDID' }, h.deps), 0);
  const file = '/out/launch-ai.mopilot.phone.dev-cafe12345.json';
  const result = JSON.parse(h.written[file]);
  assert.deepEqual(
    [result.device, result.os, result.sha, result.flag, result.pass, result.samples.length],
    ['iPhone 13 Pro Max', 'iOS 27.3', 'cafe12345', 'none', true, 10],
  );
  assert.match(h.said.join('\n'), /PASS/);
  assert.ok(
    wda.calls.some(
      (c) =>
        c[0] === 'call' && c[2] === '/session/x/wda/apps/terminate' && (c[3] as { bundleId: string }).bundleId === 'ai.mopilot.phone.dev',
    ),
  );
  const noTunnel = harness();
  noTunnel.deps.exec = async () => ({ stdout: 'nothing' });
  assert.equal(await main(['launch', ...common], { MOPILOT_IOS_UDID: 'U' }, noTunnel.deps), 2);
  assert.match(noTunnel.said.at(-1) as string, /no tunnel address for U/);
});

test('the command line: a failing gate exits 1, with its reason; chat-open and half-open need their options', async () => {
  const slow = fakeDriver({ aboutLabels: [['open 0 · rows-shown 900']] });
  const h = harness({ wda: slow });
  assert.equal(await main(['chat-open', ...common, '--chat', 'x', '--count', '1'], WDA, h.deps), 1);
  assert.match(h.said.join('\n'), /FAIL \(only 1 of 10 samples\)/);
  assert.equal(await main(['chat-open', ...common], WDA, h.deps), 2);
  assert.match(h.said.at(-1) as string, /chat-open needs --chat/);
  assert.equal(await main(['half-open', ...common], WDA, h.deps), 2);
  assert.match(h.said.at(-1) as string, /half-open needs --host-pid/);
  const f = harness();
  assert.equal(await main(['half-open', ...common, '--host-pid', '4242', '--count', '10'], WDA, f.deps), 0);
  assert.equal(f.signals.length, 20);
  assert.deepEqual(f.signals.slice(0, 2), [
    [4242, 'SIGSTOP'],
    [4242, 'SIGCONT'],
  ]);
});

test('the command line: hitch from frame files, and from the live stream', async () => {
  const h = harness();
  assert.equal(await main(['hitch', ...common, '--frames', 'a.json,b.json'], {}, h.deps), 1);
  assert.match(h.said.join('\n'), /FAIL \(only 2 of 10 samples\)/);
  const live = harness();
  assert.equal(await main(['hitch', ...common, '--count', '1'], WDA, live.deps), 2);
  assert.match(live.said.at(-1) as string, /--stream-cmd or --frames/);
  assert.equal(await main(['hitch', ...common, '--stream-cmd', 'run-it', '--count', '1', '--seconds', '1'], {}, live.deps), 2);
  assert.match(live.said.at(-1) as string, /MOPILOT_WDA_BASE or MOPILOT_IOS_UDID/);
  live.deps.mjpeg = async () =>
    (async function* () {
      yield Buffer.from('--BoundaryString');
    })();
  assert.equal(
    await main(
      ['hitch', ...common, '--stream-cmd', 'run-it', '--count', '1', '--seconds', '1'],
      { MOPILOT_WDA_BASE: 'http://[fd00::1]:8100' },
      live.deps,
    ),
    2,
  );
  assert.deepEqual(live.shells, ['run-it']);
  assert.match(live.said.at(-1) as string, /at least 2 frames/, 'a stream with one frame cannot give a ratio');
  const withUrl = harness();
  let asked = '';
  withUrl.deps.mjpeg = async (url: string) => {
    asked = url;
    return (async function* () {
      yield Buffer.from('--BoundaryString');
      yield Buffer.from('--BoundaryString');
    })();
  };
  await main(
    ['hitch', ...common, '--stream-cmd', 's', '--count', '1', '--seconds', '1'],
    {
      MOPILOT_WDA_BASE: 'http://[fd00::1]:8100',
      MOPILOT_MJPEG_URL: 'http://m:1',
    },
    withUrl.deps,
  );
  assert.equal(asked, 'http://m:1');
  const derived = harness();
  let seen = '';
  derived.deps.mjpeg = async (url: string) => {
    seen = url;
    return (async function* () {
      yield Buffer.from('--BoundaryString');
      yield Buffer.from('--BoundaryString');
      yield Buffer.from('--BoundaryString');
    })();
  };
  await main(
    ['hitch', ...common, '--stream-cmd', 's', '--count', '1', '--seconds', '1'],
    { MOPILOT_WDA_BASE: 'http://[fd00::1]:8100' },
    derived.deps,
  );
  assert.equal(seen, 'http://[fd00::1]:9100');
});

test('the command line: decision and a11y run, and the operator is asked', async () => {
  const h = harness();
  const prompts: string[] = [];
  h.deps.ask = async (p: string) => void prompts.push(p);
  assert.equal(await main(['decision', ...common, '--count', '2'], {}, h.deps), 1);
  assert.equal(prompts.length, 4);
  assert.match(h.said.join('\n'), /os|median/);
  const a = harness();
  assert.equal(await main(['a11y', ...common], WDA, a.deps), 1, 'the fake audit finds a critical issue on every screen');
  const written = JSON.parse(Object.values(a.written)[0]);
  assert.equal(written.samples.length, CORE_SCREENS.length);
});

test('the real dependencies: a shell, exec, a signal to a child, a question, a stream, files and the commit', async () => {
  await realDeps.shell('true');
  assert.match(String((await realDeps.exec('node', ['-e', 'console.log(7)'])).stdout), /7/);
  const sleeper = spawn('sleep', ['30']);
  const ended = new Promise((resolve) => sleeper.once('exit', (_code, signal) => resolve(signal)));
  realDeps.kill(sleeper.pid as number, 'SIGTERM');
  assert.equal(await ended, 'SIGTERM');
  const input = new PassThrough();
  const output = new PassThrough();
  const asked = makeAsk(input, output)('ready?');
  input.write('\n');
  await asked;
  assert.match(String(output.read()), /ready\?/);
  assert.equal(typeof realDeps.now(), 'number');
  assert.ok(realDeps.makeWda({ base: 'http://x:1', bundleId: 'b' }) instanceof Wda);
  const server = http.createServer((_req, res) => res.end('--BoundaryString'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  let bytes = 0;
  for await (const chunk of await realDeps.mjpeg(`http://127.0.0.1:${port}`)) bytes += chunk.length;
  server.close();
  assert.equal(bytes, 16);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-'));
  await realDeps.writeText(path.join(dir, 'a', 'b.json'), '[1]');
  assert.equal(await realDeps.readText(path.join(dir, 'a', 'b.json')), '[1]');
  assert.match(realDeps.sha(), /^[0-9a-f]{9}$/);
  realDeps.say('');
});

test('the command line: the default folder, a device that does not say its OS, and the default capture length', async () => {
  const bare = fakeDriver();
  bare.call = async (method: string, route: string, body?: unknown) => {
    bare.calls.push(['call', method, route, body]);
    return { value: route === '/status' ? {} : [] };
  };
  const h = harness({ wda: bare });
  const noOut = common.filter((_, i) => i < 6);
  assert.equal(await main(['launch', ...noOut], WDA, h.deps), 0);
  const file = Object.keys(h.written)[0];
  assert.equal(file, 'design/phone-on-orca/measure/launch-ai.mopilot.phone.dev-cafe12345.json');
  assert.equal(JSON.parse(h.written[file]).os, 'iOS unknown');
  const live = harness();
  assert.equal(await main(['hitch', ...noOut, '--stream-cmd', 's', '--count', '1'], WDA, live.deps), 1);
  assert.match(live.said.join('\n'), /FAIL \(only 1 of 10 samples\)/);
});

test('the script itself prints its usage and exits 0; a call without a gate exits 2', () => {
  const script = new URL('../scripts/phone-gates.mjs', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [script, '--help']).toString();
  assert.match(out, /^Usage: node scripts\/phone-gates\/cli\.mjs <gate>/);
  assert.throws(
    () => execFileSync(process.execPath, [script], { stdio: 'pipe' }),
    (e: { status: number }) => e.status === 2,
  );
});
