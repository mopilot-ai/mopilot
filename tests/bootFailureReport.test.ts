// Add by command reports why the machine's script stopped (#5024, audit states:M31): the script's `fail <code>` sends the code to the
// relay, the relay hands it to the app's lane, and the boot shows the real cause as the card's `failed` view (Try again makes a new
// command). Covers the script's report line, the relay's report path (a live boot, a gone one, the cap, the boot host) and the boot's
// word for each code, with the codes it ignores (an unknown one, one after hello).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createBoots, REPORT_TIMES } from '../relay/src/boot.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { createCrypto } from '../shared/remote/crypto.mjs';
import { enrollKeys, sealEnroll } from '../shared/host/relayEnroll.mjs';
import { toBase64 } from '../shared/remote/envelope.mjs';

const require = createRequire(import.meta.url);
const { bootScript } = require('../electron/host/bootScript.cjs');
const { createRelayBoot } = require('../electron/host/relayBoot.cjs');
const { CORE_BUILDS } = require('../shared/host/coreBuild.mjs');

const enrollment = { relayUrl: 'wss://r/v1/ws', hostId: 'h_x', secret: 's', pairId: 'p_x' };
const bundles = Object.fromEntries(CORE_BUILDS.map((b: string) => [b, '0'.repeat(64)]));
const REPORT_URL = 'https://relay.example/v1/boot/b_x/report';

test('the script reports its reason code to the relay before it exits, and says nothing to it when it has no report url', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfr-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\necho "$@" >> "${dir}/curl.log"\n`, { mode: 0o755 });
  const run = (script: string) =>
    spawnSync('/bin/sh', ['-s', '--', 'short'], { input: script, env: { HOME: dir, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  const withReport = run(bootScript({ bundleUrl: 'https://relay.example/v1/boot/b_x/bundle', bundles, enrollment, reportUrl: REPORT_URL }));
  assert.equal(withReport.status, 1);
  assert.match(withReport.stderr, /MoPilot: Run the whole command MoPilot showed/, 'the terminal still says it');
  assert.match(
    fs.readFileSync(path.join(dir, 'curl.log'), 'utf8'),
    /-o \/dev\/null https:\/\/relay\.example\/v1\/boot\/b_x\/report\/usage$/m,
  );
  fs.rmSync(path.join(dir, 'curl.log'));
  const without = run(bootScript({ bundleUrl: 'https://relay.example/v1/boot/b_x/bundle', bundles, enrollment }));
  assert.equal(without.status, 1);
  assert.equal(fs.existsSync(path.join(dir, 'curl.log')), false);
  fs.rmSync(dir, { recursive: true, force: true });
  // every stop carries its own code
  const text = bootScript({ bundleUrl: 'https://relay.example/b', bundles, enrollment, reportUrl: REPORT_URL, updateKeyPem: 'k' });
  for (const code of [
    'usage',
    'tar',
    'sha',
    'os',
    'node_download',
    'node_run',
    'no_build',
    'download',
    'checksum',
    'unpack',
    'service',
    'update_key',
    'start',
  ])
    assert.match(text, new RegExp(`fail ${code} `), code);
  assert.equal(spawnSync('/bin/sh', ['-n'], { input: text }).status, 0);
});

/** The relay's boots, with a lane that records what it is sent. */
function relayRig(origin: string | null = null) {
  const sent: any[] = [];
  const lane = { id: 'lane' };
  const hub: any = { conns: new Map([['mac1', lane]]), send: async (_l: any, m: any) => void sent.push(m), config: { trustProxy: false } };
  const boots = createBoots({ now: () => 1000, origin });
  const BOOT = `b_${'A'.repeat(22)}`;
  boots.register({ identity: { userId: 'u1', deviceId: 'mac1' } } as any, { boot: BOOT, host: 'h_host0000000000001' });
  const get = (p: string, host = 'relay.example', method = 'GET') => {
    const res: any = {
      status: 0,
      ended: false,
      writeHead(s: number) {
        this.status = s;
        return this;
      },
      end() {
        this.ended = true;
      },
    };
    const handled = boots.serve(hub, { method, headers: { host }, socket: { remoteAddress: '203.0.113.9' } } as any, res, p);
    return { handled, res };
  };
  return { boots, hub, sent, get, BOOT };
}

test('the relay passes a report to the boot’s lane and answers 204 at once; a gone boot, an away lane, past the cap and the wrong host get 404', () => {
  const r = relayRig();
  const ok = r.get(`/v1/boot/${r.BOOT}/report/tar`);
  assert.equal(ok.handled, true);
  assert.equal(ok.res.status, 204);
  assert.equal(r.sent.length, 1);
  assert.deepEqual(
    { ...r.sent[0], req: 'x' },
    { t: 'event', ev: 'boot.request', boot: r.BOOT, req: 'x', what: 'report', code: 'tar', ip: '203.0.113.9' },
  );
  for (let i = 1; i < REPORT_TIMES; i++) assert.equal(r.get(`/v1/boot/${r.BOOT}/report/tar`).res.status, 204);
  assert.equal(r.get(`/v1/boot/${r.BOOT}/report/tar`).res.status, 404, 'a few reports per boot');
  assert.equal(r.sent.length, REPORT_TIMES);
  assert.equal(r.get(`/v1/boot/b_${'N'.repeat(22)}/report/tar`).res.status, 404, 'a boot nobody registered');
  assert.equal(r.get(`/v1/boot/${r.BOOT}/report/Tar!`).handled, false, 'a code outside the alphabet is not a report');
  assert.equal(r.get(`/v1/boot/${r.BOOT}/report/tar`, 'relay.example', 'POST').handled, false);
  const away = relayRig();
  away.hub.conns.clear();
  assert.equal(away.get(`/v1/boot/${away.BOOT}/report/tar`).res.status, 404);
  assert.equal(away.sent.length, 0);
  const moved = relayRig('https://boot.example');
  assert.equal(moved.get(`/v1/boot/${moved.BOOT}/report/tar`, 'relay.example').res.status, 404);
  assert.equal(moved.get(`/v1/boot/${moved.BOOT}/report/tar`, 'boot.example').res.status, 204);
});

const prim = createNodePrimitives();
const c = createCrypto(prim);

function bootRig() {
  const lane: any = {
    routes: {} as Record<string, any>,
    boot: null as any,
    route: (pair: string, r: any) => ((lane.routes[pair] = r), () => delete lane.routes[pair]),
    onBoot: (fn: any) => ((lane.boot = fn), () => (lane.boot = null)),
    whenOpen: async () => undefined,
    intend: () => undefined,
    settle: () => undefined,
    register: async () => undefined,
    request: async () => undefined,
    revoke: async () => undefined,
    send: () => true,
    notify: () => true,
    device: 'mac~h',
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfr-b-')), 'b.tgz');
  fs.writeFileSync(file, 'b');
  const sha = crypto.createHash('sha256').update('b').digest('hex');
  const views: any[] = [];
  const boot = createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://r/v1/ws',
    bundle: () => ({ file, sha256: sha, version: '1' }),
    onChange: (v: any) => views.push(v),
  });
  return { lane, boot, views };
}

test('a reported reason becomes the card’s failed view with its own words; unknown codes and reports after hello change nothing', async () => {
  for (const [code, text] of [
    ['usage', /whole command/],
    ['tar', /no tar/],
    ['sha', /sha256sum/],
    ['os', /macOS and Linux/],
    ['no_build', /no Host build/],
    ['node_download', /download Node/],
    ['node_run', /does not run/],
    ['download', /Keep MoPilot open/],
    ['checksum', /checksum/],
    ['unpack', /disk space/],
  ] as const) {
    const { lane, boot } = bootRig();
    const v = await boot.start();
    const bootId = /\/v1\/boot\/(b_[\w-]+)' -o/.exec(v.command)![1];
    lane.boot({ boot: bootId, req: 'r', what: 'report', code, ip: '' });
    assert.equal(boot.view.state, 'failed', code);
    assert.match(boot.view.error, text, code);
    assert.equal(boot.view.command, '');
    assert.equal(lane.boot, null, 'the boot let go of its route');
  }
  // a code this app has no words for (including `hasOwn`-free names) and a report with no code change nothing
  const { lane, boot } = bootRig();
  const v = await boot.start();
  const bootId = /\/v1\/boot\/(b_[\w-]+)' -o/.exec(v.command)![1];
  lane.boot({ boot: bootId, req: 'r', what: 'report', code: 'toString', ip: '' });
  lane.boot({ boot: bootId, req: 'r', what: 'report', code: 'service', ip: '' });
  lane.boot({ boot: bootId, req: 'r', what: 'report', ip: '' });
  assert.equal(boot.view.state, 'waiting');
  // once the machine has said hello it is asking to join: a later report is not the command's failure
  const code = /sh "\$f" ([\w-]+);/.exec(v.command)![1];
  const pair = Object.keys(lane.routes)[0];
  const keys = enrollKeys(c, code, pair);
  const hello = sealEnroll(prim, keys.p2m, pair, 'p2m', {
    v: 1,
    hostPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
    hostEphPub: toBase64(prim.x25519Base(prim.randomBytes(32))),
    name: 'box',
  });
  lane.routes[pair].onFrame(hello);
  assert.equal(boot.view.state, 'asking');
  lane.boot({ boot: bootId, req: 'r', what: 'report', code: 'tar', ip: '' });
  assert.equal(boot.view.state, 'asking');
  boot.dispose();
});
