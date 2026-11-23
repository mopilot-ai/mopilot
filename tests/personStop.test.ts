// A person's Esc on the desktop (electron/capabilities/personStop.cjs): every chat at work stops, the windows learn it
// first, and MoPilot comes back on the chat once its screen is given back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { personStop } = require('../electron/capabilities/personStop.cjs');
const { rig: setupRig } = await import('./support/computer-use-setup-rig.ts');
const { NOTES, FINDER, rig: desktopRig, activates } = await import('./support/desktop-kit.ts');

function rig({ working = ['c1', 'bg1', 'bg2'], desktop = true, showChat = true, failStop = '' } = {}) {
  const log: string[] = [];
  const fronts: Array<[string, () => void]> = [];
  const stop = personStop({
    cu: {
      stop: async (c: string) => {
        log.push(`stop ${c}`);
        if (c === failStop) throw new Error('gone');
      },
    },
    apps: () => ({ workingChats: () => working }),
    desktop: () => (desktop ? { frontAfterStop: (c: string, show: () => void) => fronts.push([c, show]) } : null),
    broadcast: (channel: string, p: any) => log.push(`${channel} ${p.chatId} ${p.stoppedByYou}`),
    showChat: showChat ? (c: string) => log.push(`show ${c}`) : undefined,
  });
  return { stop, log, fronts };
}

test('Esc stops the holder and the chats working in apps in the background, telling the windows before the stops', async () => {
  const r = rig();
  await r.stop('c1');
  assert.deepEqual(r.log, [
    'computer:changed c1 true',
    'computer:changed bg1 true',
    'computer:changed bg2 true',
    'stop c1',
    'stop bg1',
    'stop bg2',
  ]);
  // MoPilot comes back on the stopped chat when the desktop gives the screen back
  assert.equal(r.fronts.length, 1);
  assert.equal(r.fronts[0][0], 'c1');
  r.fronts[0][1]();
  assert.equal(r.log.at(-1), 'show c1');
});

test('without the desktop tools it comes to the front at once; with no window to show, nothing; a failed stop is noted', async () => {
  const bare = rig({ working: [], desktop: false });
  await bare.stop('c1');
  assert.deepEqual(bare.log, ['computer:changed c1 true', 'show c1', 'stop c1']);
  const none = rig({ working: ['bg'], showChat: false, failStop: 'bg' });
  await none.stop('c1');
  assert.deepEqual(none.log, ['computer:changed c1 true', 'computer:changed bg true', 'stop c1', 'stop bg']);
  assert.equal(none.fronts.length, 0);
  const noApps = personStop({ cu: { stop: async () => {} }, apps: () => null, desktop: () => null, broadcast: () => {} });
  await noApps('c1');
});

// main's wiring (setupComputerUse)
test("a person's Esc (the shortcut, the pill, the helper's own) stops the chats at work and tells the windows; with no holder it is a pause", async () => {
  const shown: string[] = [];
  const r = setupRig({ codex: { showChat: (c: string) => shown.push(c) } });
  const { cu, helper, indicator } = r.runtime;
  const stops: string[] = [];
  cu.stop = async (c: string) => void stops.push(c);
  cu.controlling = 'c';
  helper.emit('paused', { reason: 'escape' });
  indicator.onEscape('d');
  await tick();
  assert.deepEqual(stops, ['c', 'd']);
  // nothing held the screen for them here: MoPilot comes back on each at once
  assert.deepEqual(shown, ['c', 'd']);
  assert.deepEqual(
    r.log.filter((e: any[]) => e[0] === 'broadcast' && e[2]?.stoppedByYou).map((e: any[]) => e[2].chatId),
    ['c', 'd'],
  );
  cu.controlling = null;
  const reasons: any[] = [];
  cu.paused = (why: any) => reasons.push(why);
  helper.emit('paused', { reason: 'escape' });
  assert.deepEqual(reasons, ['escape']);
});

// DesktopControl (desktopGate.cjs): the screen given back after the stop
test("a person's stop: MoPilot comes back focused on the chat, not the app that was in front; no hold shows it at once", async () => {
  const host = {
    shown: [] as boolean[],
    hide: () => true,
    show(f: boolean) {
      this.shown.push(f);
    },
  };
  const r = desktopRig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.hidden = [{ pid: 30, bundleId: 'x.y' }];
  r.helper.front = FINDER;
  r.helper.at = NOTES;
  activates(r);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  const shown: string[] = [];
  r.d.frontAfterStop('c1', () => shown.push('c1'));
  assert.equal(shown.length, 0, 'it waits for the screen to be given back');
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreApps').at(-1).args, [[30], null], 'the app in front before stays behind');
  assert.deepEqual(host.shown, [true]);
  assert.deepEqual([...shown], ['c1']);
  // an Esc whose stop took too long to end the turn brings nothing forward: the app in front before comes back
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  r.d.frontAfterStop('c1', () => shown.push('late'));
  r.d.screen.front.until = 0;
  await r.d.turnEnded('c1');
  assert.deepEqual([...shown], ['c1']);
  // no screen held for the chat: at once
  r.d.frontAfterStop('c2', () => shown.push('c2'));
  assert.deepEqual(shown, ['c1', 'c2']);
});
