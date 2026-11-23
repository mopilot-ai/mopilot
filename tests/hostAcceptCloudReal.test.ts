// The real cloud acceptance run (scripts/host-accept/cloud): the app's launcher, adapter and wake code against a stand-in Oracle Cloud and a stand-in Host, the stand-in boot, the teardown that always runs, and the report (W: a step that fails, A: capacity and a machine that will not go, B: the plan's limits, I: what OCI really answers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../scripts/host-accept.mjs';
import { bootCommand } from '../scripts/host-accept/cloud/boot.mjs';
import { createStandInBoot } from '../scripts/host-accept/cloud/boot.mjs';
import { createReaders } from '../scripts/host-accept/cloud/readers.mjs';
import { cloudSteps } from '../scripts/host-accept/cloud/cloudSteps.mjs';
import { cloudDefaults } from '../scripts/host-accept/cloud/deps.mjs';
import { LIMITS } from '../scripts/host-accept/cloud/limits.mjs';
import { timingsText } from '../scripts/host-accept/cloud/real.mjs';
import { launcherFor, makeKey, sshOptions } from '../scripts/host-accept/cloud/ssh.mjs';
import { tearDown } from '../scripts/host-accept/cloud/teardown.mjs';
import { ADS, CONFIG, fakeHost, fakeOci, type HostOptions, type OciOptions } from './support/fakeOci.ts';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest mopilot-accept';

/** A whole run against the stand-ins; `hostStep` may replace the Host steps by id. */
async function run(
  oci: OciOptions = {},
  host: HostOptions = {},
  extra: { steps?: Record<string, any>; signals?: EventEmitter; hostStep?: (id: string) => any } = {},
) {
  const o = fakeOci(oci);
  const h = fakeHost(o, host);
  const out: string[] = [];
  const exits: number[] = [];
  let clock = 1_000_000;
  const signals = extra.signals ?? new EventEmitter();
  const stub = (id: string, text = id) => ({
    id,
    title: `stub ${id}`,
    async run(ctx: any) {
      if (id === 'A3') Object.assign(ctx.state, { socket: '/h/host.sock', dataDir: '/h' });
      return text;
    },
  });
  const steps: Record<string, any> = { A3: stub('A3'), A5: stub('A5'), A6: stub('A6'), S10: stub('S10'), ...extra.steps };
  const code = await main(['--milestone', 'M4', '--cloud', 'oci', '--secrets', '/secrets'], {
    out: (t: string) => out.push(t),
    deps: (() => ({
      buildBundle: () => ({ files: 3, sha256: 'a'.repeat(64), version: '9' }),
      authenticate: async () => undefined,
      helloParams: () => ({}),
    })) as any,
    channelFor: (() => assert.fail('no machine')) as any,
    cloud: {
      readSecrets: () => ({ config: CONFIG, sign: () => 'sig' }),
      fetch: o.fetch,
      makeChannel: h.makeChannel,
      keygen: (dir: string) => ({ keyFile: path.join(dir, 'id'), pub: PUB }),
      sleep: async (ms: number) => {
        clock += ms;
        // a wait that lets timers and I/O run: a loop of waits that only awaited promises would starve them
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => clock,
      pollMs: 3000,
      lookMs: 0,
      signals,
      exit: (c: number) => exits.push(c),
      hostStep: extra.hostStep ?? ((id: string) => steps[id]),
    },
  });
  return { code, out: out.join('\n'), oci: o, host: h, exits, signals };
}

const statusOf = (report: string, id: string) => new RegExp(`\\| ${id} [^|]*\\| (PASS|FAIL|SKIP) \\|`).exec(report)?.[1];
const writes = (o: ReturnType<typeof fakeOci>) => o.state.log.filter((l) => !l.startsWith('GET '));

test('W: a whole run makes one A1 machine, installs, runs a turn, stops it, wakes it, holds a limit, and leaves the compartment empty', async () => {
  const r = await run();
  assert.equal(r.code, 0, r.out);
  for (const id of ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'C1', 'C2', 'A2', 'A3', 'C2n', 'A5', 'A6', 'C3b', 'C4', 'S10', 'C6'])
    assert.equal(statusOf(r.out, id), 'PASS', `${id}\n${r.out}`);
  assert.equal(statusOf(r.out, 'C3'), 'SKIP');
  // the Host builds its idle stop now (host/src/cloudIdle.mjs), so the dry check passes and the run says it does not yet wait the idle time out
  assert.match(r.out, /The Host builds createIdleStop now, but this run does not wait out the idle time yet/);
  assert.match(r.out, /create→running .* running→SSH .*/);
  assert.match(r.out, /wake→Host answering .*wake→reply .*waking → online/);
  assert.match(r.out, /the compartment holds no machine and no disk/);
  assert.match(r.out, /#### Timings[\s\S]*terminate→compartment empty \| \d/);
  assert.match(r.out, /NOT COVERED: boot from a released Host bundle/);
  // what was made: one machine of the free shape, 1 OCPU, 6 GB, 50 GB, the first domain, the run's key in its first-boot script
  assert.equal(r.oci.state.creates.length, 1);
  const body = r.oci.state.creates[0];
  assert.deepEqual(
    [body.shape, body.shapeConfig, body.sourceDetails.bootVolumeSizeInGBs, body.availabilityDomain, body.compartmentId],
    [LIMITS.shape, { ocpus: 1, memoryInGBs: 6 }, 50, ADS[0], CONFIG.compartmentId],
  );
  assert.match(body.displayName, /^mopilot-accept-/);
  const script = Buffer.from(body.metadata.user_data, 'base64').toString();
  assert.ok(script.startsWith('#!/bin/sh\n') && script.includes(PUB) && script.includes('netcat-openbsd'));
  // the only writes: create, stop, start, delete (the machine and its disk together)
  assert.deepEqual(
    writes(r.oci).map((l) => l.replace(/ocid1\.instance\.\d/, 'ID')),
    [
      'POST /instances',
      'POST /instances/ID?action=SOFTSTOP',
      'POST /instances/ID?action=START',
      'DELETE /instances/ID?preserveBootVolume=false',
    ],
  );
  assert.deepEqual(r.oci.state.actions, ['SOFTSTOP', 'START']);
  assert.ok(
    r.oci.state.log.every(
      (l) => !l.includes('root') && (l.includes(encodeURIComponent(CONFIG.compartmentId)) || !l.includes('compartmentId')),
    ),
    'only this compartment',
  );
  // every ssh call goes to the Ubuntu user at the machine's address with the run's key
  const all = r.host.seen.launchers;
  assert.ok(all.length > 5 && all.every((a) => a.includes('ubuntu@203.0.113.7') && a.includes('IdentitiesOnly=yes')));
});

test('A: a full availability domain moves on to the next one, and three full ones stop the run without a loop', async () => {
  const second = await run({ capacityIn: [ADS[0]] });
  assert.equal(second.code, 0, second.out);
  assert.deepEqual(
    second.oci.state.creates.map((c) => c.availabilityDomain),
    [ADS[0], ADS[1]],
  );
  assert.match(second.out, /in PHX-AD-2/);
  const none = await run({ capacityIn: ADS });
  assert.equal(none.code, 1);
  assert.equal(none.oci.state.creates.length, 3, 'one try in each domain, then stop');
  assert.match(
    none.out,
    /No capacity for VM\.Standard\.A1\.Flex:1:6 in any availability domain \(PHX-AD-1, PHX-AD-2, PHX-AD-3\): stopping, not retrying/,
  );
  assert.equal(statusOf(none.out, 'C1'), 'FAIL');
  assert.equal(statusOf(none.out, 'A3'), 'SKIP', 'nothing after a failed create runs');
  assert.equal(statusOf(none.out, 'C6'), 'PASS');
  assert.match(none.out, /not reached/);
});

test('A: nothing is launched when the compartment is not empty or a check fails', async () => {
  const r = await run({ preExisting: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /Nothing was launched: a check above failed/);
  assert.match(r.out, /Not empty \(prod-thing RUNNING\)/);
  assert.equal(writes(r.oci).length, 0, 'not one write');
});

test('W: a step that fails still ends in the machine deleted and the compartment read empty', async () => {
  const r = await run(
    {},
    {},
    {
      steps: {
        A5: {
          id: 'A5',
          title: 'pairing',
          async run() {
            throw new Error('pairing refused');
          },
        },
      },
    },
  );
  assert.equal(r.code, 1);
  assert.equal(statusOf(r.out, 'A5'), 'FAIL');
  assert.equal(statusOf(r.out, 'A6'), 'SKIP');
  assert.equal(statusOf(r.out, 'C6'), 'PASS');
  assert.deepEqual(
    writes(r.oci).map((l) => l.split('?')[0].replace(/ocid1\.instance\.\d/, 'ID')),
    ['POST /instances', 'DELETE /instances/ID'],
  );
});

test('I: the cells that read the machine say what is missing, and the run does not pass over them', async () => {
  for (const [host, re] of [
    [{ noNc: true }, /The machine lacks nc\./],
    [{ askFails: true }, /The machine could not be asked: Permission denied/],
    [{ notLinux: true }, /Expected Linux, got Darwin arm64/],
    [{ noNode: true }, /The installer left no Node for the Host/],
  ] as const) {
    const r = await run({}, host);
    assert.equal(r.code, 1);
    assert.match(r.out, re);
    assert.equal(statusOf(r.out, 'C6'), 'PASS', 'and the machine is deleted');
  }
});

test('A: a Stop that leaves the machine STOPPING is a failed cell, and a wake that never finds the Host is too', async () => {
  const stuck = await run({ stopStuck: true });
  assert.equal(statusOf(stuck.out, 'C3b'), 'FAIL');
  assert.match(stuck.out, /The provider's list shows the machine as STOPPING, not STOPPED/);
  const dark = await run({ noAddressAfterStart: true });
  assert.equal(statusOf(dark.out, 'C4'), 'FAIL');
  assert.match(dark.out, /The wake ended failed: The machine started but its Host did not answer\. \(waking → failed\)/);
  const never = await run({}, { slowHost: 1000 });
  assert.equal(statusOf(never.out, 'C4'), 'FAIL');
  assert.match(never.out, /waking → failed\); the last look: Timed out waiting for the Host to answer/);
  const slow = await run({}, { slowHost: 2 });
  assert.equal(statusOf(slow.out, 'C4'), 'PASS', slow.out);
  assert.ok(slow.host.seen.looks === 3, 'the wake looked again until the Host answered');
});

test('I: the boot watcher tolerates reads that fail and an SSH that is not ready yet', async () => {
  const r = await run({ listFailures: 2, listOkFirst: 2 }, { sshFailures: 2 });
  assert.equal(r.code, 0, r.out);
  assert.ok(r.host.seen.launchers.filter((a) => a.at(-1) === 'true').length >= 3, 'SSH was tried until it answered');
});

test('A: a machine that will not go, or a disk it leaves, is dealt with, and said when it cannot be', async () => {
  const orphan = await run({ keepDisk: true });
  assert.equal(orphan.code, 0, orphan.out);
  assert.ok(
    orphan.oci.state.deletes.some((d) => d.startsWith('/bootVolumes/')),
    'the disk was deleted itself after a grace',
  );
  const refused = await run({ deleteRefused: true });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /STILL THERE after 600 s: mopilot-accept-\w+ RUNNING, boot disk 50 GB AVAILABLE/);
  assert.match(refused.out, /delete a machine: cannot delete now/);
});

test('W: a Ctrl-C runs the one teardown, and the end of the run does not repeat it', async () => {
  const signals = new EventEmitter();
  const r = await run(
    {},
    {},
    {
      signals,
      steps: {
        A6: {
          id: 'A6',
          title: 'turn',
          async run() {
            signals.emit('SIGINT');
            await new Promise((res) => setTimeout(res, 20));
            return 'done';
          },
        },
      },
    },
  );
  assert.deepEqual(r.exits, [130]);
  assert.equal(r.oci.state.deletes.length, 1, 'one delete of the machine');
  assert.equal(signals.listenerCount('SIGINT') + signals.listenerCount('SIGTERM'), 0, 'the handlers are gone');
});

test("B: the Host steps are the Host acceptance run's own unless a test replaces them, and the plan's cells are all there", () => {
  assert.deepEqual(
    cloudSteps().map((s) => s.id),
    ['C1', 'C2', 'A2', 'A3', 'C2n', 'A5', 'A6', 'C3', 'C3b', 'C4', 'S10'],
  );
  assert.ok(
    cloudSteps()
      .filter((s) => ['C1', 'C2', 'A2', 'A3', 'C2n', 'A5', 'A6'].includes(s.id))
      .every((s) => (s as any).fatal),
    'the machine and its Host are required',
  );
  assert.match(
    timingsText({ create: 0, running: 1000, ssh: 3000, hostAnswered: 9000, stop: 4000, wakeHost: 5000, wakeFrame: 6000 }, 7000),
    /create→running \| 1\.0 s[\s\S]*SSH answers→Host answering \(install\) \| 6\.0 s[\s\S]*terminate→compartment empty \| 7\.0 s/,
  );
  assert.match(timingsText({}, 1), /create→running \| not reached/);
});

test("B: the run's own key pair, ssh options, first-boot line and defaults", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-key-'));
  const good = (bin: string, args: string[]) => {
    fs.writeFileSync(`${args.at(-1)}.pub`, `${PUB}\n`);
    return { status: 0 } as any;
  };
  assert.deepEqual(makeKey(dir, good as any), { keyFile: path.join(dir, 'id_ed25519'), pub: PUB });
  assert.throws(() => makeKey(dir, (() => ({ status: 1 })) as any), /could not make the run’s key pair/);
  assert.throws(
    () =>
      makeKey(
        dir,
        ((_b: string, a: string[]) => (fs.writeFileSync(`${a.at(-1)}.pub`, "ssh-ed25519 AAAA'; rm -rf / #\n"), { status: 0 })) as any,
      ),
    /unexpected shape/,
  );
  assert.ok(sshOptions('/k').includes('UserKnownHostsFile=/dev/null'));
  const addr = { ip: '198.51.100.9' };
  assert.deepEqual(launcherFor(addr, '/k')('echo hi', false).args.slice(-3), ['--', 'ubuntu@198.51.100.9', 'echo hi']);
  addr.ip = '198.51.100.10';
  assert.ok(launcherFor(addr, '/k')('x', false).args.includes('ubuntu@198.51.100.10'), 'the address is read at each call');
  const line = bootCommand(PUB);
  assert.ok(line.includes(PUB) && line.indexOf('netcat-openbsd') < line.indexOf('authorized_keys'), 'the key goes in after nc is there');
  const d = cloudDefaults();
  t.mock.method(process, 'exit', () => undefined);
  d.exit(0);
  await d.sleep(0);
  assert.ok(d.now() > 0);
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  assert.equal((await d.fetch('https://x.test/')).status, 200);
  assert.equal(typeof d.makeChannel(() => ({ bin: 'true', args: [] })).run, 'function');
});

test('A: the teardown reads what it cannot, deletes what is not its own known machine, and says it when the compartment cannot be read', async () => {
  const o = fakeOci();
  o.state.instances.set('x1', { id: 'x1', displayName: 'stray', lifecycleState: 'RUNNING', ad: ADS[0], started: 0 });
  let clock = 0;
  const base = {
    config: CONFIG,
    sign: () => 'sig',
    ads: ADS,
    made: null,
    pollMs: 3000,
    call: async () => ({}),
    deps: {
      fetch: o.fetch,
      sleep: async (ms: number) => {
        clock += ms;
        // a wait that lets timers and I/O run: a loop of waits that only awaited promises would starve them
        await new Promise((resolve) => setImmediate(resolve));
      },
      now: () => clock,
    },
  };
  // a machine nobody told the run about is deleted too (the compartment was empty when the run began)
  const found = await tearDown({
    ...base,
    readers: {
      look: async () => ({
        live: [...o.state.instances.values()].filter((m) => m.lifecycleState !== 'TERMINATED'),
        volumes: [],
        empty: ![...o.state.instances.values()].some((m) => m.lifecycleState !== 'TERMINATED'),
      }),
    },
  });
  assert.equal(found.ok, true);
  assert.deepEqual(o.state.deletes, ['/instances/x1']);
  // a compartment that cannot be read is said, with why
  clock = 0;
  const blind = await tearDown(
    {
      ...base,
      readers: {
        look: async () => {
          throw new Error('boom');
        },
      },
    },
    { waitMs: 5 },
  );
  assert.equal(blind.ok, false);
  assert.match(blind.detail, /STILL THERE after 0\.005 s: unreadable \(read the compartment: boom/);
});

test('A: a machine that cannot be made for another reason than capacity stops the run at once, and a run that breaks itself still tears down', async () => {
  const limit = await run({ createRefused: 'LimitExceeded' });
  assert.equal(limit.code, 1);
  assert.equal(limit.oci.state.creates.length, 1, 'only a full domain moves on');
  assert.match(limit.out, /The account is at its limit/);
  const watched = await run({ createRefused: 'LimitExceeded', listFailures: 1, listOkFirst: 2 });
  assert.match(watched.out, /The account is at its limit\. \(the watch of the machine last said: try again\)/);
  const broken = await run(
    {},
    {},
    {
      hostStep: () => {
        throw new Error('the steps could not be built');
      },
    },
  );
  assert.equal(broken.code, 1);
  assert.match(broken.out, /C0 The run itself \| FAIL .*the steps could not be built/);
  assert.equal(statusOf(broken.out, 'C6'), 'PASS');
});

test('A: a delete that changes nothing is said without a note, and a block volume left behind is deleted after the grace', async () => {
  const ignored = await run({ deleteIgnored: true });
  assert.equal(ignored.code, 1);
  assert.match(ignored.out, /STILL THERE after 600 s: mopilot-accept-\w+ RUNNING, boot disk 50 GB AVAILABLE \|/);
  assert.ok(!/STILL THERE[^|]*\(delete/.test(ignored.out), 'no note when nothing failed');
  const stray = await run({ strayBlockVolume: true });
  assert.equal(stray.code, 0, stray.out);
  assert.ok(
    stray.oci.state.deletes.some((d) => d.startsWith('/volumes/')),
    'a block volume goes by /volumes',
  );
});

test('B: the stand-in boot has the four calls the launcher knows, the machine step names what the Host run needs, and C3 notices a wired idle stop', async () => {
  const views: any[] = [];
  const boot = createStandInBoot({
    deps: { makeChannel: () => ({ run: async () => ({ code: 1 }) }), now: () => 0, sleep: async () => undefined },
    readers: { instances: async () => [] },
    addr: { ip: '' },
    keyFile: '/k',
    pub: PUB,
    t: {},
  })({
    onView: (v) => views.push(v),
  });
  assert.equal(boot.view().state, 'idle');
  const first = await boot.start();
  assert.deepEqual([first.state, first.command === bootCommand(PUB), boot.view().state, views.length], ['waiting', true, 'waiting', 1]);
  assert.deepEqual(boot.allow({ cloud: { id: 'ocid1.instance.9' } }), { id: 'ocid1.instance.9' });
  boot.deny();
  const idle = cloudSteps().find((s) => s.id === 'C3')!;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-root-'));
  fs.mkdirSync(path.join(root, 'host', 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host', 'src', 'main.mjs'), 'createIdleStop({});');
  assert.match(((await idle.run({ root })) as any).skip, /builds createIdleStop now/);
});

test('I: the public address comes from the first attached card, and a machine with none has none', async () => {
  const answers: Record<string, any> = {
    '/vnicAttachments': [{ lifecycleState: 'DETACHED', vnicId: 'v0' }],
    '/vnics/v1': { publicIp: null },
  };
  const readers = createReaders({ call: async (_m, _s, p) => answers[p.replace('/20160918', '').split('?')[0]] ?? null, config: CONFIG });
  assert.equal(await readers.address('m'), null, 'only an attached card counts');
  answers['/vnicAttachments'] = [{ lifecycleState: 'ATTACHED', vnicId: 'v1' }];
  assert.equal(await readers.address('m'), null, 'a card with no public address');
  answers['/vnics/v1'] = null;
  assert.equal(await readers.address('m'), null, 'no answer');
});
