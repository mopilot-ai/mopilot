// The Host's acceptance run (scripts/host-accept.mjs): its report, the channel to a machine, the line client, the step runner, and every step against a stand-in machine that answers as a Host on a Mac does. The run on a real machine is what the release cites; this keeps the script itself honest (W: a failing step, A: timing and skips, B: bad arguments, I: the stand-in's Host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannel, sshLauncher, vmLauncher } from '../scripts/host-accept/channel.mjs';
import { NOT_VERIFIED, exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { STEPS, until } from '../scripts/host-accept/steps.mjs';
import { lineClient } from '../scripts/host-accept/wire.mjs';
import { channelFor, main, parseArgs, realDeps, runSteps } from '../scripts/host-accept.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-test-')));

test('B: the report is a table with timings, never shows a pipe or a line break in a cell, and lists what the run cannot show', () => {
  const rows = [
    { id: 'A1', title: 'One', status: 'PASS' as const, ms: 1500, detail: 'ok' },
    { id: 'A2', title: 'Two | pipes', status: 'FAIL' as const, ms: 250, detail: 'line one\nline | two' },
    { id: 'A3', title: 'Three', status: 'SKIP' as const, ms: 0, detail: 'x'.repeat(400) },
  ];
  const text = formatReport({ target: 'mopilot-work', rows, at: '2026-10-29T00:00:00Z' });
  assert.match(text, /### Host acceptance run on mopilot-work \(2026-10-29T00:00:00Z\)/);
  assert.match(text, /\| A1 One \| PASS \| 1\.5 s \| ok \|/);
  assert.match(text, /\| A2 Two \/ pipes \| FAIL \| 0\.3 s \| line one line \/ two \|/);
  assert.match(text, /\*\*1\/3 passed\*\* in 1\.8 s\./);
  assert.ok(text.split('\n').find((l) => l.startsWith('| A3'))!.length < 400);
  for (const n of NOT_VERIFIED) assert.ok(text.includes(`- ${n}`));
  assert.ok(formatReport({ target: 't', rows: [] }).includes('0/0 passed'), 'the default clock and list work');
  assert.match(
    formatReport({ target: 'box', rows: [], platform: 'Linux aarch64\n', at: 'now' }),
    /run on box \(Linux aarch64\) \(now\)/,
    'a table says which OS it is evidence for',
  );
  assert.equal(exitCode(rows), 1);
  assert.equal(exitCode(rows.slice(0, 1)), 0);
});

test('B: a Tart VM is reached through vm-exec.sh, with --stdin only when bytes go in; any other machine over ssh', () => {
  assert.deepEqual(vmLauncher('mopilot-work', '/r/vm-exec.sh')('echo hi', false), {
    bin: '/r/vm-exec.sh',
    args: ['--vm', 'mopilot-work', 'sh', '-c', 'export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; echo hi'],
  });
  assert.deepEqual(vmLauncher('mopilot-work', '/r/vm-exec.sh')('cat', true).args.slice(0, 4), ['--vm', 'mopilot-work', '--stdin', 'sh']);
  assert.deepEqual(sshLauncher('me@box', ['-p', '2222'])('uname'), {
    bin: 'ssh',
    args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', '2222', '--', 'me@box', 'uname'],
  });
  assert.deepEqual(sshLauncher('me@box')('uname').args.slice(-3), ['--', 'me@box', 'uname']);
});

/** A spawn stand-in: the child it returns runs `script` against the bytes written to it. */
function fakeSpawn(script: (child: any, input: string) => void) {
  const calls: { bin: string; args: string[]; stdio: unknown }[] = [];
  const children: any[] = [];
  const spawnFn = ((bin: string, args: string[], o: any) => {
    calls.push({ bin, args, stdio: o.stdio });
    const child: any = new EventEmitter();
    children.push(child);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let input = '';
    child.stdin = Object.assign(new EventEmitter(), {
      end: (d?: Buffer) => (d && (input += d), setImmediate(() => script(child, input))),
      write: (d: string) => ((input += d), true),
    });
    child.kill = (sig: string) => child.emit('killed', sig);
    return child;
  }) as any;
  return { spawnFn, calls, children };
}

test('A: a command’s result keeps its output and code; a failure to start, a timeout and a signal are results too', async () => {
  const ok = fakeSpawn((c, input) => {
    c.stdout.emit('data', Buffer.from(`out:${input}`));
    c.stderr.emit('data', Buffer.from('warn'));
    c.emit('close', 3);
  });
  const ch = createChannel({ launcher: vmLauncher('mopilot-x', '/v'), spawnFn: ok.spawnFn });
  assert.deepEqual(await ch.run('cat', Buffer.from('bytes')), { code: 3, stdout: 'out:bytes', stderr: 'warn' });
  assert.deepEqual(ok.calls[0].stdio, ['pipe', 'pipe', 'pipe']);
  await ch.run('true');
  assert.deepEqual(ok.calls[1].stdio, ['ignore', 'pipe', 'pipe']);
  const broke = fakeSpawn((c) => c.emit('error', new Error('no ssh')));
  assert.deepEqual(await createChannel({ launcher: sshLauncher('x'), spawnFn: broke.spawnFn }).run('a'), {
    code: -1,
    stdout: '',
    stderr: 'no ssh',
  });
  const signalled = fakeSpawn((c) => c.emit('close', null));
  assert.equal((await createChannel({ launcher: sshLauncher('x'), spawnFn: signalled.spawnFn }).run('a')).code, -1);
  const hung = fakeSpawn(() => undefined);
  const slow = await createChannel({ launcher: sshLauncher('x'), spawnFn: hung.spawnFn, timeoutMs: 20 }).run('a');
  assert.deepEqual([slow.code, slow.stderr.includes('Timed out.')], [-1, true]);
  // the close that follows the timeout changes nothing
  hung.children[0].emit('close', 0);
});

test('A: a stream to a program on the machine carries text both ways and ends when the program does', async () => {
  const f = fakeSpawn(() => undefined);
  const ch = createChannel({ launcher: vmLauncher('mopilot-x', '/v'), spawnFn: f.spawnFn });
  const s = ch.open("nc -U '/s'");
  assert.deepEqual(f.calls[0].stdio, ['pipe', 'pipe', 'ignore']);
  assert.deepEqual(f.calls[0].args.slice(0, 3), ['--vm', 'mopilot-x', '--stdin']);
  const [child] = f.children;
  const got: string[] = [];
  s.onData((c) => got.push(c));
  child.stdout.emit('data', Buffer.from('from the machine'));
  assert.deepEqual(got, ['from the machine']);
  s.write('to the machine\n');
  const killed = new Promise((r) => child.once('killed', r));
  s.kill();
  assert.equal(await killed, 'SIGTERM');
  child.emit('close', 0);
  await s.closed;
});

/** A stream whose other end the test plays. */
function pipe() {
  let push: (c: string) => void = () => undefined;
  let end: () => void = () => undefined;
  const written: string[] = [];
  const stream = {
    write: (t: string) => written.push(t),
    onData: (fn: (c: string) => void) => (push = fn),
    kill: () => end(),
    closed: new Promise<void>((r) => (end = r)),
  };
  return { stream, push: (c: string) => push(c), written, end: () => end() };
}

test('A: requests are answered by id; an error carries the Host’s code; events are kept; noise is ignored', async () => {
  const p = pipe();
  const c = lineClient(p.stream, { timeoutMs: 60 });
  const ok = c.request('status', { a: 1 });
  assert.deepEqual(JSON.parse(p.written[0]), { id: 1, method: 'status', params: { a: 1 } });
  p.push('not json\n{"id":1,"re');
  p.push('sult":{"running":true}}\n{"event":"frame","chatId":"c"}\n');
  assert.deepEqual(await ok, { running: true });
  assert.deepEqual(c.events, [{ event: 'frame', chatId: 'c' }]);
  assert.equal(await c.waitFor((e) => e.chatId === 'c'), c.events[0]);
  const bad = c.request('chat.subscribe');
  p.push('{"id":2,"error":"Not paired","code":"unknown_client"}\n');
  await assert.rejects(bad, (e: any) => e.code === 'unknown_client' && e.message === 'Not paired');
  await assert.rejects(c.request('slow'), (e: any) => e.code === 'timeout');
  await assert.rejects(
    c.waitFor(() => false, 40),
    /Timed out waiting for the Host to say so \(it last said \{"event":"frame","chatId":"c"\}\)\./,
  );
  await assert.rejects(
    lineClient(pipe().stream, { timeoutMs: 60 }).waitFor(() => false, 10),
    /^Error: Timed out waiting for the Host to say so\.$/,
  );
  const pending = c.request('later');
  c.close();
  await assert.rejects(pending, (e: any) => e.code === 'closed');
});

test('B: the command line names exactly one machine, and anything else is refused', () => {
  assert.deepEqual(parseArgs(['--vm', 'mopilot-work', '--keep', '--only', 'A1,A4', '--out', 'r.md']), {
    ...parseArgs(['--vm', 'mopilot-work']),
    keep: true,
    only: ['A1', 'A4'],
    out: 'r.md',
  });
  assert.deepEqual(parseArgs(['--ssh', 'me@box', '--ssh-arg', '-p', '--ssh-arg', '22']).sshArgs, ['-p', '22']);
  assert.throws(() => parseArgs([]), /exactly one of/);
  assert.throws(() => parseArgs(['--vm', 'a', '--ssh', 'b']), /exactly one of/);
  assert.throws(() => parseArgs(['--vm', 'a', '--nope']), /Unknown option --nope/);
  // the channel for either
  assert.equal(typeof channelFor(parseArgs(['--vm', 'mopilot-work'])).run, 'function');
  assert.equal(typeof channelFor(parseArgs(['--ssh', 'me@box'])).open, 'function');
});

test('A: steps run in order and timed; a failed required step skips the rest; --only keeps the required ones', async () => {
  let t = 0;
  const now = () => (t += 10);
  const order: string[] = [];
  const step = (id: string, fatal: boolean, fail = false) => ({
    id,
    title: id,
    fatal,
    run: async () => {
      order.push(id);
      if (fail) throw new Error(`${id} broke`);
      return `${id} saw it`;
    },
  });
  const steps = [step('S1', true), step('S2', false, true), step('S3', false), step('S4', true, true), step('S5', false)];
  const rows = await runSteps({ steps, ctx: {}, now });
  assert.deepEqual(
    rows.map((r) => [r.id, r.status, r.ms]),
    [
      ['S1', 'PASS', 10],
      ['S2', 'FAIL', 10],
      ['S3', 'PASS', 10],
      ['S4', 'FAIL', 10],
      ['S5', 'SKIP', 0],
    ],
  );
  assert.equal(rows[1].detail, 'S2 broke');
  assert.match(rows[4].detail, /earlier required step failed/);
  order.length = 0;
  await runSteps({ steps, ctx: {}, only: ['S3'], now });
  assert.deepEqual(order, ['S1', 'S3', 'S4']);
});

test('A: until waits for a condition and says what it waited for when it never comes', async () => {
  let n = 0;
  assert.equal(await until(async () => (++n > 2 ? 'yes' : null), { every: 1, what: 'x' }), 'yes');
  await assert.rejects(
    until(async () => null, { ms: 20, every: 5, what: 'the moon' }),
    /Timed out waiting for the moon/,
  );
  await assert.rejects(
    until(
      async () => {
        throw new Error('not yet');
      },
      { ms: 10, every: 2, what: 'a' },
    ),
    /Timed out waiting for a \(last error: not yet\)\./,
  );
});

/** A machine that answers as a Mac running the Host would, and the Host's socket on it. */
function fakeMachine(o: { breakStatus?: boolean; linux?: boolean; servesUnpaired?: boolean; core?: object } = {}) {
  const s = {
    pid: '',
    n: 1000,
    agent: '',
    paired: false,
    killed: false,
    uploads: [] as string[],
    commands: [] as string[],
    pids: [] as string[],
    agentLag: 0,
    lastInput: Buffer.alloc(0) as Buffer,
  };
  const m = {
    state: s,
    async run(command: string, input?: Buffer) {
      s.commands.push(command);
      if (input) s.uploads.push(command), (s.lastInput = input);
      const out = (stdout: string, code = 0) => ({ code, stdout, stderr: '' });
      if (command.includes('uname -sm'))
        return out(`${o.linux ? 'Linux x86_64' : 'Darwin arm64'}\nv22.1.0\n/usr/bin/nc\n/opt/homebrew/bin/node\n`);
      if (command.includes("pgrep -f '[m]opilot-host.mjs serve'")) return out(s.pids.length ? s.pids.shift()! : s.pid);
      if (command.includes("pgrep -f '[f]ake-acp-agent")) return out(s.agentLag-- > 0 ? '' : s.agent);
      if (command.includes('kickstart') || command.includes('systemctl')) return (s.pid = String(++s.n)), out('');
      // the killed Host is still listed for a poll, then gone, then the supervisor's new one is up
      if (command.startsWith('kill -9')) return (s.killed = true), (s.pids = [s.pid, '']), (s.pid = String(++s.n)), out('');
      // a Host takes an update only from a manifest the paired app signed for it
      if (command.includes('update --manifest') && command.includes('unsigned.json'))
        return { code: 1, stdout: '', stderr: 'The update manifest is not signed by a key this Host trusts; nothing was downloaded.' };
      if (command.includes('update --manifest'))
        return (s.pid = String(++s.n)), out('Staged version 0.0.1.\nThe Host is idle and restarts now.\n');
      if (command.includes('uninstall --purge')) return (s.pid = ''), out('Removed unit\nDeleted /data\n');
      if (command.includes('uninstall'))
        return (
          (s.pid = ''),
          out(
            "Removed unit\nKept /data and /config: the Host's chats, identity and pairings. To delete them too: mopilot-host uninstall --purge\n",
          )
        );
      // A9: what the uninstall kept is there, and after A14's purge nothing is left
      if (command.includes('ls -A')) return out('kept\n');
      if (command.includes('echo "left:')) return out('done\n');
      if (command.includes('test ! -S')) return out('gone\n');
      // A11: the repository, the machine's home, and the program the repository named staying unrun
      if (command.includes('status-repo') && command.includes('git init')) return out('');
      if (command.includes('printf %s "$HOME"')) return out('/home/u');
      if (command.includes('/ran"')) return { code: 1, stdout: '', stderr: '' };
      if (command.includes('out-link') && command.includes('ln -sfn')) return out('');
      if (command.includes('rm -rf') && command.includes('status-repo')) return out('');
      // A13: the repository whose patch is read
      if (command.includes('diff-repo') && command.includes('git init')) return out('');
      if (command.includes('/diff-ran"')) return { code: 1, stdout: '', stderr: '' };
      if (command.includes('rm -rf') && command.includes('diff-repo')) return out('');
      // A12: the folder of files to view
      if (command.includes('files-view') && command.includes('mkfifo')) return out('');
      if (command.includes('rm -rf') && command.includes('files-view')) return out('');
      if (command.includes('incoming')) return out('0\n');
      return out('');
    },
    open(command: string) {
      assert.match(command, /^nc -U '\/data\/mopilot-host\/host\.sock'$/);
      let push: (c: string) => void = () => undefined;
      let end: () => void = () => undefined;
      const reply = (id: number, body: object) => setImmediate(() => push(`${JSON.stringify({ id, ...body })}\n`));
      const frame = (e: object) => setImmediate(() => push(`${JSON.stringify({ event: 'frame', ...e })}\n`));
      const status = {
        running: true,
        version: '0.0.1',
        platform: 'darwin',
        harnesses: [
          { id: 'claude', detected: false, signedIn: false },
          { id: 'codex', detected: true, signedIn: true },
        ],
        capabilities: { iab: true },
        core: o.core,
        isolation: { delivered: ['a', 'b'], blocked: ['c'] },
      };
      // pairing is this connection's: a client that has not proved itself is refused whatever another connection did
      let authed = false;
      return {
        write(line: string) {
          const { id, method, params } = JSON.parse(line);
          if (method === 'host.challenge') return reply(id, { result: { nonce: 'n', hostId: 'ab'.repeat(16) } });
          if (method === 'status') return reply(id, { result: o.breakStatus ? { ...status, running: false } : status });
          if (method === 'host.pair' || method === 'host.auth') return (s.paired = true), (authed = true), reply(id, { result: {} });
          if (!authed && !o.servesUnpaired) return reply(id, { error: 'This client is not paired with the Host.', code: 'unknown_client' });
          if (method === 'host.hello') return reply(id, { result: { agreed: { features: ['epoch'] } } });
          if (method === 'git.diff')
            return reply(id, {
              result: {
                isRepo: true,
                patch: params.path.endsWith('/sub')
                  ? 'diff --git a/in.txt b/in.txt\n+edited\n'
                  : `diff --git a/a.txt b/a.txt\n${params.scope === 'branch' ? '+3\n' : ''}+4\ndiff --git a/new.txt b/new.txt\n+fresh\n`,
                truncated: false,
                unreadable: false,
              },
            });
          if (method === 'fs.tree')
            return params.path.includes('out-link')
              ? reply(id, { error: 'That folder is outside what this host shares.', code: 'outside_roots' })
              : reply(id, {
                  result: {
                    path: params.path,
                    entries: [
                      { name: 'src', isDirectory: true },
                      { name: 'README.md', isDirectory: false },
                      { name: 'blob.bin', isDirectory: false },
                    ],
                    truncated: false,
                  },
                });
          if (method === 'fs.read') {
            if (params.path.includes('out-file')) return reply(id, { error: 'outside', code: 'outside_roots' });
            if (params.path.includes('pipe')) return reply(id, { error: 'That is not a file.', code: 'not_a_file' });
            if (params.path.includes('blob.bin')) return reply(id, { result: { kind: 'binary', size: 3 } });
            return reply(id, { result: { kind: 'text', text: 'hello from the machine\n', size: 23, truncated: false } });
          }
          if (method === 'git.status')
            return params.path.includes('out-link')
              ? reply(id, { error: 'That folder is outside what this host shares.', code: 'outside_roots' })
              : reply(id, {
                  result: {
                    isRepo: true,
                    branch: 'feature',
                    files: [
                      { path: 'a.txt', added: 1, removed: 0 },
                      { path: 'new.txt', added: 0, removed: 0, untracked: true },
                    ],
                  },
                });
          if (method === 'chat.subscribe') {
            // the Host that replaced a killed one ends the interrupted turn for a client that subscribes again
            if (/^acp:fake:accept2-/.test(params.chatId) && s.killed)
              (s.agent = ''),
                frame({ chatId: params.chatId, frame: { item: { t: 'event', event: { kind: 'turnEnd', stopReason: 'cancelled' } } } });
            return reply(id, { result: {} });
          }
          if (method === 'chat.start') {
            if (params.text.includes('SLOW')) (s.agent = '4242'), (s.agentLag = 1);
            else
              frame({
                chatId: params.chatId,
                frame: { item: { t: 'assistant', text: `fake-acp: ${params.text}`, stopReason: 'end_turn' } },
              });
            // other chats' frames are not this chat's
            frame({ chatId: 'someone-else', frame: { item: { t: 'user' } } });
            return reply(id, { result: { turnId: 't' } });
          }
          return reply(id, { error: `unexpected ${method}` });
        },
        onData: (fn: (c: string) => void) => (push = fn),
        kill: () => end(),
        closed: new Promise<void>((r) => (end = r)),
      };
    },
  };
  return m;
}

/** The app’s pieces, as the stand-in machine needs them. */
function fakeDeps(
  machine: ReturnType<typeof fakeMachine>,
  o: { failInstall?: boolean; badUpload?: 'refused' | 'accepted'; core?: string } = {},
) {
  const real = realDeps();
  return () => ({
    ...real,
    buildBundle: () => ({
      file: '/out/host-0.0.1-abc.tgz',
      manifest: '/out/manifest.json',
      sha256: 'a'.repeat(64),
      version: '0.0.1',
      files: 12,
      core: o.core ?? null,
    }),
    readFile: (file: string) =>
      file.endsWith('manifest.json')
        ? Buffer.from(JSON.stringify({ version: '0.0.1', sha256: 'a'.repeat(64), url: 'host.tgz' }))
        : Buffer.from('bytes'),
    loadIdentity: () => ({ signManifest: () => 'signature' }),
    pairWith: async (request: any) => request('host.pair', {}),
    authenticate: async (request: any) => request('host.auth', {}),
    helloParams: () => ({}),
    createInstaller: ({ bundle, channel }: any) => ({
      async install() {
        // the app reads the package first
        bundle('linux-x64-gnu');
        await channel('x', 'node --version');
        const sent = Buffer.alloc(2048, 7);
        await channel('x', 'upload', sent);
        // what arrived is not what was sent: the machine's own check of the upload refuses it
        if (!machine.state.lastInput.equals(sent)) {
          await channel('x', 'verify', undefined);
          return o.badUpload === 'accepted'
            ? { ok: true, status: { socketPath: '/data/mopilot-host/host.sock', version: '0.0.1' }, pairingCode: 'AAAA-BBBB', steps: [] }
            : { ok: false, failedStep: 'verify', error: 'got 1234\nmore', steps: [] };
        }
        machine.state.pid = '1000';
        return o.failInstall
          ? { ok: false, failedStep: 'unpack', error: 'no space', steps: [] }
          : {
              ok: true,
              status: { socketPath: '/data/mopilot-host/host.sock', version: '0.0.1' },
              pairingCode: 'AAAA-BBBB',
              steps: [
                { id: 'node', state: 'ok' },
                { id: 'status', state: 'ok' },
              ],
            };
      },
    }),
  });
}

async function runAll(machine: any, extra: string[] = [], o: Parameters<typeof fakeDeps>[1] = {}) {
  const out: string[] = [];
  const code = await main(['--vm', 'mopilot-work', ...extra], {
    out: (t) => out.push(t),
    deps: fakeDeps(machine, o) as any,
    channelFor: () => machine,
  });
  return { code, report: out[0] };
}

test('I: every step passes against a machine that behaves as a Host does, and the machine is left clean', { timeout: 60_000 }, async () => {
  const machine = fakeMachine();
  const outFile = path.join(tmp, 'report.md');
  const { code, report } = await runAll(machine, ['--out', outFile]);
  assert.equal(code, 0, report);
  assert.match(report, /\*\*14\/14 passed\*\*/);
  for (const s of STEPS) assert.ok(report.includes(`| ${s.id} `), s.id);
  assert.equal(fs.readFileSync(outFile, 'utf8'), report);
  // the fake agent and its modules went up, and the run removed what it put on the machine
  assert.ok(machine.state.uploads.some((c) => c.includes('fake-acp-agent.mjs')));
  assert.ok(machine.state.uploads.some((c) => c.includes('harnesses.json')));
  assert.match(
    machine.state.commands.at(-1)!,
    /uninstall --purge; rm -rf "\$HOME\/\.mopilot-host" \$HOME\/\.mopilot-accept "\/data\/mopilot-host"/,
  );
});

test('I: a tarball that carried the core needs a Host that loaded it, as installed and as updated', { timeout: 60_000 }, async () => {
  const loaded = { loaded: true, build: 'linux-x64-gnu', routes: 20 };
  const good = await runAll(fakeMachine({ core: loaded }), [], { core: 'linux-x64-gnu' });
  assert.equal(good.code, 0, good.report);
  assert.match(good.report, /core linux-x64-gnu, 20 routes/);
  assert.match(good.report, /with its linux-x64-gnu core/);
  const none = await runAll(fakeMachine({ core: { loaded: false, build: 'linux-x64-gnu', routes: 0 } }), [], { core: 'linux-x64-gnu' });
  assert.match(none.report, /The Host did not load its linux-x64-gnu core/);
  assert.match(none.report, /The updated Host did not load its core/);
});

test('I: on a Linux machine the service is restarted with systemd, and a Host that serves an unpaired client fails the pairing step', {
  timeout: 60_000,
}, async () => {
  const linux = fakeMachine({ linux: true });
  const { code, report } = await runAll(linux, ['--keep']);
  assert.equal(code, 0, report);
  assert.ok(linux.state.commands.some((c) => c.includes('systemctl --user restart mopilot-host')));
  assert.match(report, /### Host acceptance run on mopilot-work \(Linux /, 'the report names the platform the machine said');
  assert.ok(!linux.state.commands.some((c) => c.includes('launchctl')));
  const open = await runAll(fakeMachine({ servesUnpaired: true }), ['--keep', '--only', 'A5']);
  assert.match(open.report, /\| A5 .* \| FAIL \|.*not refused with unknown_client/);
});

test('I: --keep leaves the Host installed, and --only runs the steps asked for after the required ones', { timeout: 60_000 }, async () => {
  const machine = fakeMachine();
  const { code, report } = await runAll(machine, ['--keep', '--only', 'A4']);
  assert.equal(code, 0, report);
  assert.match(report, /\*\*4\/4 passed\*\*/);
  assert.ok(!machine.state.commands.some((c) => c.includes('rm -rf "$HOME/.mopilot-host"')), 'the Host stays');
  // the run's test agent does not: its files and its entry go, and the Host is restarted to read that
  const removal = machine.state.commands.findIndex((c) => c.includes('/accept-agent"; [ ! -f'));
  assert.ok(removal >= 0, 'the test agent is removed');
  assert.ok(
    machine.state.commands.slice(removal + 1).some((c) => c.includes('launchctl kickstart')),
    'then the Host restarts',
  );
});

test('W: a step that fails is reported with why, and the exit code says the run failed', { timeout: 60_000 }, async () => {
  const stopped = await runAll(fakeMachine({ breakStatus: true }), ['--only', 'A4']);
  assert.equal(stopped.code, 1);
  assert.match(stopped.report, /\| A4 .* \| FAIL \|.*says it is not running/);
  const noInstall = await runAll(fakeMachine(), [], { failInstall: true });
  assert.equal(noInstall.code, 1);
  assert.match(noInstall.report, /\| A3 .* \| FAIL \|.*Failed at unpack: no space/);
  assert.match(noInstall.report, /\| A4 .* \| SKIP \|/);
  const accepted = await runAll(fakeMachine(), ['--only', 'A10'], { badUpload: 'accepted' });
  assert.match(accepted.report, /\| A10 .* \| FAIL \|.*Expected a failure at verify/);
  const wrongMachine = fakeMachine();
  const oldNode = {
    ...wrongMachine,
    run: async (c: string) =>
      c.includes('uname') ? { code: 0, stdout: 'Linux x86_64\nv18.0.0\n/bin/nc\n/usr/bin/node\n', stderr: '' } : wrongMachine.run(c),
  };
  assert.match((await runAll(oldNode as any, ['--only', 'A1'])).report, /Node 22 or newer is needed \(found v18\.0\.0\)/);
  const noMachine = { ...wrongMachine, run: async () => ({ code: 255, stdout: '', stderr: 'no route' }) };
  assert.match((await runAll(noMachine as any, ['--only', 'A1'])).report, /could not be asked: no route/);
});

test('I: run as a program: a bad command line exits 2, and a run whose first step fails exits 1 with the table', {
  timeout: 60_000,
}, () => {
  const script = path.join(ROOT, 'scripts/host-accept.mjs');
  const bad = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.deepEqual([bad.status, /host-accept: Unknown option --bogus/.test(bad.stderr)], [2, true]);
  // a `ssh` that cannot reach anything: the first step fails and the rest are skipped
  const bin = fs.mkdtempSync(path.join(tmp, 'bin-'));
  fs.writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\necho unreachable >&2\nexit 255\n', { mode: 0o755 });
  const run = spawnSync(process.execPath, [script, '--ssh', 'me@nowhere', '--keep'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /\| A1 .* \| FAIL \|.*unreachable/);
  assert.match(run.stdout, /\| A2 .* \| SKIP \|/);
});
