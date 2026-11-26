// Tests the signed installer boundary's one-shot protocol and legacy fallback.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const { macInstaller, prepare } = createRequire(import.meta.url)('../electron/updates/macInstaller.cjs');
const helper = '/Applications/MoPilot.app/Contents/Helpers/update-install';

function processFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345 as number | undefined,
    exitCode: null as number | null,
    unref: mock.fn(),
    kill: mock.fn(),
  });
  const send: string[] = [];
  child.stdin.on('data', (buffer: Buffer) => send.push(buffer.toString()));
  const launch = mock.fn((..._args: unknown[]) => child);
  const controller = new AbortController();
  const lost = mock.fn();
  const kill = mock.fn();
  return {
    child,
    send,
    launch,
    controller,
    lost,
    kill,
    prepare: () => prepare(helper, '/zip', '2.0.0', controller.signal, lost, { launch, kill }),
  };
}

test('only a canonical replaceable macOS app with an executable helper uses staged installation', () => {
  const getPath = () => '/Applications/MoPilot.app/Contents/MacOS/MoPilot';
  const disk = { realpathSync: (p: string) => p, accessSync: mock.fn(), constants: { W_OK: 2, X_OK: 1 } };
  assert.equal(macInstaller({ getPath }, { platform: 'linux', disk }), null);
  assert.equal(macInstaller({ getPath: () => null }, { platform: 'darwin', disk }), null);
  assert.equal(macInstaller({ getPath: () => 'relative.app' }, { platform: 'darwin', disk }), null);
  assert.equal(macInstaller({ getPath: () => `/Volumes${getPath()}` }, { platform: 'darwin', disk }), null);
  assert.equal(macInstaller({ getPath: () => getPath().replace('.app', '') }, { platform: 'darwin', disk }), null);
  assert.equal(macInstaller({ getPath }, { platform: 'darwin', disk: { ...disk, realpathSync: () => '/elsewhere' } }), null);
  disk.accessSync.mock.mockImplementationOnce(() => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  });
  assert.equal(macInstaller({ getPath }, { platform: 'darwin', disk }), null);
  const installer = macInstaller({ getPath }, { platform: 'darwin', disk });
  assert.throws(() => installer.prepare('/zip', '2.0.0', AbortSignal.abort(new Error('retired')), () => {}), /retired/);
  assert.deepEqual(
    disk.accessSync.mock.calls.slice(1).map((call) => call.arguments),
    [
      ['/Applications', 2],
      [helper, 1],
    ],
  );
});

for (const restart of [true, false]) {
  test(`a prepared helper receives one ${restart ? 'restart' : 'quit'} command after ownership transfers`, async () => {
    const p = processFixture();
    const pending = p.prepare();
    p.child.stdout.write('re');
    p.child.stdout.write('ady\n');
    const stage = await pending;
    assert.deepEqual(p.launch.mock.calls[0].arguments, [helper, ['/zip', '2.0.0'], { stdio: ['pipe', 'pipe', 'pipe'], detached: true }]);
    assert.equal(stage.ready(), true);
    const handoff = stage.commit(restart);
    let accepted = false;
    void handoff.then(() => {
      accepted = true;
    });
    await Promise.resolve();
    assert.equal(accepted, false, 'writing the pipe does not prove the helper read the command');
    p.child.stdout.write('accept');
    p.child.stdout.write('ed\n');
    await handoff;
    stage.cancel();
    p.child.stdout.write('ignored');
    p.child.emit('close', 0);
    assert.equal(p.lost.mock.callCount(), 0);
    assert.equal(p.child.unref.mock.callCount(), 1);
    assert.deepEqual(p.send, [restart ? 'restart\n' : 'quit\n']);
    await assert.rejects(stage.commit(restart), /no longer available/);
  });
}

for (const failure of ['abort', 'invalid', 'timeout', 'exit', 'spawn', 'pipe'] as const) {
  test(`${failure} while preparing never sends an activation command`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = processFixture();
    const signal = p.controller.signal;
    const pending = prepare(helper, '/zip', '2.0.0', signal, p.lost, { launch: p.launch, kill: p.kill, timeout: 10 });
    if (failure === 'abort') p.controller.abort(new Error('channel switched'));
    if (failure === 'invalid') p.child.stdout.write('unrecognized\n');
    if (failure === 'timeout') t.mock.timers.tick(10);
    if (failure === 'spawn') p.child.emit('error', new Error('could not launch'));
    if (failure === 'pipe') p.child.stdin.emit('error', new Error('pipe stopped'));
    if (failure === 'exit') {
      p.child.stderr.write('verification error');
      p.child.emit('close', 1);
    } else if (failure !== 'spawn') {
      let rejected = false;
      void pending.catch(() => {
        rejected = true;
      });
      await Promise.resolve();
      assert.equal(rejected, false, 'the obsolete helper still owns the download');
      p.child.emit('close', 0);
    }
    await assert.rejects(pending, /channel switched|invalid result|timed out|stopped|could not launch/);
    assert.deepEqual(p.send, []);
    p.child.stdout.write('ready\n');
    p.child.emit('close', 1);
    assert.equal(p.lost.mock.callCount(), 0);
  });
}

test('a helper dying after preparation retires precisely that stage, and EOF cancels a stage', async () => {
  for (const retire of ['closed', 'cancelled'] as const) {
    const p = processFixture();
    const pending = p.prepare();
    p.child.stdout.write('ready\n');
    const stage = await pending;
    if (retire === 'cancelled') stage.cancel();
    p.child.emit('close', 0);
    assert.equal(stage.ready(), false);
    assert.deepEqual(p.send, []);
    assert.equal(p.lost.mock.callCount(), retire === 'closed' ? 1 : 0);
    if (retire === 'closed') assert.equal(p.lost.mock.calls[0].arguments[0], stage);
  }
});

test('a cancelled worker that does not close is stopped before the ZIP can be reused', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const p = processFixture();
  const pending = prepare(helper, '/zip', '2.0.0', p.controller.signal, p.lost, { launch: p.launch, kill: p.kill, grace: 3 });
  p.controller.abort(new Error('channel changed'));
  t.mock.timers.tick(3);
  assert.deepEqual(p.kill.mock.calls[0].arguments, [-p.child.pid!, 'SIGKILL']);
  p.child.emit('close', 1);
  await assert.rejects(pending, /channel changed/);
});

test('escalating cancellation closes the pipes of a stalled extractor', {
  skip: process.platform === 'win32',
  timeout: 5000,
}, async (t) => {
  const controller = new AbortController();
  let running: ReturnType<typeof spawn> | undefined;
  const launch = (_file: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
    running = spawn(
      process.execPath,
      [
        '-e',
        `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'inherit' });
      process.stderr.write('extracting');
      setTimeout(() => {}, 10000);
    `,
      ],
      options,
    );
    return running;
  };
  const pending = prepare(helper, '/zip', '2.0.0', controller.signal, () => {}, { launch, grace: 20 });
  const child = running!;
  t.after(() => {
    if (child.pid && child.signalCode === null && child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
  });
  await once(child.stderr!, 'data');
  controller.abort(new Error('channel changed'));
  await assert.rejects(pending, /channel changed/);
  assert.equal(child.signalCode, 'SIGKILL');
});

for (const pid of [undefined, 12345]) {
  test(`retiring an installer is safe when its group has gone away (${pid})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = processFixture();
    p.child.pid = pid;
    p.kill.mock.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    });
    const pending = prepare(helper, '/zip', '2.0.0', p.controller.signal, p.lost, { launch: p.launch, kill: p.kill, grace: 3 });
    p.controller.abort(new Error('cancelled'));
    t.mock.timers.tick(3);
    p.child.emit('close', 1);
    await assert.rejects(pending, /cancelled/);
    assert.equal(p.kill.mock.callCount(), pid ? 1 : 0);
  });
}

for (const failure of ['close', 'timeout', 'invalid', 'child-error', 'pipe-error'] as const) {
  test(`a helper must acknowledge the restart even after the pipe write succeeds (${failure})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const p = processFixture();
    const pending = prepare(helper, '/zip', '2.0.0', p.controller.signal, p.lost, { launch: p.launch, kill: p.kill, grace: 3 });
    p.child.stdout.write('ready\n');
    const handoff = (await pending).commit(true);
    if (failure === 'close') p.child.emit('close', 1);
    if (failure === 'timeout') t.mock.timers.tick(3);
    if (failure === 'invalid') p.child.stdout.write('wrong\n');
    if (failure === 'child-error') p.child.emit('error', new Error('helper stopped'));
    if (failure === 'pipe-error') p.child.stdin.emit('error', new Error('pipe stopped'));
    await assert.rejects(handoff, /stopped|did not acknowledge|invalid result/);
    assert.deepEqual(
      p.child.kill.mock.calls.map((call) => call.arguments),
      failure === 'close' ? [] : [['SIGKILL']],
    );
    assert.equal(p.kill.mock.callCount(), 0);
    assert.equal(p.child.unref.mock.callCount(), 0);
  });
}

test('a broken pipe reports activation failure to the quitting app', async () => {
  const p = processFixture();
  const pending = p.prepare();
  p.child.stdout.write('ready\n');
  const stage = await pending;
  mock.method(p.child.stdin, 'write', (_message: string, callback: (error: Error) => void) => {
    callback(new Error('installer disconnected'));
    return false;
  });
  await assert.rejects(stage.commit(true), /installer disconnected/);
});

test('a late write error cannot revoke an acknowledgement already received from the helper', async () => {
  const p = processFixture();
  const pending = p.prepare();
  p.child.stdout.write('ready\n');
  const stage = await pending;
  mock.method(p.child.stdin, 'write', (_message: string, callback: (error: Error) => void) => {
    p.child.stdout.write('accepted\n');
    callback(new Error('pipe already closed'));
    return false;
  });
  await stage.commit(true);
  assert.equal(p.child.kill.mock.callCount(), 0);
  assert.equal(p.kill.mock.callCount(), 0);
  assert.equal(p.child.unref.mock.callCount(), 1);
});
