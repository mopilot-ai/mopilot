// The fake `ssh` Host follows the real Host's handshake rule (host/src/protocol.mjs): a versioned request (host.*, chat.*, browser.*, desktop.*) is refused as hello_required, with the real sentence, until host.hello came first on that connection; the line protocol (git.status, fs.*) and the pairing proof need none (#5050).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitFor } from './support/waitFor.ts';
import { connectSocket } from './support/connectSocket.ts';
import { requireFeatures } from '../shared/host/schema.mjs';
import { GIT_HOST, GIT_LOGIN, GIT_SIGNIN_FEATURE } from '../shared/host/gitLogin.mjs';

test('the fake ssh Host refuses a request that came before hello, as the real Host does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-hello-'));
  const local = path.join(dir, 'app');
  const log = path.join(dir, 'log');
  const signedIn = path.join(dir, 'signed-in');
  const child = spawn(process.execPath, ['tests/e2e/fixtures/fake-ssh/ssh', '-L', `${local}:remote`, '--', 'box'], {
    env: {
      ...process.env,
      FAKE_HOST_WIRE_SOCK: undefined,
      FAKE_HOST_CHATS_SOCK: undefined,
      FAKE_HOST_ROOT: dir,
      FAKE_HOST_LOG: log,
      FAKE_HOST_LOGIN_CODE: 'ABCD-1234',
      FAKE_HOST_LOGIN_FAIL: undefined,
      FAKE_HOST_GIT_SIGNIN: 'no',
      FAKE_HOST_GIT_LOGIN_DONE: signedIn,
    },
    stdio: 'ignore',
  });
  let app: net.Socket | undefined;
  t.after(async () => {
    app?.destroy();
    child.kill();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'SSH child exit');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  app = await connectSocket(local, 'the forwarded socket accepting connections');
  const sock = app as net.Socket;
  sock.setEncoding('utf8');
  let buffer = '';
  sock.on('data', (chunk) => (buffer += chunk));
  const ask = async (id: string, method: string, params: object = {}) => {
    sock.write(`${JSON.stringify({ id, method, params })}\n`);
    await waitFor(() => buffer.split('\n').some((l) => l && JSON.parse(l).id === id), `the answer to ${method}`);
    return JSON.parse(buffer.split('\n').find((l) => l && JSON.parse(l).id === id) as string);
  };
  const write = { path: dir, message: 'm', files: null };
  const early = await ask('1', 'host.gitCommit', write);
  assert.equal(early.code, 'hello_required');
  assert.match(early.error, /^Say hello first: the host and the app have not agreed on a version yet\.$/);
  assert.equal((await ask('2', 'chat.send', {})).code, 'hello_required');
  // the line protocol and the pairing proof are served before any hello
  assert.equal((await ask('3', 'git.status', { path: dir })).result.isRepo, false);
  assert.equal((await ask('4', 'host.challenge')).result.nonce, 'fake-nonce');
  const hello = (await ask('5', 'host.hello', {})).result;
  assert.equal(hello.features.includes('gitWrite'), true);
  assert.ok(hello.features.includes(GIT_SIGNIN_FEATURE), 'the app must negotiate Git sign-in before reaching the fixture login');
  const login = { harness: GIT_LOGIN };
  for (const method of ['host.login', 'host.loginStatus', 'host.loginCancel'])
    assert.doesNotThrow(() => requireFeatures(method, hello, login));
  assert.equal((await ask('login', 'host.login', login)).result.state, 'waiting');
  assert.deepEqual((await ask('waiting', 'host.loginStatus', login)).result.codes, ['ABCD-1234']);
  assert.deepEqual((await ask('before', 'host.status', { signIn: [GIT_HOST] })).result.gitSignIn, { [GIT_HOST]: 'no' });
  fs.writeFileSync(signedIn, 'yes');
  assert.equal((await ask('done', 'host.loginStatus', login)).result.state, 'done');
  assert.deepEqual((await ask('after', 'host.status', { signIn: [GIT_HOST] })).result.gitSignIn, { [GIT_HOST]: 'yes' });
  assert.equal((await ask('cancel', 'host.loginCancel', login)).result.cancelled, true);
  assert.equal((await ask('6', 'host.gitCommit', write)).result.ok, true);
  assert.match(fs.readFileSync(log, 'utf8'), /"method":"refused","params":\{"method":"host.gitCommit","code":"hello_required"\}/);
  // another connection has not said hello: the rule is per connection
  const other = net.connect(local);
  t.after(() => other.destroy());
  await once(other, 'connect');
  other.write(`${JSON.stringify({ id: '7', method: 'host.gitDiscard', params: { path: dir, file: null } })}\n`);
  const [reply] = await once(other, 'data');
  assert.equal(JSON.parse(reply.toString()).code, 'hello_required');
});
