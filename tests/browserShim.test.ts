// The $BROWSER shim (electron/capabilities/browser/browserShim.cjs): the scripts it writes, routing a
// request to a chat (its own token, or the shared token by the folder of the running turn), the unix
// socket HTTP endpoint, and the real script end to end, run by sh and by node (as vite runs a BROWSER
// ending in .js), including the fallback to the user's own BROWSER when the URL can't open in a pane.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  BrowserShim,
  writeShim,
  pickChat,
  SH_SOURCE,
  JS_SOURCE,
  SCRIPT_NAME,
  SH_NAME,
} = require('../electron/capabilities/browser/browserShim.cjs');
const { systemBrowserEnv } = require('../electron/platform/browserEnv.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bshim-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const dirOf = () => path.join(tmp, `d${n++}`);
const hasCurl = spawnSync('/bin/sh', ['-c', 'command -v curl']).status === 0;

/** POSTs (or another method) to the shim's socket; resolves [status, body]. */
function request(sock: string, { method = 'POST', url = '/open', token = '', body = '' } = {}) {
  return new Promise<[number, string]>((resolve, reject) => {
    const req = http.request(
      { socketPath: sock, method, path: url, headers: { 'x-mopilot-token': token, 'content-type': 'application/x-www-form-urlencoded' } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve([res.statusCode!, text]));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

test('writeShim: an executable sh script and a sh/JavaScript polyglot next to it', () => {
  const dir = dirOf();
  const js = writeShim(dir);
  assert.equal(js, path.join(dir, SCRIPT_NAME));
  for (const f of [SCRIPT_NAME, SH_NAME]) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(dir, SH_NAME), 'utf8'), SH_SOURCE);
  assert.equal(fs.readFileSync(js, 'utf8'), JS_SOURCE);
  // written again over a file that lost its exec bit
  fs.chmodSync(js, 0o644);
  writeShim(dir);
  assert.equal(fs.statSync(js).mode & 0o777, 0o755);
  assert.ok(JS_SOURCE.startsWith('#!/bin/sh\n//bin/sh '), 'sh runs line 2; node reads a shebang and a comment');
});

test("pickChat: the running chat whose folder holds the command's folder (the deepest), else the only running one", () => {
  const running = [
    { chatId: 'a', cwd: '/p' },
    { chatId: 'b', cwd: '/p/web' },
    { chatId: 'c', cwd: null },
  ];
  assert.equal(pickChat(running, '/p/web/src'), 'b');
  assert.equal(pickChat(running, '/p/web'), 'b');
  assert.equal(pickChat(running, '/p/api'), 'a');
  assert.equal(pickChat(running, '/other'), null, 'several running, none there');
  assert.equal(
    pickChat(
      [
        { chatId: 'a', cwd: '/p' },
        { chatId: 'b', cwd: '/p' },
      ],
      '/p/x',
    ),
    null,
    'two chats in the same folder',
  );
  assert.equal(pickChat([{ chatId: 'a', cwd: '/p' }], '/other'), 'a');
  assert.equal(pickChat([{ chatId: 'a', cwd: '/p' }], null), 'a');
  assert.equal(pickChat([], '/p'), null);
  assert.equal(
    pickChat(
      [
        { chatId: 'a', cwd: '/p' },
        { chatId: 'b', cwd: '/q' },
      ],
      '',
    ),
    null,
  );
});

test("systemBrowserEnv: a sign-in leaves the shim for the user's own BROWSER, else the system opener", () => {
  const off = { MOPILOT_BROWSER_SOCK: null, MOPILOT_BROWSER_TOKEN: null, MOPILOT_BROWSER_FALLBACK: null };
  const shim = `/data/bin/${SCRIPT_NAME}`;
  assert.deepEqual(systemBrowserEnv({ BROWSER: shim, MOPILOT_BROWSER_SOCK: '/s', MOPILOT_BROWSER_FALLBACK: 'firefox' }), {
    BROWSER: 'firefox',
    ...off,
  });
  assert.deepEqual(systemBrowserEnv({ BROWSER: shim, MOPILOT_BROWSER_SOCK: '/s' }), { BROWSER: null, ...off }, 'the system opener');
  assert.deepEqual(systemBrowserEnv({ BROWSER: 'w3m' }), { BROWSER: 'w3m', ...off }, 'no shim: the BROWSER stays');
  assert.deepEqual(systemBrowserEnv(), { BROWSER: null, ...off });
});

test('BrowserShim on Windows: no shim, no env', async () => {
  const shim = new BrowserShim({ dir: dirOf(), open: async () => true, platform: 'win32' });
  assert.equal(shim.supported, false);
  assert.equal(await shim.listen(), null);
  assert.deepEqual(shim.env('c'), {});
  shim.close();
});

test("BrowserShim: env with the chat's own or the shared token, the user's BROWSER kept as the fallback; tokens route", async (t) => {
  let running: any = () => [{ chatId: 'run', cwd: '/proj' }];
  const shim = new BrowserShim({
    dir: dirOf(),
    open: async () => true,
    running: () => running(),
    tmpdir: () => tmp,
    fallback: () => 'firefox',
  });
  t.after(() => shim.close());
  assert.deepEqual(shim.env('c'), {}, 'nothing before it listens');
  const sock = await shim.listen();
  assert.equal(await shim.listen(), sock, 'once');
  assert.equal(fs.statSync(sock).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(sock)).mode & 0o777, 0o700);
  const shared = shim.env();
  assert.deepEqual(shared, {
    BROWSER: shim.script,
    MOPILOT_BROWSER_SOCK: sock,
    MOPILOT_BROWSER_TOKEN: shim.shared,
    MOPILOT_BROWSER_FALLBACK: 'firefox',
  });
  const own = shim.env('c', { BROWSER: 'w3m' });
  assert.notEqual(own.MOPILOT_BROWSER_TOKEN, shim.shared);
  assert.equal(shim.env('c').MOPILOT_BROWSER_TOKEN, own.MOPILOT_BROWSER_TOKEN, 'stable per chat');
  assert.equal(own.MOPILOT_BROWSER_FALLBACK, 'w3m');
  assert.equal(shim.env(null, { BROWSER: shim.script }).MOPILOT_BROWSER_FALLBACK, 'firefox', 'never itself');
  assert.equal(
    shim.env(null, { BROWSER: shim.script, MOPILOT_BROWSER_FALLBACK: 'lynx' }).MOPILOT_BROWSER_FALLBACK,
    'lynx',
    'an env that has the shim keeps its fallback',
  );
  assert.equal(await shim.route(own.MOPILOT_BROWSER_TOKEN, '/x'), 'c');
  assert.equal(await shim.route(shim.shared, '/proj/a'), 'run');
  assert.equal(await shim.route(shim.shared, ''), 'run');
  assert.equal(await shim.route('nope', '/proj'), null);
  assert.equal(await shim.route(undefined, '/proj'), null);
  assert.equal(await shim.route('', '/proj'), null);
  running = () => {
    throw new Error('gone');
  };
  assert.equal(await shim.route(shim.shared, '/proj'), null);
  running = () => null;
  assert.equal(await shim.route(shim.shared, '/proj'), null);
  shim.forget('c');
  shim.forget('never');
  assert.equal(await shim.route(own.MOPILOT_BROWSER_TOKEN, '/x'), null, "a forgotten chat's token stops working");
  const bare = new BrowserShim({ dir: dirOf(), open: async () => true, tmpdir: () => tmp });
  t.after(() => bare.close());
  await bare.listen();
  assert.equal('MOPILOT_BROWSER_FALLBACK' in bare.env(), false);
  assert.equal(await bare.route(bare.shared, '/x'), null, 'nothing running');
});

test("BrowserShim: the socket opens a chat's http(s) URL; anything else is refused so the script falls back", async (t) => {
  const opened: any[] = [];
  let result: any = true;
  const shim = new BrowserShim({
    dir: dirOf(),
    open: async (chatId: string, url: string) => {
      opened.push([chatId, url]);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  t.after(() => shim.close());
  const sock = await shim.listen();
  assert.ok(sock.startsWith(os.tmpdir()));
  const token = shim.tokenFor('c');
  assert.deepEqual(await request(sock, { token, body: form({ url: 'http://localhost:5173/', cwd: '/p' }) }), [200, 'opened']);
  assert.deepEqual(opened, [['c', 'http://localhost:5173/']]);
  result = false;
  assert.deepEqual(await request(sock, { token, body: form({ url: 'https://example.com/' }) }), [409, 'not opened']);
  result = new Error('no window');
  assert.deepEqual(await request(sock, { token, body: form({ url: 'https://example.com/' }) }), [409, 'not opened']);
  assert.deepEqual(await request(sock, { token, body: form({ url: 'file:///etc/passwd' }) }), [409, 'not a web page']);
  assert.deepEqual(await request(sock, { token, body: '' }), [409, 'not a web page']);
  assert.deepEqual(await request(sock, { token: 'wrong', body: form({ url: 'https://example.com/' }) }), [409, 'no chat']);
  assert.deepEqual(await request(sock, { method: 'GET', token }), [404, 'not found']);
  assert.deepEqual(await request(sock, { url: '/other', token }), [404, 'not found']);
  assert.deepEqual(await request(sock, { token, body: 'x'.repeat(20000) }).catch(() => [413, 'too large']), [413, 'too large']);
  assert.equal(opened.length, 3);
});

test('BrowserShim: closing drops a request still waiting (on a site card), so quitting never waits on it', async () => {
  const shim = new BrowserShim({ dir: dirOf(), open: () => new Promise(() => {}), tmpdir: () => tmp });
  const sock = await shim.listen();
  const pending = request(sock, { token: shim.tokenFor('c'), body: form({ url: 'https://example.com/' }) }).then(
    () => 'answered',
    (e) => e.code,
  );
  await new Promise((r) => setTimeout(r, 50));
  shim.close();
  assert.equal(await pending, 'ECONNRESET');
  assert.equal(fs.existsSync(sock), false);
});

test("BrowserShim: a socket folder that can't be made fails to listen; close without listening is fine", async () => {
  const shim = new BrowserShim({ dir: dirOf(), open: async () => true, tmpdir: () => path.join(tmp, 'missing', 'deeper') });
  await assert.rejects(shim.listen());
  shim.close();
  new BrowserShim({ dir: dirOf(), open: async () => true }).close();
});

test("the script end to end: sh and node post the URL to the chat; a refusal hands it to the user's BROWSER", {
  skip: !hasCurl && 'no curl',
}, async (t) => {
  const opened: any[] = [];
  let ok = true;
  const shim = new BrowserShim({
    dir: dirOf(),
    open: async (chatId: string, url: string) => (opened.push([chatId, url]), ok),
    tmpdir: () => tmp,
  });
  t.after(() => shim.close());
  await shim.listen();
  const marker = path.join(tmp, 'fallback.txt');
  const fallback = path.join(tmp, 'fallback.sh');
  fs.writeFileSync(fallback, `#!/bin/sh\necho "$@" >> ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, ...shim.env('c', { BROWSER: fallback }) };
  // async: the shim's server runs on this process's event loop
  const run = (cmd: string, args: string[], cwd = tmp) =>
    new Promise<number>((resolve) => spawn(cmd, args, { env, cwd, stdio: 'ignore' }).on('exit', (code) => resolve(code ?? -1)));
  assert.equal(await run('/bin/sh', [env.BROWSER, 'http://localhost:5173/?a=1&b=2']), 0);
  assert.equal(await run(env.BROWSER, ['http://localhost:5173/x']), 0, 'executed directly (gh, Python webbrowser)');
  // vite runs a .js BROWSER with node and passes its own command-line flags before the URL
  assert.equal(await run(process.execPath, [env.BROWSER, '--open', '--port', '5173', 'http://localhost:5173/y']), 0, 'run by node (vite)');
  assert.deepEqual(opened, [
    ['c', 'http://localhost:5173/?a=1&b=2'],
    ['c', 'http://localhost:5173/x'],
    ['c', 'http://localhost:5173/y'],
  ]);
  ok = false;
  assert.equal(await run('/bin/sh', [env.BROWSER, '--flag', 'https://example.com/']), 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'https://example.com/\n', 'only the URL goes to the fallback');
  assert.equal(await run('/bin/sh', [env.BROWSER]), 1, 'nothing to open');
  assert.equal(opened.length, 4);
});
