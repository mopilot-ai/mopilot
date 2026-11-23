// CM-L17 (#1347, #1486): a harness process MoPilot stops, or one that exits on its own or is killed outside MoPilot,
// takes the commands it started with it. Codex's app-server (electron/harness/codexProcess.cjs) and an ACP agent (electron/harness/acp/agent.cjs) run real
// stand-in processes here (node, which runs `sleep 30` as its command), each spawned in a process group of its own.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { AppServer } = require('../electron/harness/codexProcess.cjs');
const { AcpAgent } = require('../electron/harness/acp/agent.cjs');

const posix = process.platform !== 'win32';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (!alive(pid)) return true;
  return false;
}

const dirs: string[] = [];
const pids = new Set<number>();
afterEach(() => {
  for (const pid of pids)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ended already
    }
  pids.clear();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * A harness binary stand-in: it runs `sleep 30` as its command and reports the command's pid (`{"pid":N}` on stdout
 * for Codex, `pid N` on stderr for ACP). `mode`:
 * - 'stay' runs until stopped, 'stubborn' ignores its input closing: the command is in a process group of its own, as
 *   Codex and Claude Code run commands, and is found through the process tree;
 * - 'crash' is Codex's npm launcher over its binary: the launcher exits at once (code 3) while the binary, still in the
 *   app-server's group, keeps the command (in a group of its own) running;
 * - 'eof' exits when its input closes, with its command in its own group of processes (the agent's).
 * A process that exits while its command sits in a group of its own leaves it re-parented, out of reach of a walk from
 * the process (measured on #1347 with a SIGKILLed Claude Code CLI): the watch (electron/platform/processTree.cjs) recorded the
 * command while the process ran (#1486).
 */
function standIn(mode: 'stay' | 'crash' | 'eof' | 'stubborn', report: 'stdout' | 'stderr') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-l17-'));
  dirs.push(dir);
  const bin = path.join(dir, 'harness');
  const say =
    report === 'stdout' ? 'process.stdout.write(JSON.stringify({ pid: c.pid }) + "\\n")' : 'process.stderr.write("pid " + c.pid + "\\n")';
  const command = (own: boolean) =>
    `const c = require('child_process').spawn('sh', ['-c', 'exec sleep 30'], { stdio: 'ignore', detached: ${own} });`;
  const binary = `${command(true)} ${say}; setInterval(() => {}, 1000);`;
  const body = {
    stay: `${command(true)}\n${say};\nsetInterval(() => {}, 1000);`,
    stubborn: `${command(true)}\n${say};\nprocess.stdin.resume(); setInterval(() => {}, 1000);`,
    eof: `${command(false)}\n${say};\nprocess.stdin.on("end", () => process.exit(0)); process.stdin.resume();`,
    crash: `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(binary)}], { stdio: ['ignore', 'inherit', 'inherit'] });\nsetTimeout(() => process.exit(3), 300);`,
  }[mode];
  fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  return bin;
}

/** Records now what is below the watched processes, instead of waiting for the watcher's own tick (slow under load). */
async function recorded(watch: { known: Map<number, number> }, command: number) {
  const { watcher } = require('../electron/platform/processTree.cjs');
  for (const end = Date.now() + 8000; !watch.known.has(command) && Date.now() < end; await sleep(20)) await watcher.tick();
  assert.ok(watch.known.has(command), 'the command was recorded below the harness');
}

/** Codex: an AppServer on the stand-in, with the command pid it reported. */
async function codex(mode: 'stay' | 'crash') {
  const server = new AppServer({ findBin: () => standIn(mode, 'stdout'), onCrashReport: () => {} });
  const events: any[] = [];
  const reported = new Promise<number>((resolve) =>
    server.listeners.add((e: any) => {
      events.push(e);
      if (e.kind === 'message' && e.msg?.pid) resolve(e.msg.pid);
    }),
  );
  server.start();
  const leader = server.proc.pid;
  pids.add(leader);
  const command = await reported;
  pids.add(command);
  return { server, leader, command, events };
}

test('CM-L17: stopping Codex ends the command its app-server is running', { skip: !posix }, async () => {
  const { server, leader, command } = await codex('stay');
  assert.equal(alive(command), true);
  server.stop();
  assert.equal(await gone(command), true, 'the command went with the app-server');
  assert.equal(await gone(leader), true);
});

test('CM-L17: an app-server whose launcher crashes takes its binary and its command with it', { skip: !posix }, async () => {
  const { command, events } = await codex('crash');
  for (const end = Date.now() + 5000; !events.some((e) => e.kind === 'exit') && Date.now() < end; ) await sleep(50);
  assert.ok(
    events.some((e) => e.kind === 'exit' && e.code === 3),
    'the crash was reported',
  );
  assert.equal(await gone(command), true, 'its command did not outlive it');
});

test('CM-L17: an app-server SIGKILLed outside MoPilot leaves no command running', { skip: !posix }, async () => {
  const { server, leader, command } = await codex('stay');
  await recorded(server.proc.watch, command);
  process.kill(leader, 'SIGKILL');
  assert.equal(await gone(leader), true);
  assert.equal(await gone(command), true, 'the command, re-parented to launchd, was found through the recording and ended');
  server.stop();
});

/** ACP: an agent on the stand-in, with the command pid it reported on stderr. */
async function acp(mode: 'eof' | 'stubborn') {
  const agent = new AcpAgent({
    harness: 'stand-in',
    command: standIn(mode, 'stderr'),
    env: process.env,
    cwd: os.tmpdir(),
    onRequest: async () => null,
  });
  agent.start();
  pids.add(agent.pid);
  let command = 0;
  for (const end = Date.now() + 5000; !command && Date.now() < end; await sleep(20))
    command = Number(/pid (\d+)/.exec(agent.stderr.text)?.[1] ?? 0);
  assert.ok(command > 1, 'the stand-in reported its command');
  pids.add(command);
  return { agent, command };
}

test('CM-L17: an ACP agent that exits when its input closes takes its command with it', { skip: !posix }, async () => {
  const { agent, command } = await acp('eof');
  const exited = new Promise((r) => agent.once('exit', r));
  agent.kill();
  await exited;
  assert.equal(await gone(command), true, 'the agent exited on its own: its leftover command was ended');
});

test('CM-L17: an ACP agent that ignores its input closing is stopped with its command', { skip: !posix }, async () => {
  const { agent, command } = await acp('stubborn');
  agent.kill();
  await sleep(500);
  assert.equal(alive(command), true, 'stdin closing first gives the agent its 2 s to exit by itself');
  assert.equal(await gone(command, 8000), true, 'then the agent and its command are stopped together');
});

test('CM-L17: an ACP agent SIGKILLed outside MoPilot leaves no command running', { skip: !posix }, async () => {
  const { agent, command } = await acp('stubborn');
  await recorded(agent.proc.watch, command);
  process.kill(agent.pid, 'SIGKILL');
  assert.equal(await gone(command), true, 'the agent was killed; its command was ended all the same');
});

test('CM-L17: a Claude Code CLI SIGKILLed outside MoPilot leaves no command running (watched by pid, as the SDK reports it)', {
  skip: !posix,
}, async () => {
  const { spawn } = require('node:child_process');
  const { watchTree, reapTree } = require('../electron/platform/processTree.cjs');
  let command = 0;
  // the CLI is no group leader of ours (the SDK spawns it as it is); its command is in a group of its own
  const cli = spawn(standIn('stay', 'stderr'), [], { stdio: ['ignore', 'ignore', 'pipe'] });
  pids.add(cli.pid);
  cli.stderr.on('data', (d: Buffer) => (command ||= Number(/pid (\d+)/.exec(String(d))?.[1] ?? 0)));
  const tree = watchTree(cli.pid);
  for (const end = Date.now() + 5000; !command && Date.now() < end; await sleep(20));
  assert.ok(command > 1);
  pids.add(command);
  await recorded(tree, command);
  const exited = new Promise((r) => cli.once('exit', r));
  process.kill(cli.pid, 'SIGKILL');
  await exited;
  assert.equal(alive(command), true, 'a walk from the CLI finds nothing: the command is already re-parented');
  assert.equal(await reapTree(tree), true);
  assert.equal(await gone(command), true);
});

test('CM-L17 guard: every process main stops with killTree was spawned in a group of its own (spawnGroup)', async () => {
  const { treeFiles } = await import('../scripts/source-tree.mjs');
  const root = path.join(import.meta.dirname, '..');
  // stops a process another file spawned: codexConnection ends the AppServer's (codexProcess.cjs) own process
  const STOPS_ANOTHER = new Set(['electron/harness/codexConnection.cjs']);
  const callers = treeFiles(path.join(root, 'electron'), /\.c?js$/)
    .map((f: string) => path.relative(root, f))
    .filter((f: string) => f !== 'electron/platform/winbin.cjs' && /\bkillTree\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.ok(callers.length >= 5, `found the stop paths: ${callers.join(', ')}`);
  for (const f of callers) {
    if (STOPS_ANOTHER.has(f)) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(text, /\bspawnGroup\(/, `${f} stops a process with killTree: spawn it with spawnGroup, so its commands go too`);
    assert.match(text, /\bendGroup\(/, `${f}: a process that exits on its own must end its group (endGroup)`);
    // and no process it might stop is spawned the old way, without a group of its own
    assert.doesNotMatch(
      text,
      /spawn\(\s*\.\.\.\s*spawnArgs\(/,
      `${f}: spawn(...spawnArgs(...)) starts a process killTree cannot end with its commands`,
    );
  }
});
