// The Rust core as the app loads it (electron/platform/core.cjs, core/crates/node): its routes, their replies, an
// unknown route's error, and the process table through processTree.cjs. It needs a built addon (MOPILOT_CORE, or the
// release build in core/target), and is skipped without one unless MOPILOT_CORE_REQUIRED says the run must have it (the
// unit check's job rust, which also measures the binding's own Rust code through these calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ownedNode, TREE } from './support/core-process-fixture.ts';

const require = createRequire(import.meta.url);
const { corePath, loadCore, coreCall } = require('../electron/platform/core.cjs');
const { processTable } = require('../electron/platform/processTree.cjs');
const { readDarwin } = require('../electron/platform/memoryPressure.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !addon && !required && `no Rust core built at ${corePath()}`;

test('the core is built and loads where the run requires it', { skip }, () => {
  // the loader keeps its error to itself (a missing core is no failure for the app): load it again here to say why
  if (!addon) process.dlopen({ exports: {} }, corePath());
  assert.ok(addon, `the core at ${corePath()} loads`);
});

test('the core serves the proc routes', { skip }, async () => {
  // a coverage build also has the routes only tests call (tests/coreBindingCalls.test.ts)
  const served = addon.routes().filter((route: string) => !route.startsWith('test.'));
  assert.deepEqual(served, [
    'batcher.backgroundTick',
    'batcher.cancel',
    'batcher.close',
    'batcher.drop',
    'batcher.families',
    'batcher.flush',
    'batcher.flushAll',
    'batcher.open',
    'batcher.push',
    'batcher.tick',
    'caps.ancestry',
    'caps.executable',
    'caps.peerPid',
    'caps.ready',
    'framing.close',
    'framing.open',
    'framing.push',
    'llmroute.streamClose',
    'llmroute.streamFinish',
    'llmroute.streamOpen',
    'llmroute.streamPush',
    'llmroute.translateRequest',
    'llmroute.translateResponse',
    'proc.ack',
    'proc.closeInput',
    'proc.commands',
    'proc.contain',
    'proc.drop',
    'proc.endContained',
    'proc.endInput',
    ...(process.platform === 'win32' ? [] : ['proc.identities']),
    'proc.kill',
    'proc.pressure',
    'proc.signal',
    'proc.spawn',
    'proc.started',
    'proc.table',
    'proc.want',
    'proc.write',
    'rank.close',
    'rank.open',
    'rank.search',
    'rollout.close',
    'rollout.open',
    'rollout.page',
    'rollout.usage',
    'session.close',
    'session.drain',
    'session.drainable',
    'session.open',
    'session.patch',
    'session.putBack',
    'session.sendNow',
    'session.step',
    'store.errorNames',
    'store.readRecords',
    'store.writeRecord',
    'transcript.append',
    'transcript.audioRefs',
    'transcript.checkpoints',
    'transcript.close',
    'transcript.contains',
    'transcript.drain',
    'transcript.flush',
    'transcript.has',
    'transcript.open',
    'transcript.pending',
    'transcript.read',
    'transcript.remove',
    'transcript.scan',
    'translate.claudeAgentItems',
    'translate.claudeClose',
    'translate.claudeEvent',
    'translate.claudeOpen',
    'translate.claudeRead',
    'translate.claudeRelease',
    'translate.claudeSettle',
    'translate.claudeWalk',
    'translate.close',
    'translate.event',
    'translate.keep',
    'translate.open',
    'translate.page',
    'translate.read',
    'translate.release',
    'translate.replay',
    'translate.settle',
    'translate.turns',
  ]);
  const rows = await coreCall('proc.table', addon);
  const own = rows.find((r: number[]) => r[0] === process.pid);
  assert.deepEqual(own, [process.pid, process.ppid, own[2]]);
  const started = await coreCall('proc.started', addon, String(process.pid));
  assert.ok(Math.abs(started - (Date.now() - process.uptime() * 1000)) < 60_000, String(started));
  assert.equal(await coreCall('proc.started', addon, String(2 ** 30)), null);
  const level = await coreCall('proc.pressure', addon);
  assert.ok(level === null || [1, 2, 4].includes(level), String(level));
  // this process with its command line, as ps shows it (node and its arguments); Windows reads none yet, and says so
  if (process.platform === 'win32') await assert.rejects(coreCall('proc.commands', addon), /no command lines on this platform yet/);
  else {
    const lines = await coreCall('proc.commands', addon);
    const me = lines.find((r: [number, number, string]) => r[0] === process.pid);
    assert.equal(me[1], process.ppid);
    assert.match(me[2], /node/);
  }
});

test('a real child is held in a Job Object on Windows only, and ending the job leaves it alive', { skip }, async (t) => {
  const child = ownedNode(t);
  const { pid } = await child.ready;
  const held = await coreCall('proc.contain', addon, `${pid} ${Date.now()}`);
  assert.equal(held, process.platform === 'win32');
  const ended = await coreCall('proc.endContained', addon, String(pid));
  // This fixture has no descendants. The separate native held-tree test covers inherited and orphaned children.
  if (process.platform === 'win32') assert.deepEqual(ended, []);
  else assert.equal(ended, null);
  assert.doesNotThrow(() => process.kill(pid, 0));
  // a pid that is not this process's child is never held
  assert.equal(await coreCall('proc.contain', addon, `${process.ppid} ${Date.now()}`), false);
});

test("dispatchSync answers on the calling thread, and throws the route's error", { skip }, () => {
  assert.ok(JSON.parse(String(addon.dispatchSync('proc.table', Buffer.alloc(0)))).length > 0);
  assert.throws(() => addon.dispatchSync('proc.nowhere', Buffer.alloc(0)), /no core route proc\.nowhere/);
  assert.throws(() => addon.dispatchSync(42, Buffer.alloc(0)), /the core binding failed \(Node-API status \d+\)/);
});

test("an unknown route is the core's error, and a call it cannot read throws", { skip }, async () => {
  await assert.rejects(addon.dispatch('proc.nowhere', Buffer.alloc(0)), /no core route proc\.nowhere/);
  // a payload's bytes are handed to the route (proc.table reads none)
  assert.ok(JSON.parse(String(await addon.dispatch('proc.table', Buffer.from('{}')))).length > 0);
  // a route that is not a string never reaches the core
  assert.throws(() => addon.dispatch(42, Buffer.alloc(0)), /the core binding failed \(Node-API status \d+\)/);
});

test('processTree and memoryPressure read through the core, with no process started', { skip }, async () => {
  const table = await processTable((route: string) => coreCall(route, addon));
  assert.ok(table.some((r: number[]) => r[0] === process.pid));
  if (process.platform === 'darwin') {
    const level = await readDarwin((route: string) => coreCall(route, addon));
    assert.ok(level === null || level === 'warning' || level === 'critical');
  }
});

test('proc.kill ends a real process tree, children first, without touching an unrelated process', { skip, timeout: 20_000 }, async (t) => {
  const tree = ownedNode(t, { source: TREE });
  const sentinel = ownedNode(t);
  const [root, unrelated] = await Promise.all([tree.ready, sentinel.ready]);
  assert.equal(root.pid, tree.process.pid);
  assert.equal(root.child?.ppid, root.pid);
  const child = root.child!.pid;
  const rows = await coreCall('proc.table', addon);
  assert.deepEqual(rows.find((r: number[]) => r[0] === child)?.slice(0, 2), [child, root.pid]);
  const unexpected = rows.filter((r: number[]) => (r[1] === root.pid && r[0] !== child) || r[1] === child);
  if (unexpected.length) {
    const identities = await Promise.all(
      [[root.pid, root.ppid], [child, root.pid], ...unexpected].map(async ([pid, ppid]: number[]) => ({
        pid,
        ppid,
        executable: await coreCall('caps.executable', addon, String(pid)).catch(String),
        started: await coreCall('proc.started', addon, String(pid)),
      })),
    );
    const images =
      process.platform === 'win32'
        ? spawnSync(
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-Process -Id ${identities.map(({ pid }) => pid).join(',')} -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, Path, StartTime | ConvertTo-Json -Compress`,
            ],
            { windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 32_768 },
          )
        : null;
    const diagnostic = images && { status: images.status, error: images.error?.message, stdout: images.stdout, stderr: images.stderr };
    assert.fail(
      `the controlled tree has unexpected descendants; refusing to terminate them: ${JSON.stringify({ identities, images: diagnostic })}`,
    );
  }
  assert.deepEqual(await coreCall('proc.kill', addon, String(root.pid)), [child, root.pid]);
  await tree.exited;
  const deadline = Date.now() + 5000;
  while ((await coreCall('proc.table', addon)).some((r: number[]) => r[0] === child)) {
    assert.ok(Date.now() < deadline, 'the terminated child exits within five seconds');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), 'a different live process survives');
});
