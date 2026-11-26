// The app's crypto in Electron's own runtime (#5734): Electron's BoringSSL has no ChaCha20-Poly1305, so a module of the app that seals with node:crypto's (shared/remote/nodePrimitives.mjs) fails there with ERR_CRYPTO_UNKNOWN_CIPHER, while every unit test runs on plain Node, where it works. This runs fixtures/appCryptoProbe.mjs with Electron as Node (ELECTRON_RUN_AS_NODE=1, no window): the node:crypto primitives the app uses (AES-256-GCM, X25519, HKDF-SHA256, Ed25519, HMAC-SHA256), a whole pairing by code on the app's crypto, and bytes through the app's relay tunnel (relayPaths and relayTunnel with their default primitives) to a Host's relay links on plain Node (fixtures/relayHostSide.mjs) and back.
// e2e-covers: electron/platform/sodiumPrimitives.cjs electron/host/relayPaths.cjs electron/host/relayTunnel.cjs electron/host/codePairWiring.cjs electron/host/relayBoot.cjs
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');
// the Electron binary the app runs on (node_modules/electron's own path)
const ELECTRON = require('electron') as unknown as string;

test('in Electron’s runtime the app’s crypto seals, pairs by code and carries bytes through its relay tunnel, and the node:crypto it uses works', async () => {
  test.setTimeout(120_000);
  // sockets need a short path: the runner's own temp folder can be too deep for one
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'appcr-')));
  const side = spawn(process.execPath, [path.join(__dirname, 'fixtures/relayHostSide.mjs'), path.join(dir, 'host')], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const first = await new Promise<string>((resolve, reject) => {
      readline.createInterface({ input: side.stdout! }).once('line', resolve);
      side.once('exit', (code) => reject(new Error(`the machine's side ended (${code}) before it was ready`)));
    });
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const out = execFileSync(ELECTRON, [path.join(__dirname, 'fixtures/appCryptoProbe.mjs'), dir, first], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 90_000,
    });
    const result = JSON.parse(out.trim().split('\n').at(-1)!);
    console.log(
      `${result.runtime}\n${result.checks.map((c: any) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.why ? `: ${c.why}` : ''}`).join('\n')}`,
    );
    expect(result.runtime).toMatch(/^electron /);
    expect(result.checks.length).toBe(8);
    expect(result.checks.filter((c: any) => !c.ok)).toEqual([]);
  } finally {
    side.stdin!.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
