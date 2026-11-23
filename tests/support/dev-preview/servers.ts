// Dev-preview process readiness, logs, stopping and attachment cases.
import {
  test,
  assert,
  EventEmitter,
  path,
  DevPreviews,
  portOf,
  tmp,
  sleep,
  until,
  freePort,
  NODE,
  SERVE_PRINTED,
  SERVE_PORT,
} from './fixture.ts';
import { waitFor } from '../waitFor.ts';

export function registerServers() {
  test('start: a server that prints its URL is ready once the port answers; its output is kept', async (t) => {
    const ready: any[] = [];
    const p = new DevPreviews({ pollMs: 20, env: () => ({ PATH: process.env.PATH }), onReady: (s: any) => ready.push(s.id) });
    t.after(() => p.stopAll());
    const s = p.start('c', { run: [NODE, '-e', SERVE_PRINTED], display: 'node serve', cwd: tmp });
    assert.match(s.id, /^srv_[0-9a-f]{6}$/);
    assert.equal(s.status, 'starting');
    assert.equal(await p.waitReady(s, { timeoutMs: 5000 }), 'ready');
    assert.equal(s.status, 'ready');
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(s.port, portOf(s.url));
    assert.deepEqual(ready, [s.id]);
    assert.equal(await p.waitReady(s), 'ready', 'already ready');
    const lines = p.logs(s, { lines: 500 }).map((l: any) => `${l.stream}:${l.text}`);
    assert.equal(lines[0], `system:$ node serve  (in ${tmp})`);
    assert.ok(lines.includes(`stdout:  Local: ${s.url}`), lines.join('\n'));
    assert.ok(lines.includes(`system:Ready at ${s.url}`));
    // stderr is its own pipe: under load its line can arrive after the server is ready
    await waitFor(() => p.logs(s, { level: 'error' }).length, 'the stderr log line');
    assert.deepEqual(
      p.logs(s, { level: 'error' }).map((l: any) => l.text),
      ['warn: something failed'],
    );
    assert.deepEqual(p.logs(s, { search: 'LOCAL' }).length, 1);
    assert.deepEqual(p.list('c'), [s]);
    assert.deepEqual(p.list('other'), []);
    assert.equal(p.get('c', s.id), s);
    assert.throws(() => p.get('other', s.id), { code: 'bad_args' });
    assert.throws(() => p.get('c', 'srv_nope'), { code: 'bad_args' });
    assert.equal(p.find('c', { command: 'node serve', cwd: tmp }), s);
    assert.equal(p.find('c', { command: 'node serve', cwd: '/elsewhere' }), null);
    assert.equal(p.find('c', { url: s.url }), s);
    // stop: the group goes; the server is forgotten and stays 'stopped'
    const pid = s.pid;
    assert.equal(p.stop('c', s.id), s);
    assert.equal(s.status, 'stopped');
    assert.equal(p.list('c').length, 0);
    await until(() => s.exited);
    assert.equal(s.status, 'stopped');
    assert.throws(() => process.kill(pid, 0));
  });

  test('start: a configured port goes to the server as PORT with the chat env; a configured URL is kept', async (t) => {
    const port = await freePort();
    const p = new DevPreviews({ pollMs: 20, chatEnv: (chatId: string) => ({ MOPILOT_X: `chat ${chatId}` }) });
    t.after(() => p.stopAll());
    const s = p.start('c', { name: 'web', run: [NODE, '-e', SERVE_PORT], display: 'node web', cwd: tmp, port, env: { EXTRA: '1' } });
    assert.equal(await p.waitReady(s, { timeoutMs: 5000 }), 'ready');
    assert.equal(s.url, `http://localhost:${port}/`);
    await until(() => p.logs(s).some((l: any) => l.text === 'up chat c'));
    assert.equal(p.find('c', { name: 'web' }), s);
    // a URL alone gives the port; [::1] is probed on ::1
    const probes: any[] = [];
    const q = new DevPreviews({ pollMs: 5, probe: async (pt: number, host: string) => (probes.push([pt, host]), true) });
    t.after(() => q.stopAll());
    const u = q.start('c', { run: [NODE, '-e', 'setInterval(() => {}, 1000)'], display: 'idle', cwd: tmp, url: 'http://[::1]:4321/x' });
    assert.equal(await q.waitReady(u, { timeoutMs: 2000 }), 'ready');
    assert.deepEqual(probes, [[4321, '::1']]);
    assert.equal(u.url, 'http://[::1]:4321/x');
  });

  test('start: exits are reported (failed or exited) with their code or signal; onExit and onReady may throw', async (t) => {
    const exits: any[] = [];
    const p = new DevPreviews({
      pollMs: 10,
      onExit: (s: any) => {
        exits.push(s.status);
        throw new Error('listener');
      },
      onReady: () => {
        throw new Error('listener');
      },
    });
    t.after(() => p.stopAll());
    const bad = p.start('c', { run: [NODE, '-e', 'console.error("Error: boom"); process.exit(3)'], display: 'bad', cwd: tmp });
    assert.equal(await p.waitReady(bad, { timeoutMs: 5000 }), 'exited');
    assert.deepEqual([bad.status, bad.exitCode, bad.live], ['failed', 3, false]);
    assert.equal(await p.waitReady(bad), 'exited', 'already gone');
    assert.equal(p.logs(bad).at(-1).text, 'Exited with code 3.');
    const ok = p.start('c', { run: [NODE, '-e', ''], display: 'ok', cwd: tmp });
    await until(() => ok.exited);
    assert.equal(ok.status, 'exited');
    const missing = p.start('c', { run: [path.join(tmp, 'no-such-binary')], display: 'missing', cwd: tmp });
    await until(() => missing.exited);
    assert.equal(missing.status, 'failed');
    assert.match(
      p
        .logs(missing)
        .map((l: any) => l.text)
        .join('\n'),
      /Couldn't run missing: .*ENOENT[\s\S]*Exited\.$/,
    );
    const killed = p.start('c', { run: [NODE, '-e', 'process.kill(process.pid, "SIGTERM")'], display: 'killed', cwd: tmp });
    await until(() => killed.exited);
    assert.deepEqual([killed.status, killed.signal, p.logs(killed).at(-1).text], ['failed', 'SIGTERM', 'Exited (SIGTERM).']);
    assert.deepEqual(exits, ['failed', 'exited', 'failed', 'failed']);
    // ready, then quit: 'exited'. The server quits once the readiness probe has connected and hung up, not on a timer
    // that a loaded machine can let fire before the first probe (docs/bug-prevention/load-dependent-tests.md).
    const port = await freePort();
    const brief = p.start('c', {
      run: [
        NODE,
        '-e',
        `require('net').createServer((c) => c.resume().on('error', () => {}).on('close', () => process.exit(1))).listen(${port})`,
      ],
      display: 'brief',
      cwd: tmp,
      port,
    });
    assert.equal(await p.waitReady(brief, { timeoutMs: 5000 }), 'ready');
    await until(() => brief.exited);
    assert.equal(brief.status, 'exited');
  });

  test('stop: a server that ignores SIGTERM gets SIGKILL; a group already gone falls back to the process', async (t) => {
    const p = new DevPreviews({ pollMs: 1000, killMs: 50 });
    t.after(() => p.stopAll());
    const stubborn = p.start('c', {
      run: [NODE, '-e', 'process.on("SIGTERM", () => {}); console.log("x"); setInterval(() => {}, 1000)'],
      display: 'stubborn',
      cwd: tmp,
    });
    await until(() => p.logs(stubborn).some((l: any) => l.text === 'x'));
    p.stop('c', stubborn.id);
    await until(() => stubborn.exited);
    assert.equal(stubborn.signal, 'SIGKILL');
    // fake processes: the group kill fails, then the process kill (and its failure) is tried
    const procs: any[] = [];
    const fake = new DevPreviews({
      killMs: 5,
      spawn: () => {
        const proc: any = Object.assign(new EventEmitter(), {
          pid: 2 ** 22 + 12345,
          kills: [] as string[],
          kill(sig: string) {
            proc.kills.push(sig);
            if (procs.length > 1) throw new Error('gone');
          },
        });
        procs.push(proc);
        return proc;
      },
    });
    const a = fake.start('c', { run: ['x'], display: 'x', cwd: tmp });
    fake.stop('c', a.id);
    await sleep(20);
    assert.deepEqual(procs[0].kills, ['SIGTERM', 'SIGKILL']);
    const b = fake.start('c', { run: ['x'], display: 'x', cwd: tmp });
    assert.doesNotThrow(() => fake.stop('c', b.id));
    procs[1].emit('exit', null, 'SIGTERM');
    await sleep(20);
    assert.deepEqual(procs[1].kills, ['SIGTERM'], 'gone before the SIGKILL');
    assert.equal(b.status, 'stopped');
  });

  test('killNow (the process exits): servers still running and stopped ones not gone yet are killed at once', async (t) => {
    const p = new DevPreviews({ pollMs: 1000, killMs: 60_000 });
    t.after(() => p.stopAll());
    const STUBBORN = 'process.on("SIGTERM", () => {}); console.log("x"); setInterval(() => {}, 1000)';
    const stopped = p.start('c', { run: [NODE, '-e', STUBBORN], display: 'stopped', cwd: tmp });
    const running = p.start('c', { run: [NODE, '-e', STUBBORN], display: 'running', cwd: tmp });
    const done = p.start('c', { run: [NODE, '-e', ''], display: 'done', cwd: tmp });
    const attached = p.attach('c', 'http://localhost:1/');
    await until(() => done.exited && [stopped, running].every((s) => p.logs(s).some((l: any) => l.text === 'x')));
    p.stop('c', stopped.id);
    await sleep(100);
    assert.equal(stopped.exited, false, 'it ignores SIGTERM, and SIGKILL is a minute away');
    assert.ok(p.dying.has(stopped));
    p.killNow();
    await until(() => stopped.exited && running.exited);
    assert.deepEqual([stopped.signal, running.signal], ['SIGKILL', 'SIGKILL']);
    assert.equal(p.dying.size, 0);
    assert.equal(attached.live, true, 'nothing to kill for a server MoPilot did not start');
  });

  test('stop on Windows: the core ends the tree, else the process alone (one already gone is fine); no detached group', async (t) => {
    const spawned: any[] = [];
    const p = new DevPreviews({
      platform: 'win32',
      spawn: (file: string, args: string[], opts: any) => {
        spawned.push([file, args, opts.detached ?? null]);
        return Object.assign(new EventEmitter(), { pid: 77 });
      },
    });
    const kills: number[] = [];
    const gone = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    t.mock.method(process, 'kill', (pid: number) => {
      kills.push(pid);
      throw gone;
    });
    const s = p.start('c', { run: ['cmd.exe', '/c', 'x'], display: 'x', cwd: tmp });
    p.stop('c', s.id);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(spawned, [['cmd.exe', ['/c', 'x'], false]], 'nothing is started to stop it');
    assert.deepEqual(kills, [77]);
  });

  test('start on Windows: a configuration names npm or a path without .cmd, and the shim runs (spawn finds neither)', () => {
    const spawned: any[] = [];
    const files = new Set([
      'C:\\node\\npm.cmd',
      'C:\\node\\node.exe',
      'C:\\node\\node_modules\\npm\\bin\\npm-cli.js',
      'C:\\proj\\node_modules\\.bin\\vite.cmd',
    ]);
    const p = new DevPreviews({
      platform: 'win32',
      env: () => ({ Path: 'C:\\node', ComSpec: 'C:\\Windows\\cmd.exe' }),
      io: {
        exists: (f: string) => files.has(f),
        readFile: (f: string) => (f === 'C:\\node\\npm.cmd' ? '"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*' : null),
      },
      spawn: (file: string, args: string[], opts: any) => {
        spawned.push([file, args, opts.windowsVerbatimArguments ?? null]);
        return Object.assign(new EventEmitter(), { pid: 5 });
      },
    });
    // npm's shim runs its script with node from PATH
    p.start('c', { run: ['npm', 'run', 'dev'], display: 'npm run dev', cwd: 'C:\\proj' });
    // a shim that can't be read runs through cmd.exe, its arguments escaped
    p.start('c', { run: ['./node_modules/.bin/vite', '--port', '5173'], display: 'vite', cwd: 'C:\\proj' });
    // what isn't found is spawned as named (and fails there with ENOENT)
    p.start('c', { run: ['missing', 'a'], display: 'missing', cwd: 'C:\\proj' });
    assert.deepEqual(spawned, [
      ['C:\\node\\node.exe', ['C:\\node\\node_modules\\npm\\bin\\npm-cli.js', 'run', 'dev'], null],
      ['C:\\Windows\\cmd.exe', ['/d', '/s', '/c', '"C:\\proj\\node_modules\\.bin\\vite.cmd ^"--port^" ^"5173^""'], true],
      ['missing', ['a'], null],
    ]);
    p.stopAll();
  });

  test('start: a spawn that throws fails cleanly; a chat runs at most maxPerChat servers', () => {
    const p = new DevPreviews({
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    assert.throws(() => p.start('c', { run: ['x'], display: 'x', cwd: tmp }), { code: 'failed', message: "Couldn't start x: EACCES" });
    assert.equal(p.list('c').length, 0);
    const q = new DevPreviews({ maxPerChat: 1, spawn: () => Object.assign(new EventEmitter(), {}) });
    const s = q.start('c', { run: ['x'], display: 'x', cwd: tmp });
    assert.equal(s.pid, null, 'a process without a pid');
    assert.throws(() => q.start('c', { run: ['x'], display: 'x', cwd: tmp }), { code: 'limit' });
    assert.doesNotThrow(() => q.start('d', { run: ['x'], display: 'x', cwd: tmp }), 'another chat');
    q.stopAll();
    assert.equal(q.servers.size, 0);
  });

  test('logs: long lines are cut, blank ones skipped, at most maxLines kept; lines are bounded 1..500', () => {
    let proc: any;
    const p = new DevPreviews({
      maxLines: 5,
      spawn: () => (proc = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() })),
    });
    const s = p.start('c', { run: ['x'], display: 'x', cwd: tmp, port: 1 });
    proc.stdout.emit('data', Buffer.from(`${'y'.repeat(2100)}\n\n  \r\nb`));
    // the cut says how much it left out (shared/clippedText.mjs)
    assert.equal(s.lines[1].text, `${'y'.repeat(1999)}… [+101 chars]`);
    for (let i = 0; i < 10; i++) proc.stderr.emit('data', `line ${i}`);
    assert.equal(s.lines.length, 5);
    assert.equal(s.lines[4].text, 'line 9');
    assert.equal(s.url, null, 'a configured port is not replaced by a printed URL');
    assert.equal(p.logs(s, { lines: 0 }).length, 5, '0 reads as the default');
    assert.equal(p.logs(s, { lines: 2 }).length, 2);
    assert.equal(p.logs(s, { lines: 0.2 }).length, 5);
    assert.equal(p.logs(s).length, 5);
    p.stopAll();
  });

  test('waitReady: a timeout, an abort before or while waiting; a server stopped during a probe stays stopped', async () => {
    let release: any;
    const p = new DevPreviews({
      pollMs: 1,
      probe: () => new Promise((r) => (release = r)),
      spawn: () => Object.assign(new EventEmitter(), { pid: 2 ** 22 + 999, kill() {} }),
    });
    const s = p.start('c', { run: ['x'], display: 'x', cwd: tmp, port: 9 });
    assert.equal(await p.waitReady(s, { timeoutMs: 5 }), 'timeout');
    const ac = new AbortController();
    ac.abort();
    assert.equal(await p.waitReady(s, { signal: ac.signal }), 'aborted');
    const ac2 = new AbortController();
    const w = p.waitReady(s, { signal: ac2.signal });
    ac2.abort();
    assert.equal(await w, 'aborted');
    assert.equal(s.waiters.size, 0);
    await until(() => release);
    p.stop('c', s.id);
    release(true);
    await sleep(5);
    assert.equal(s.status, 'stopped', 'a late answer does not make it ready');
    // a probe that says no while the server stops: polling ends
    let calls = 0;
    const q = new DevPreviews({
      pollMs: 1,
      probe: async () => {
        calls++;
        q.stopAll();
        return false;
      },
      spawn: () => Object.assign(new EventEmitter(), { pid: 2 ** 22 + 998, kill() {} }),
    });
    q.start('c', { run: ['x'], display: 'x', cwd: tmp, port: 9 });
    await sleep(20);
    assert.equal(calls, 1);
    // no port and no URL yet: nothing to probe
    let probed = 0;
    const r = new DevPreviews({
      pollMs: 1,
      probe: async () => (probed++, true),
      spawn: () => Object.assign(new EventEmitter(), { pid: 2 ** 22 + 997, kill() {} }),
    });
    const quiet = r.start('c', { run: ['x'], display: 'x', cwd: tmp });
    await sleep(10);
    assert.equal(probed, 0);
    assert.equal(quiet.status, 'starting');
    r.stopAll();
  });

  test('attach: a server MoPilot did not start is polled and only forgotten on stop', async () => {
    const p = new DevPreviews({ pollMs: 1, probe: async () => true });
    const s = p.attach('c', 'http://localhost:3000/');
    assert.equal(await p.waitReady(s, { timeoutMs: 1000 }), 'ready');
    assert.equal(s.proc, null);
    assert.match(p.logs(s)[0].text, /^Attached to http:\/\/localhost:3000\//);
    p.stop('c', s.id);
    assert.equal(s.status, 'stopped');
    const pending = p.attach('c', 'http://localhost:3001/');
    const w = p.waitReady(pending, { timeoutMs: 1000 });
    p.stopChat('c');
    assert.equal(await w, 'exited');
    assert.equal(p.list('c').length, 0);
  });
}
