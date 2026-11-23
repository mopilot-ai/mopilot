// Invariant (C1): a cloud provider's key never reaches a Host, a log, an argument list or the relay: it is read only to build the signer in this process, so nothing the launcher hands on carries it, on success or on any failure, and the launcher code has no way to put it on a command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createFakeProvider } from '../shared/cloud/adapter.mjs';
import { createOciAdapter } from '../shared/cloud/oci.mjs';

const require = createRequire(import.meta.url);
const { createCloudLauncher } = require('../electron/host/cloudLauncher.cjs');
const { createCloudKeys } = require('../electron/host/cloudKeys.cjs');

const SECRET = 'PRIVATE-KEY-SENTINEL-7f3a';
const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s).reverse(),
  decryptString: (b: Buffer) => Buffer.from(b).reverse().toString(),
};

test('nothing the launcher hands on, logs or writes carries the key, on success and on failure', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-key-'));
  const keys = createCloudKeys({
    file: path.join(home, 'keys.json'),
    safeStorage: safe,
  });
  keys.set('fake', { privateKeyPem: SECRET });
  const seen: string[] = [];
  const logs: string[] = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = console.log = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  try {
    for (const fail of [false, true]) {
      const provider = createFakeProvider();
      const original = provider.create.bind(provider);
      provider.create = async (s: any) => {
        seen.push(JSON.stringify(s));
        const made = await original(s);
        provider.set(made.id, 'running');
        if (fail) throw new Error('boom');
        return made;
      };
      const launcher = createCloudLauncher({
        file: path.join(home, `i${fail}.json`),
        keys,
        makeAdapter: (_p: string, credential: any) => (credential.privateKeyPem === SECRET ? provider : null),
        makeBoot: ({ onView }: any) => ({
          start: async () => ({ state: 'waiting', command: 'JOIN' }),
          allow: (extra: any) => (seen.push(JSON.stringify(extra)), { id: 'relay:x' }),
          deny: () => undefined,
          arrive: setTimeout(() => onView({ state: 'asking' }), 5),
        }),
        onStep: (s: any) => seen.push(JSON.stringify(s)),
        sleep: async () => undefined,
      });
      await launcher
        .launch({
          launch: `l${fail}`,
          provider: 'fake',
          name: 'n',
          size: 's',
          region: 'r',
        })
        .catch((e: any) => seen.push(e.message));
      seen.push(JSON.stringify(provider.calls));
    }
  } finally {
    console.error = realError;
    console.log = realLog;
  }
  for (const f of fs.readdirSync(home)) if (f !== 'keys.json') seen.push(fs.readFileSync(path.join(home, f), 'utf8'));
  assert.ok(seen.length > 6);
  assert.equal(
    seen.concat(logs).some((s) => s.includes(SECRET)),
    false,
  );
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'keys.json'), 'utf8'), new RegExp(SECRET), 'and it is not on disk in plain text');
});

test('the adapter is given a signer, never the key: a request carries the signature and nothing else of it', async () => {
  const sent: string[] = [];
  const adapter = createOciAdapter({
    config: {
      tenancy: 't',
      user: 'u',
      fingerprint: 'f',
      region: 'r',
      compartmentId: 'c',
      subnetId: 's',
    },
    fetch: (async (url: string, init: any) => (
      sent.push(url, JSON.stringify(init)), { ok: true, status: 200, text: async () => '[]' }
    )) as any,
    sign: () => 'SIGNATURE',
  });
  await adapter.regions();
  assert.equal(sent.join('').includes(SECRET), false);
  assert.match(sent[1], /signature=\\"SIGNATURE\\"/);
});

test('the launcher and the provider files have no way to put a key on a command line or into a Host', () => {
  for (const file of [
    'electron/host/cloudLauncher.cjs',
    'electron/host/cloudKeys.cjs',
    'shared/cloud/adapter.mjs',
    'shared/cloud/oci.mjs',
  ]) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
    assert.doesNotMatch(source, /child_process|process\.argv|spawn\(|exec\(|execFile|console\.(log|error|warn)/, file);
  }
});
