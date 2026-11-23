// Add by command in the app (electron/host/relayBoot.cjs) with a relay that serves boots on a host of their own (finding H-2): the command and the script it pins fetch from the host the relay names, a name that is not a plain https origin is ignored, and an account past its day's boots is told so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createRelayBoot } = require('../electron/host/relayBoot.cjs');

const bundleFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rbo-')), 'b.tgz');
fs.writeFileSync(bundleFile, 'bundle bytes');
const sha = crypto.createHash('sha256').update('bundle bytes').digest('hex');

const made: any[] = [];
test.after(() => {
  for (const b of made) b.dispose();
});
function boot(answer: () => Promise<any>) {
  const lane: any = {
    revoked: [] as string[],
    route: () => () => undefined,
    onBoot: (fn: any) => ((lane.boot = fn), () => (lane.boot = null)),
    whenOpen: async () => undefined,
    intend: () => undefined,
    settle: () => undefined,
    register: async () => undefined,
    request: async (m: any) => (m.t === 'host.boot' ? answer() : undefined),
    revoke: async (h: string) => void lane.revoked.push(h),
    send: () => true,
    notify: () => true,
    device: 'mac~h',
  };
  const b = createRelayBoot({
    lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://relay.example/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: sha, version: '1' }),
  });
  made.push(b);
  return { b, lane };
}
/** The script the command pins, as the app serves it to the lane. */
async function servedScript(b: any, lane: any, bootId: string) {
  const sent: any[] = [];
  lane.notify = (m: any) => (sent.push(m), true);
  lane.boot({ boot: bootId, req: 'r1', what: 'script', ip: '' });
  await waitFor(() => sent.some((m) => m.end), 'the script sent whole');
  return Buffer.concat(sent.filter((m) => m.data).map((m) => Buffer.from(m.data, 'base64'))).toString();
}

test('the command and its script fetch from the boot host the relay names', async () => {
  const { b, lane } = boot(async () => ({ t: 'ok', op: 'host.boot', base: 'https://boot.example' }));
  const v = await b.start();
  const id = /\/v1\/boot\/(b_[\w-]+)/.exec(v.command)![1];
  assert.match(v.command, new RegExp(`curl -fsSL 'https://boot\\.example/v1/boot/${id}' `));
  assert.doesNotMatch(v.command, /relay\.example/);
  const script = await servedScript(b, lane, id);
  assert.match(script, new RegExp(`https://boot\\.example/v1/boot/${id}/bundle/`));
  assert.doesNotMatch(script, /https:\/\/relay\.example\/v1\/boot/);
});

test('a relay that names no boot host, or one that is not a plain https origin, leaves the relay’s own address', async () => {
  // a host a URL allows but a shell reads as commands (`;`, `$( )`, backticks), upper case, or no dot: never put in the command
  for (const base of [
    undefined,
    'http://boot.example',
    'https://boot.example/x',
    7,
    'not a url',
    'https://a;id;b',
    'https://a$(id)b',
    'https://a`id`b',
    'https://Boot.example',
    'https://boot',
  ]) {
    const { b } = boot(async () => ({ t: 'ok', op: 'host.boot', ...(base !== undefined && { base }) }));
    const v = await b.start();
    assert.match(v.command, /curl -fsSL 'https:\/\/relay\.example\/v1\/boot\/b_/, String(base));
  }
  const { b } = boot(async () => undefined);
  // and the URL is one quoted word of the command, whatever it holds
  assert.match((await b.start()).command, /curl -fsSL '[^']+' -o/);
  assert.match((await b.start()).command, /https:\/\/relay\.example\/v1\/boot\//);
});

test('an account past its day’s boots is told so, and the credential made for it is revoked', async () => {
  const { b, lane } = boot(async () => {
    throw Object.assign(new Error('The relay refused: boot_quota'), { code: 'boot_quota' });
  });
  const v = await b.start();
  assert.equal(v.state, 'failed');
  assert.match(v.error, /as many commands as one account may in a day/);
  assert.equal(lane.revoked.length, 1);
  // a failure after the relay took the boot ends it there too
  const late: any[] = [];
  const after = boot(async () => ({ t: 'ok', op: 'host.boot' }));
  const request = after.lane.request;
  // the relay may not take the unboot either: that is only noted
  after.lane.request = async (m: any) => (late.push(m.t), m.t === 'host.unboot' ? Promise.reject(new Error('gone')) : request(m));
  const broken = createRelayBoot({
    lane: after.lane,
    paths: { adopt: () => undefined },
    url: () => 'wss://relay.example/v1/ws',
    bundle: () => ({ file: bundleFile, sha256: sha, version: '1' }),
    updateKeyPem: () => {
      throw new Error('no key');
    },
  });
  made.push(broken);
  assert.equal((await broken.start()).state, 'failed');
  assert.deepEqual(late, ['host.boot', 'host.unboot']);
  // anything else the relay path throws, even no error at all, is the plain could-not-reach message
  const odd = boot(() => Promise.reject(null));
  assert.match((await odd.b.start()).error, /could not reach its relay/);
});
