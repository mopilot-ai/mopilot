// The app's side of a chat on a Host's own desktop, on a real machine (G8 #3903): the app's own modules (electron/host/*.cjs, electron/capabilities/hostDesktop.cjs and the desktop_* tools, plain CommonJS) driven from Node, with no Electron, against a Host and a computer-use helper in a disposable guest over real ssh. It shows what the unit tests and the fake-Host E2E cannot: the Host's real capabilities decide which tools a Host chat is offered, a lease and a screenshot go over the real wire to the real helper, the mouse moves on the GUEST's desktop (read back from the guest itself), this Mac's helper is never started, and what was approved is listed per machine and goes with the machine.
//   VMLOCK_VM=<vm> ~/bench/runner/vmlock.sh acquire <tag>; node bench/g8-app-desktop.mjs --vm <mopilot-*> --helper <path of "MoPilot.app" on the guest> [--out report.md]
// The helper's macOS grants are the image's (provision them first, bench/g8-host-desktop.mjs header); the run changes none. Run on a disposable guest only: it acts on that guest's desktop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createChannel, vmLauncher } from '../scripts/host-accept/channel.mjs';
import { exitCode, formatReport } from '../scripts/host-accept/report.mjs';
import { runSteps } from '../scripts/host-accept.mjs';
import { expect, restart, until } from '../scripts/host-accept/steps.mjs';
import { STEPS as APP_STEPS, cleanup } from '../scripts/host-accept-app/steps.mjs';
import { realDeps } from '../scripts/host-accept-app.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What this run cannot show. */
export const NOT_VERIFIED = Object.freeze([
  'The app’s windows: the same modules from Node, so no renderer, IPC or Electron (the fake-Host E2E, tests/e2e/host-desktop.spec.ts, covers the Electron app against a fake helper)',
  'A model: the desktop_* tools are called by this script, not by a harness',
  'A golden image with SIP on: this guest is the lean base with its grants provisioned',
]);

/** Runs a desktop_* tool of the Host stack as a chat's tool call. @param {any} ctx @param {string} chat @param {string} name @param {object} args */
const tool = (ctx, chat, name, args = {}) => {
  const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
  return guarded({ token: { chat, turn: 1 } }, () =>
    ctx.state.hd.route([{ name, handler: () => Promise.reject(new Error('this Mac')) }])[0].handler(args, { chatId: chat }),
  );
};

/** The guest's own mouse position, read in the guest: [x, y] in points from the top left. @param {any} ctx */
async function guestMouse(ctx) {
  const js =
    'ObjC.import("AppKit"); const p=$.NSEvent.mouseLocation; const h=$.NSScreen.screens.objectAtIndex(0).frame.size.height; Math.round(p.x)+","+Math.round(h-p.y)';
  const r = await ctx.m.run(`osascript -l JavaScript -e '${js}'`);
  expect(r.code === 0, `The guest's mouse could not be read: ${r.stderr}`);
  return r.stdout.trim().split(',').map(Number);
}

/** @type {{ id: string, title: string, fatal?: boolean, run: (ctx: any) => Promise<string> }[]} */
const STEPS = [
  ...APP_STEPS.filter((s) => ['B1', 'B2', 'B3'].includes(s.id)),
  {
    id: 'C1',
    title: 'Give the Host its helper; its own status reports desktop (and not cu), and the app reads it',
    fatal: true,
    async run(ctx) {
      const dest = `${ctx.state.dataDir}/helper`;
      const r = await ctx.m.run(`rm -rf "${dest}" && mkdir -p "${dest}" && cp -R "${ctx.helper}" "${dest}/"`);
      expect(r.code === 0, `The helper could not be copied: ${r.stderr}`);
      await restart(ctx);
      const host = await until(async () => ctx.state.machines.connectedHost(ctx.state.id), {
        what: 'the app’s connection to the Host',
        ms: 90_000,
        every: 500,
      });
      const status = await until(
        async () => {
          const s = await host.status();
          return s.capabilities?.desktop === true ? s : null;
        },
        { what: 'the Host to report capabilities.desktop', ms: 90_000, every: 1000 },
      );
      expect(status.capabilities.cu === false, 'capabilities.cu must stay false for a Host.');
      ctx.state.host = host;
      return `capabilities ${JSON.stringify(status.capabilities)}`;
    },
  },
  {
    id: 'C2',
    title:
      'From the Host’s real capabilities, a chat on it is offered desktop_* and never computer_*; the tool relay announces desktop_* only now that it has a desktop',
    async run(ctx) {
      const { Registry } = require('../electron/capabilities/contract/registry.cjs');
      const { hostToolsFor } = require('../electron/host/toolRelay.cjs');
      const caps = await until(
        async () =>
          ctx.state.machines.capabilities(ctx.state.id)?.desktop === true ? ctx.state.machines.capabilities(ctx.state.id) : null,
        {
          what: 'the app’s machine row to show desktop',
          ms: 90_000,
          every: 1000,
        },
      );
      const registry = new Registry();
      for (const name of ['desktop_screenshot', 'computer_click', 'browser_open'])
        registry.register({ name, policy: 'observe', handler: async () => 'x' });
      registry.setHostScope((/** @type {string} */ chatId) => (chatId === 'host-chat' ? caps : null));
      const listed = registry.list({ chatId: 'host-chat' }).map((/** @type {any} */ t) => t.name);
      expect(
        listed.includes('desktop_screenshot') && !listed.some((/** @type {string} */ n) => n.startsWith('computer_')),
        `The Host chat is offered ${listed.join(', ')}.`,
      );
      const refused = await registry.invoke('host-chat', 's1', 'computer_click', {});
      expect(
        !refused.ok && refused.error?.code === 'capability_missing',
        `computer_click on a Host chat answered ${JSON.stringify(refused.error ?? refused)}.`,
      );
      expect(
        registry.list({ chatId: 'mac-chat' }).some((/** @type {any} */ t) => t.name === 'computer_click'),
        'A chat on this Mac lost computer_click.',
      );
      const include = hostToolsFor(() => caps.desktop === true);
      expect(include({ name: 'desktop_screenshot' }) && !include({ name: 'computer_click' }), 'The relay announce filter is wrong.');
      return `Host chat offered [${listed.join(', ')}]; computer_click refused as ${refused.error?.code}`;
    },
  },
  {
    id: 'C3',
    title:
      'The app’s desktop stack over the real wire: access card (auto-allowed), a screenshot of the GUEST’s desktop, and this Mac’s helper never started',
    async run(ctx) {
      const { ComputerHelper } = require('../electron/capabilities/computer.cjs');
      const { createHostDesktop } = require('../electron/capabilities/hostDesktop.cjs');
      const { hostGrantStore } = require('../electron/capabilities/hostGrants.cjs');
      const { hostDesktopOptions } = require('../electron/host/remoteDesktop.cjs');
      // this Mac's helper must stay untouched: any start is a failure of the routing
      ctx.state.macStarts = 0;
      const realStart = ComputerHelper.prototype.start;
      ComputerHelper.prototype.start = function () {
        ctx.state.macStarts++;
        return realStart.apply(this, arguments);
      };
      ctx.state.restoreStart = () => (ComputerHelper.prototype.start = realStart);
      const live = {
        hostOwnership: { get: () => ({ hostId: ctx.state.id }) },
        connectedHostFor: (/** @type {string} */ id) => ctx.state.machines.connectedHost(id),
        hostNameOf: () => 'the guest',
      };
      const o = hostDesktopOptions(live);
      const asks = [];
      const broker = {
        ask: async (/** @type {string} */ chatId, /** @type {string} */ kind, /** @type {any} */ params) => {
          asks.push({ kind, machine: params?.machine });
          return { decision: 'allow', scope: 'chat' };
        },
      };
      const session = { activeTurn: { human: true }, permission: 'default', scheduled: null };
      const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-app-desktop-'));
      ctx.state.userData = userData;
      ctx.state.grantsFor = (/** @type {string} */ hostId) =>
        (ctx.state.stores ??= new Map()).get(hostId) ??
        (ctx.state.stores.set(hostId, hostGrantStore({ dir: userData, hostId })), ctx.state.stores.get(hostId));
      ctx.state.hd = createHostDesktop({
        ownerOf: (/** @type {string} */ c) => (c.startsWith('real-') ? ctx.state.id : null),
        remoteFor: (/** @type {string} */ id) => o.remoteDesktopFor(id),
        grantsFor: ctx.state.grantsFor,
        nameOf: () => 'the guest',
        deps: {
          broker,
          sessions: { get: () => session },
          controller: { isSubagentCall: () => false },
          kindOf: () => 'claude',
          anchorOf: () => 'ask',
          userIdleSeconds: async () => 0,
          unattendedAllowed: () => false,
          onUnattended: () => undefined,
          onStop: () => undefined,
        },
      });
      ctx.state.asks = asks;
      const chat = 'real-one';
      await tool(ctx, chat, 'desktop_request_access', { apps: ['Finder', 'Terminal'], reason: 'the real-guest run' });
      expect(
        asks.some((a) => a.machine === 'the guest'),
        `The access card did not name the machine: ${JSON.stringify(asks)}.`,
      );
      const shot = await tool(ctx, chat, 'desktop_screenshot', {});
      const image = (Array.isArray(shot) ? shot : [shot]).find((p) => p?.type === 'image');
      expect(image?.data && String(image.data).length > 2000, `The screenshot was ${JSON.stringify(shot).slice(0, 200)}.`);
      expect(ctx.state.macStarts === 0, `This Mac's helper was started ${ctx.state.macStarts} time(s).`);
      return `screenshot ${image.mimeType ?? '?'} ${Math.round(String(image.data).length / 1000)} kB base64; card named the machine; this Mac's helper starts: 0`;
    },
  },
  {
    id: 'C4',
    title: 'A mouse move through the app lands on the guest’s desktop, read back from the guest itself',
    async run(ctx) {
      const chat = 'real-one';
      const before = await guestMouse(ctx);
      const target = [Math.min(before[0] + 137, 600), Math.min(before[1] + 71, 400)];
      if (target[0] === before[0] && target[1] === before[1]) target[0] += 23;
      await tool(ctx, chat, 'desktop_mouse_move', { coordinate: target });
      await new Promise((r) => setTimeout(r, 1500));
      const after = await guestMouse(ctx);
      const cursor = await tool(ctx, chat, 'desktop_cursor_position', {});
      expect(
        after[0] !== before[0] || after[1] !== before[1],
        `The guest's mouse did not move: ${before} -> ${after}; the helper says ${JSON.stringify(cursor).slice(0, 200)}.`,
      );
      ctx.state.mouse = { before, after, asked: target, helper: JSON.stringify(cursor).slice(0, 160) };
      expect(ctx.state.macStarts === 0, 'This Mac’s helper was started.');
      return `guest mouse ${before} -> ${after} (asked ${target} in screenshot space; the helper says ${ctx.state.mouse.helper})`;
    },
  },
  {
    id: 'C5',
    title: 'A chat that ends gives the Host’s desktop up at once: another chat leases immediately',
    async run(ctx) {
      await ctx.state.hd.forget('real-one');
      const t0 = Date.now();
      await tool(ctx, 'real-two', 'desktop_request_access', { apps: ['Finder'], reason: 'the second chat' });
      await tool(ctx, 'real-two', 'desktop_screenshot', {});
      const ms = Date.now() - t0;
      expect(ms < 30_000, `The second chat waited ${ms} ms.`);
      await ctx.state.hd.forget('real-two');
      return `second chat took the desktop ${ms} ms after the first ended`;
    },
  },
  {
    id: 'C6',
    title: 'What was approved is listed under the machine, taken back by Remove, and goes with the machine',
    async run(ctx) {
      const { createHostApprovals } = require('../electron/capabilities/hostApprovals.cjs');
      const { hostsWithGrants, removeHostGrants } = require('../electron/capabilities/hostGrants.cjs');
      const grants = ctx.state.grantsFor(ctx.state.id);
      grants.grant('real-three', { bundleId: 'com.apple.finder', name: 'Finder' }, 'click', 'chat');
      const a = createHostApprovals({
        grantsFor: ctx.state.grantsFor,
        nameOf: () => 'the guest',
        knownHosts: () => hostsWithGrants(ctx.state.userData),
        forget: (/** @type {string} */ id) => {
          ctx.state.stores.delete(id);
          removeHostGrants(ctx.state.userData, id);
        },
      });
      const listed = a.settings();
      expect(
        listed.length === 1 && listed[0].name === 'the guest' && listed[0].chats[0]?.grants[0]?.bundleId === 'com.apple.finder',
        `Settings listed ${JSON.stringify(listed)}.`,
      );
      expect(
        a.revoke(ctx.state.id, 'real-three', 'com.apple.finder') === true && a.settings().length === 0,
        'Remove did not take the app back.',
      );
      grants.grant('real-three', { bundleId: 'com.apple.finder', name: 'Finder' }, 'click', 'chat');
      a.sweep(new Set());
      expect(!hostsWithGrants(ctx.state.userData).includes(ctx.state.id), 'The removed machine kept its approvals on disk.');
      return 'listed under the machine, Remove took it back, and a machine that left took its approvals with it';
    },
  },
];

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = { vm: '', helper: '', out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--vm') o.vm = argv[++i];
    else if (argv[i] === '--helper') o.helper = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else throw new Error(`Unknown option ${argv[i]}`);
  }
  if (!o.vm || !o.helper) throw new Error('Name the guest (--vm mopilot-*) and the helper app on it (--helper <path>).');
  return o;
}

async function main(argv) {
  const o = parseArgs(argv);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'g8-app-desktop-run-'));
  const dir = path.join(base, 'a-profile-folder-whose-path-is-long-enough-that-a-unix-socket-cannot-live-in-it-directly');
  fs.mkdirSync(dir, { recursive: true });
  const ctx = {
    m: createChannel({ launcher: vmLauncher(o.vm, path.join(ROOT, 'scripts/vm-exec.sh')) }),
    deps: realDeps({}),
    root: ROOT,
    outDir: dir,
    dir,
    target: o.vm,
    helper: o.helper,
    nonce: path.basename(base).slice(-6),
    state: /** @type {any} */ ({}),
  };
  const rows = await runSteps({ steps: STEPS, ctx, only: [] });
  ctx.state.restoreStart?.();
  await cleanup(ctx);
  const report = formatReport({ target: `${o.vm} (the app’s desktop stack)`, rows, notVerified: NOT_VERIFIED });
  process.stdout.write(`${report}\n`);
  if (o.out) fs.writeFileSync(o.out, report);
  fs.rmSync(base, { recursive: true, force: true });
  return exitCode(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`g8-app-desktop: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
