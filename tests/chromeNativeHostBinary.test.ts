// The real sage-mcp native host (native/sage-mcp ChromeHost.swift) against main's end (#1632, #1986): Chrome's message to main and main's answer back, and "Open MoPilot" starting the app it runs from.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hostServer, STORE } from './support/native-host-kit.ts';

const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));
const server = (o: any = {}) => hostServer(stops, o);

const SAGE_MCP = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'native', 'sage-mcp', 'build', 'sage-mcp');

test('the real host (sage-mcp --chrome-native-host) passes Chrome’s message to main and main’s answer back', {
  skip: !fs.existsSync(SAGE_MCP) && 'sage-mcp is not built here',
}, async () => {
  const seen: any[] = [];
  const { socket } = await server({ verify: async (v: any) => (seen.push(v), null) });
  const host = (sock: string) =>
    new Promise<any>((resolve) => {
      const p = spawn(SAGE_MCP, ['--chrome-native-host', sock, `chrome-extension://${STORE}/`]);
      const body = Buffer.from(JSON.stringify({ type: 'claim', protocol: 1 }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      p.stdin.end(Buffer.concat([head, body]));
      const out: Buffer[] = [];
      p.stdout.on('data', (d) => out.push(d));
      p.on('close', () => {
        const b = Buffer.concat(out);
        assert.equal(b.readUInt32LE(0), b.length - 4);
        resolve(JSON.parse(b.subarray(4).toString()));
      });
    });
  assert.deepEqual(await host(socket), { type: 'claim', code: `mopilot-claim:1:47615:${'c'.repeat(32)}` });
  assert.equal(seen[0].origin, `chrome-extension://${STORE}/`);
  assert.ok(Number.isInteger(seen[0].pid) && seen[0].pid > 1);
  assert.deepEqual(await host(path.join(os.tmpdir(), 'nothing-here.sock')), { type: 'none', reason: "MoPilot isn't running" });
  // "Open MoPilot" from Chrome with the app not running: a host inside an app starts it and says so; a developer
  // build's host (no app around it) can't (#1986). MOPILOT_HOST_OPEN stands in for /usr/bin/open.
  const openApp = (bin: string, env: Record<string, string> = {}) =>
    new Promise<any>((resolve) => {
      const p = spawn(bin, ['--chrome-native-host', path.join(os.tmpdir(), 'nothing-here.sock'), `chrome-extension://${STORE}/`], {
        env: { ...process.env, ...env },
      });
      const body = Buffer.from(JSON.stringify({ type: 'open', protocol: 1, what: 'app' }));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      p.stdin.end(Buffer.concat([head, body]));
      const out: Buffer[] = [];
      p.stdout.on('data', (d) => out.push(d));
      p.on('close', () => resolve(JSON.parse(Buffer.concat(out).subarray(4).toString())));
    });
  assert.deepEqual(await openApp(SAGE_MCP), { type: 'none', reason: "MoPilot isn't running" });
  const helpers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-app-')), 'MoPilot.app', 'Contents', 'Helpers');
  fs.mkdirSync(helpers, { recursive: true });
  fs.copyFileSync(SAGE_MCP, path.join(helpers, 'sage-mcp'));
  fs.chmodSync(path.join(helpers, 'sage-mcp'), 0o755);
  const inApp = path.join(helpers, 'sage-mcp');
  assert.deepEqual(await openApp(inApp, { MOPILOT_HOST_OPEN: '/usr/bin/true' }), {
    type: 'none',
    starting: true,
    reason: 'Starting MoPilot',
  });
  assert.deepEqual(await openApp(inApp, { MOPILOT_HOST_OPEN: '/usr/bin/false' }), { type: 'none', reason: "MoPilot isn't running" });
});
