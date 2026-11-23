// The dev host's command line: option parsing, the banner and QR, the one-letter commands, the pairing prompt and a clean stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { main, run, USAGE } from '../scripts/mobile-dev-host/cli.mjs';
import { until } from './support/mobileStack.ts';

/** A host whose pairing and stop are recorded; `calls` holds the options main passed. */
function rig(o: { devices?: any[]; pairFails?: boolean; pairFailsAlways?: boolean; startFails?: boolean } = {}) {
  const calls: any[] = [];
  const out: string[] = [];
  const stdin = new PassThrough();
  const state = { stopped: 0, pairs: 0, fail: false };
  const start = async (opts: any) => {
    calls.push(opts);
    if (o.startFails) throw new Error('port busy');
    return {
      relayUrl: `ws://${opts.advertise}:${opts.port}/v1/ws`,
      accountUrl: `http://${opts.advertise}:${opts.port}`,
      shellsReal: o.devices === undefined,
      devices: () => o.devices ?? [],
      scenarios: {
        list: () => [{ usage: 'plan [long]', about: 'a plan card' }],
        run: (name: string, args: string[]) => {
          if (name !== 'plan') throw new Error(`No scenario "${name}".`);
          return `started ${name} ${args.join(' ')}`.trim();
        },
      },
      async pair() {
        state.pairs++;
        if (state.fail || o.pairFailsAlways || (o.pairFails && state.pairs > 1)) throw new Error('relay down');
        return { qr: '{"v":1,"relay":"x"}', expiresAt: 1_000 };
      },
      stop: async () => void state.stopped++,
    };
  };
  const io: any = {
    stdin,
    out: (t: string) => void out.push(t),
    lan: () => '192.168.86.228',
    start,
    writeCode: async () => undefined,
  };
  return { io, calls, out, stdin, state, text: () => out.join('\n') };
}

test('--help prints the usage and starts nothing', async () => {
  const r = rig();
  assert.equal(await main(['--help'], r.io), null);
  assert.equal(r.out[0], USAGE);
  assert.equal(r.calls.length, 0);
});

test('it advertises the LAN address, prints the QR and the paste-able code, and stops on q', async () => {
  const r = rig();
  const running = await main([], r.io);
  assert.equal(r.calls[0].advertise, '192.168.86.228');
  assert.equal(r.calls[0].port, 8787);
  assert.equal(r.calls[0].bind, '0.0.0.0');
  assert.equal(r.calls[0].mirrors, true);
  assert.equal(r.calls[0].fakeHosts, false, 'no made-up machines unless asked');
  assert.equal(r.calls[0].confirm, undefined, 'a pairing is allowed after its number is logged');
  assert.match(r.text(), /MOPILOT_DEV_HOST=http:\/\/192\.168\.86\.228:8787/);
  assert.match(r.text(), /npx expo start --dev-client --lan/);
  assert.match(r.text(), /paired {3}none yet/);
  assert.match(r.text(), /Pairing code .*:\n\{"v":1/);
  assert.ok(
    r.out.some((t) => t.includes('█') || t.includes('▀')),
    'a QR is drawn',
  );
  r.stdin.write('nonsense\nq\n');
  await running!.done;
  assert.equal(r.state.stopped, 1);
  assert.equal(r.out.at(-1), 'stopped');
  await running!.stop();
  assert.equal(r.state.stopped, 1, 'stopping twice stops once');
});

test('r makes a new code, s lists the phones, and Ctrl-D at a terminal stops the host', async () => {
  const r = rig({ devices: [{ id: 'd1', name: 'Du’s iPhone' }] });
  (r.stdin as any).isTTY = true;
  const running = await main(['--port', '9000', '--dir', '/x', '--no-mirrors', '--fake-hosts'], r.io);
  assert.deepEqual([r.calls[0].dir, r.calls[0].port, r.calls[0].mirrors, r.calls[0].fakeHosts], ['/x', 9000, false, true]);
  assert.match(r.text(), /paired {3}Du’s iPhone/);
  assert.match(r.text(), /scratch {2}\/x {2}\(node-pty unavailable/);
  r.stdin.write('r\n');
  await until(() => r.state.pairs === 2, 'a second pairing code');
  r.stdin.write('S\n');
  await until(() => r.out.some((t) => t === 'paired: Du’s iPhone (d1)'), 'the status line');
  r.stdin.end();
  await running!.done;
  assert.equal(r.state.stopped, 1);
});

test('an input that is not a terminal closing (nohup, a launcher) leaves the host running until q', async () => {
  const r = rig();
  const running = await main([], r.io);
  r.stdin.end();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(r.state.stopped, 0);
  await running!.stop();
  assert.equal(r.state.stopped, 1);
});

test('a start that fails, or a first code that cannot be made, leaves nothing running or reading', async () => {
  const failing = rig({ startFails: true });
  await assert.rejects(main(['--ask'], failing.io), /port busy/);
  assert.equal(failing.stdin.listenerCount('data'), 0, 'no reader was attached to the input');

  const noCode = rig({ pairFailsAlways: true });
  await assert.rejects(main([], noCode.io), /relay down/);
  assert.equal(noCode.state.stopped, 1, 'the host that did start is stopped');
  assert.equal(noCode.stdin.listenerCount('data'), 0);
});

test('a code that cannot be made is reported, and s with nobody paired says none', async () => {
  const r = rig({ pairFails: true });
  const running = await main(['--loopback', '--ask'], r.io);
  assert.deepEqual([r.calls[0].advertise, r.calls[0].bind], ['127.0.0.1', '127.0.0.1']);
  r.stdin.write('r\ns\n');
  await until(
    () => r.out.some((t) => t.includes('could not make a pairing code: relay down')) && r.out.includes('paired: none'),
    'both lines',
  );
  await running!.stop();
});

test('--ask asks here: yes allows, anything else denies, and a cancelled pairing answers nothing', async () => {
  const r = rig();
  const running = await main(['--ask'], r.io);
  const confirm = r.calls[0].confirm;
  const device = { name: 'Phone' };
  const ask = (signal = new AbortController().signal) => confirm({ device, safetyNumber: '123456', signal });
  const yes = ask();
  assert.ok(
    r.out.some((t) => t.includes('safety number 123456')),
    'the number to compare is printed',
  );
  r.stdin.write('y\n');
  assert.equal(await yes, 'allow');
  const no = ask();
  r.stdin.write('no\n');
  assert.equal(await no, 'deny');
  assert.equal(await ask(AbortSignal.abort()), null, 'a pairing already cancelled asks nothing');
  const abort = new AbortController();
  const cancelled = ask(abort.signal);
  abort.abort();
  assert.equal(await cancelled, null);
  await running!.stop();
});

test('bad options and no network fail with a reason', async () => {
  const r = rig();
  await assert.rejects(main(['--port', 'abc'], r.io), /--port must be 0-65535, got abc/);
  await assert.rejects(main(['--port', '70000'], r.io), /--port must be 0-65535/);
  await assert.rejects(main([], { ...r.io, lan: () => null }), /No LAN address found/);
  assert.equal(
    (await main(['--host', 'my-mac.local'], r.io).then(async (x: any) => (await x.stop(), r.calls.at(-1)))).advertise,
    'my-mac.local',
  );
  assert.equal(r.calls.length, 1);
});

test('without injected parts it uses the real process streams and host', () => {
  // main's defaults are exercised by running the script; here only that --help needs nothing from them
  return assert.doesNotReject(main(['--help'], { out: () => undefined }));
});

test('run stops the host on a signal, and reports a failure as one line with exit code 1', async () => {
  const r = rig();
  const proc: any = new EventEmitter();
  const finished = run([], { ...r.io, proc, err: () => undefined });
  await until(() => proc.listenerCount('SIGINT') === 1 && proc.listenerCount('SIGTERM') === 1, 'the signal handlers');
  proc.emit('SIGTERM');
  await finished;
  assert.equal(r.state.stopped, 1);
  assert.equal(proc.exitCode, undefined);

  const errors: string[] = [];
  const failing: any = new EventEmitter();
  await run(['--port', 'abc'], { ...r.io, proc: failing, err: (t: string) => errors.push(t) });
  assert.deepEqual(errors, ['mobile-dev-host: --port must be 0-65535, got abc']);
  assert.equal(failing.exitCode, 1);

  const odd: any = new EventEmitter();
  await run([], { ...r.io, proc: odd, err: (t: string) => errors.push(t), start: async () => Promise.reject('plain') });
  assert.equal(errors.at(-1), 'mobile-dev-host: plain');

  const help: any = new EventEmitter();
  await run(['--help'], { ...r.io, proc: help });
  assert.equal(help.listenerCount('SIGINT'), 0, '--help starts nothing to stop');
});

test('the script itself prints its usage', () => {
  const out = execFileSync(process.execPath, [new URL('../scripts/mobile-dev-host.mjs', import.meta.url).pathname, '--help']).toString();
  assert.match(out, /^Usage: node scripts\/mobile-dev-host\.mjs/);
});

test('the current pairing code is always in <dir>/pairing-code.txt', async () => {
  const r = rig();
  const written: [string, string][] = [];
  const io = { ...r.io, writeCode: async (file: string, text: string) => void written.push([file, text]) };
  const running = await main(['--dir', '/scratch'], io);
  assert.deepEqual(written, [['/scratch/pairing-code.txt', '{"v":1,"relay":"x"}']]);
  r.stdin.write('r\n');
  await until(() => written.length === 2, 'the new code to be written');
  await running!.stop();
});

test('--renew makes a fresh code every minute, skips a minute when one cannot be made, and stops with the host', async () => {
  const r = rig();
  const written: string[] = [];
  const timers: { fn: () => void; ms: number; unref: () => void; cleared?: boolean }[] = [];
  const io = {
    ...r.io,
    writeCode: async (_file: string, text: string) => void written.push(text),
    every: (fn: () => void, ms: number) => {
      const timer = { fn, ms, unref() {}, cleared: false };
      timers.push(timer);
      return timer;
    },
    stopEvery: (timer: any) => void (timer.cleared = true),
  };
  const running = await main(['--renew'], io);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  assert.equal(written.length, 1);
  timers[0].fn();
  await until(() => written.length === 2, 'a renewed code');
  assert.equal(r.state.pairs, 2);
  // the host refuses (a phone is being confirmed): nothing is written, the refusal is printed, the next minute tries again
  r.state.fail = true;
  timers[0].fn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(written.length, 2);
  assert.ok(r.out.some((t) => t.includes('pairing code not renewed (relay down)')));
  await running!.stop();
  assert.equal(timers[0].cleared, true);

  // without --renew no timer runs
  const plain = rig();
  const none: unknown[] = [];
  const quiet = await main([], {
    ...plain.io,
    every: (...a: unknown[]) => (none.push(a), { unref() {} }),
    writeCode: async () => undefined,
  });
  assert.equal(none.length, 0);
  await quiet!.stop();
});

test('with the real file system and timers it writes the file and a renewing host stops cleanly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dev-cli-'));
  try {
    const r = rig();
    const { writeCode: _stub, ...io } = r.io;
    const running = await main(['--renew', '--dir', dir], io);
    assert.equal(readFileSync(path.join(dir, 'pairing-code.txt'), 'utf8'), '{"v":1,"relay":"x"}');
    await running!.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scenarios lists the bench scenarios and run starts one, reporting a wrong name instead of failing', async () => {
  const r = rig();
  const running = await main([], r.io);
  r.stdin.write('scenarios\nRUN PLAN long\nrun nope\nrun\n');
  await until(
    () => r.out.some((t) => t === 'started plan long') && r.out.filter((t) => t.includes('No scenario')).length === 2,
    'the replies',
  );
  assert.ok(r.out.some((t) => /^ {2}run plan \[long\] {20,}a plan card$/.test(t)));
  assert.ok(r.out.includes('No scenario "nope".'));
  assert.ok(r.out.includes('No scenario "".'));
  await running!.stop();
});

test('--real-host sets the Host up first, hands it to the host with fake machines on, and takes it away again on stop (unless --keep-host)', async () => {
  for (const keep of [false, true]) {
    const r = rig();
    const made: any[] = [];
    const stops: any[] = [];
    r.io.makeRealHost = async (o: any) => (made.push(o), { stop: async (s: any) => void stops.push(s) });
    const running = await main(
      ['--real-host', 'mopilot-bench', '--port', '9100', '--vm-gateway', '10.0.0.1', ...(keep ? ['--keep-host'] : [])],
      r.io,
    );
    assert.deepEqual([made[0].vm, made[0].relayPort, made[0].gateway, made[0].log === r.io.out], ['mopilot-bench', 9100, '10.0.0.1', true]);
    assert.equal(r.calls[0].fakeHosts, true, 'the real Host is joined by the made-up machines');
    assert.equal(r.calls[0].realHost.stop !== undefined, true);
    await running!.stop();
    assert.deepEqual(stops, [{ keep }]);
  }
  const plain = rig();
  plain.io.makeRealHost = async () => assert.fail('no Host unless asked');
  await main([], plain.io);
  assert.equal(plain.calls[0].realHost, null);
  assert.equal('gateway' in made(plain), false);
});

test('a host that fails to start, or to show its code, leaves no real Host installed behind it', async () => {
  const stops: any[] = [];
  const realHost = { stop: async (s: any) => void stops.push(s) };
  const failing = rig();
  failing.io.makeRealHost = async () => realHost;
  failing.io.start = async () => {
    throw new Error('port taken');
  };
  await assert.rejects(() => main(['--real-host', 'mopilot-bench'], failing.io), /port taken/);
  const noCode = rig({ failsAlways: true } as any);
  noCode.io.makeRealHost = async () => realHost;
  noCode.state.fail = true;
  await assert.rejects(() => main(['--real-host', 'mopilot-bench', '--keep-host'], noCode.io));
  assert.deepEqual(stops, [{ keep: false }, { keep: true }]);
});

function made(r: { calls: any[] }) {
  return r.calls[0];
}
