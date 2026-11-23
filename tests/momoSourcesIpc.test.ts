// IPC for Settings › MoMo › Sources (#2139 P2, electron/momo/sources/ipc.cjs): every channel refuses while MoMo is not allowed; list, detail, connect (macOS first), disconnect, level, folders and the privacy pane answer `{ ok }` or `{ ok: false, error, reason }`; changes reach the windows as momoSources:changed only while allowed; unregistering removes it all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hubFixture, scratch, marked } from './support/momo-sources.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { createMomoSources } = require('../electron/momo/sources/index.cjs');
const { registerSourcesIpc, CHANNELS, NOT_ALLOWED, PRIVACY_PANES } = require('../electron/momo/sources/ipc.cjs');
const { CHANNELS: CONNECTOR_CHANNELS } = require('../electron/momo/connectors/ipc.cjs');
const { CHANNELS: MCP_CHANNELS } = require('../electron/momo/mcp/ipc.cjs');
const { SourceError, SOURCE_IDS, LEVELS } = require('../electron/momo/sources/hub.cjs');
const { MOMO_SOURCE_IDS, MOMO_SOURCE_LEVELS } = await import('../src/lib/native/contracts/momoSources.ts');

function setup(
  o: {
    openExternal?: any;
    grant?: string;
    asked?: boolean;
    picked?: () => Promise<string | null>;
    watch?: any;
    busy?: boolean;
    /** what the helper says of the request itself, and whether tccutil can clear its record */
    requestError?: string;
    canReset?: boolean;
  } = {},
) {
  const f = hubFixture();
  const home = scratch('momo-home-');
  fs.mkdirSync(path.join(home, 'Work'));
  const live = { status: o.grant ?? 'granted' };
  const order: string[] = [];
  const helper = {
    call: async (m: string, p: any) => {
      if (m === 'eventkit.request')
        return {
          calendar: o.grant ?? 'granted',
          reminders: o.grant ?? 'granted',
          asked: o.asked ?? false,
          ...(o.requestError && { requestError: o.requestError }),
        };
      // a running helper keeps its first answer: only a helper launched for the read sees the grant turned on later
      if (m === 'eventkit.status') return { calendar: 'denied', reminders: 'denied' };
      if (m === 'calendar.calendars') return { items: [{ id: 'c', title: 'Work', account: '' }] };
      throw Object.assign(new Error(`no ${m} ${JSON.stringify(p)}`), { reason: 'not_granted' });
    },
    offlineStatus: async (kind: string) => (order.push(`offline:${kind}`), { calendar: live.status, reminders: live.status }),
    // quits the helper while System Settings is open on the list; a busy one is left running
    release: () => (order.push('release'), o.busy ? 'busy' : 'stopped'),
    ...(o.canReset && { resetGrant: async (entity: string) => (order.push(`reset:${entity}`), true) }),
  };
  const flags = { allowed: true, picked: path.join(home, 'Work') as string | null };
  const sources = createMomoSources({
    dir: f.dir,
    safeStorage: f.safe,
    allowed: () => flags.allowed,
    decide: f.hub.decide,
    audit: f.hub.audit,
    helper,
    home,
  });
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (c: string, fn: Function) => handlers.set(c, fn), removeHandler: (c: string) => handlers.delete(c) };
  const senders: any[] = [];
  const sent: string[] = [];
  const opened: string[] = [];
  const undone: string[] = [];
  const writer = {
    written: () => [{ id: 'w1', kind: 'event', title: 'Dentist', at: 1 }],
    undoByUser: async (id: string) => {
      if (id === 'gone') throw new SourceError('It was changed or removed since, so it was left alone.', 'refused');
      undone.push(id);
    },
  };
  const off = registerSourcesIpc(ipcMain, {
    sources,
    writer,
    allowed: () => flags.allowed,
    pickFolder: o.picked ?? (async (e: any) => (senders.push(e), flags.picked)),
    broadcast: (c: string) => sent.push(c),
    openExternal: o.openExternal === undefined ? async (u: string) => void (order.push('open'), opened.push(u)) : o.openExternal,
    watchOptions: o.watch ?? { intervalMs: 0, sleep: () => new Promise((r) => setTimeout(r, 5)), timeoutMs: 50 },
  });
  const event = { sender: { id: 7 } };
  const call = (c: string, ...args: any[]) => (handlers.get(c) as Function)(event, ...args);
  return { ...f, sources, handlers, flags, sent, opened, off, call, home, senders, event, live, order, undone };
}

test('every channel refuses while MoMo is not allowed, and no change is broadcast', async () => {
  const s = setup();
  // the cloud accounts' and coding tools' rows on the same page register with these
  assert.deepEqual([...s.handlers.keys()], [...CONNECTOR_CHANNELS, ...MCP_CHANNELS, ...CHANNELS]);
  s.sources.hub.connect('calendar');
  fs.writeFileSync(path.join(s.sources.hub.copyDir('calendar'), 'copy.json'), '{}');
  s.sent.length = 0;
  s.flags.allowed = false;
  for (const c of CHANNELS) assert.deepEqual(await s.call(c, 'calendar'), NOT_ALLOWED);
  assert.deepEqual(s.senders, [], 'no dialog opened');
  // removing is refused too: an account without MoMo gets the one refusal everywhere, and nothing was removed
  assert.equal(fs.existsSync(path.join(s.dir, 'sources', 'calendar')), true);
  s.flags.allowed = true;
  assert.notEqual(s.sources.hub.get('calendar'), null);
  s.flags.allowed = false;
  assert.deepEqual(s.sent, []);
  s.flags.allowed = true;
  s.sources.hub.connect('files');
  s.flags.allowed = false;
  s.sent.length = 0;
  s.off();
  assert.equal(s.handlers.size, 0);
  s.sources.hub.disconnect('files');
  assert.deepEqual(s.sent, []);
});

test('list, connect, detail, level and disconnect, each change broadcast', async () => {
  const s = setup();
  const listed = await s.call('momoSources:list');
  assert.equal(listed.ok, true);
  assert.equal(listed.available, true);
  assert.deepEqual(
    listed.sources.map((x: any) => x.id),
    ['calendar', 'reminders', 'files'],
  );
  assert.deepEqual(await s.call('momoSources:detail', 'calendar'), { ok: true, items: [] }, 'not connected: macOS is not asked');
  assert.deepEqual(await s.call('momoSources:connect', 'calendar'), { ok: true, connected: true, grant: 'granted' });
  assert.deepEqual(await s.call('momoSources:detail', 'calendar'), { ok: true, items: ['Work'] });
  assert.deepEqual(await s.call('momoSources:setLevel', 'calendar', 'blocked'), { ok: true });
  assert.equal(s.sources.hub.get('calendar').level, 'blocked');
  assert.deepEqual(await s.call('momoSources:setLevel', 'calendar', 'all'), {
    ok: false,
    error: 'Access level must be one of blocked, read, ask',
    reason: 'bad_args',
  });
  assert.deepEqual(await s.call('momoSources:disconnect', 'calendar'), { ok: true });
  assert.equal(s.sources.hub.get('calendar'), null);
  assert.deepEqual(s.sent, ['momoSources:changed', 'momoSources:changed', 'momoSources:changed']);
});

test('macOS refusing access answers connected: false; a failing detail says why', async () => {
  const s = setup({ grant: 'denied' });
  assert.deepEqual(await s.call('momoSources:connect', 'reminders'), { ok: true, connected: false, grant: 'denied', waiting: true });
  s.sources.hub.connect('reminders');
  const d = await s.call('momoSources:detail', 'reminders');
  assert.deepEqual([d.ok, d.reason], [false, 'not_granted']);
});

test("folders come from main's dialog over the sending window, never from the renderer; a refused one says why", async () => {
  const s = setup();
  assert.equal((await s.call('momoSources:addFolder')).reason, 'not_connected');
  await s.call('momoSources:connect', 'files');
  // a path the renderer passes is ignored: the dialog's pick is what's added
  assert.deepEqual(await s.call('momoSources:addFolder', '/etc'), { ok: true, cancelled: false, folders: ['~/Work'] });
  assert.equal(s.senders.at(-1), s.event, 'the dialog opens over the window that asked');
  assert.deepEqual(await s.call('momoSources:detail', 'files'), { ok: true, items: ['~/Work'] });
  s.flags.picked = null;
  assert.deepEqual(await s.call('momoSources:addFolder'), { ok: true, cancelled: true, folders: ['~/Work'] });
  s.flags.picked = s.home;
  const home = await s.call('momoSources:addFolder');
  assert.deepEqual([home.ok, home.reason], [false, 'outside']);
  const stranger = setup({
    picked: async () => {
      throw new Error('Choose a folder from a MoPilot window');
    },
  });
  await stranger.call('momoSources:connect', 'files');
  assert.deepEqual(await stranger.call('momoSources:addFolder'), { ok: false, error: 'Choose a folder from a MoPilot window' });
  assert.deepEqual(await s.call('momoSources:removeFolder', '~/Work'), { ok: true, folders: [] });
  for (const bad of ['mail', 7, undefined]) assert.equal((await s.call('momoSources:connect', bad)).reason, 'unknown');
});

test('the privacy pane opens only for Calendar and Reminders, and only with a shell', async () => {
  const s = setup();
  assert.deepEqual(await s.call('momoSources:openPrivacy', 'calendar'), { ok: true });
  assert.deepEqual(await s.call('momoSources:openPrivacy', 'reminders'), { ok: true });
  assert.deepEqual(s.opened, [PRIVACY_PANES.calendar, PRIVACY_PANES.reminders]);
  assert.equal((await s.call('momoSources:openPrivacy', 'files')).reason, 'unavailable');
  const bare = setup({ openExternal: null });
  assert.equal((await bare.call('momoSources:openPrivacy', 'calendar')).reason, 'unavailable');
});

test('a failure that is not a source error has no reason', async () => {
  const s = setup();
  s.sources.byId.files.connect = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await s.call('momoSources:connect', 'files'), { ok: false, error: 'boom' });
});

test('without broadcast or a shell the handlers still work', async () => {
  const f = hubFixture();
  const sources = createMomoSources({
    dir: f.dir,
    safeStorage: f.safe,
    allowed: () => true,
    decide: null,
    audit: null,
    helper: null,
    home: f.dir,
  });
  const handlers = new Map<string, Function>();
  const off = registerSourcesIpc(
    { handle: (c: string, fn: Function) => handlers.set(c, fn), removeHandler: (c: string) => handlers.delete(c) },
    { sources, writer: {} as any, allowed: () => true, pickFolder: async () => null },
  );
  assert.deepEqual(await (handlers.get('momoSources:connect') as Function)({}, 'files'), { ok: true, connected: true, grant: 'granted' });
  const cal = await (handlers.get('momoSources:connect') as Function)({}, 'calendar');
  assert.deepEqual([cal.ok, cal.reason], [false, 'unavailable']);
  off();
});

test("the Memory tab's list of what MoMo wrote and the user's own Undo go through main's writer, and say why one failed", async () => {
  const s = setup();
  assert.deepEqual(await s.call('momoSources:writes'), { ok: true, writes: [{ id: 'w1', kind: 'event', title: 'Dentist', at: 1 }] });
  assert.deepEqual(await s.call('momoSources:undoWrite', 'w1'), { ok: true });
  assert.deepEqual(s.undone, ['w1']);
  assert.deepEqual(await s.call('momoSources:undoWrite', 'gone'), {
    ok: false,
    error: 'It was changed or removed since, so it was left alone.',
    reason: 'refused',
  });
  s.off();
});

test('a change to what MoMo wrote is broadcast to the Memory tab while MoMo is allowed, and not after the handlers are removed', async () => {
  const s = setup();
  s.sent.length = 0;
  s.sources.writeLedger.emit('changed');
  assert.deepEqual(s.sent, ['momoMemory:changed']);
  s.flags.allowed = false;
  s.sources.writeLedger.emit('changed');
  assert.deepEqual(s.sent, ['momoMemory:changed']);
  s.flags.allowed = true;
  s.off();
  s.sources.writeLedger.emit('changed');
  assert.deepEqual(s.sent, ['momoMemory:changed']);
});

test("the renderer's sources and levels are main's, in the same order", () => {
  assert.deepEqual([...MOMO_SOURCE_IDS], SOURCE_IDS);
  assert.deepEqual(
    MOMO_SOURCE_LEVELS.map((l) => l.value),
    LEVELS,
  );
  assert.deepEqual(
    MOMO_SOURCE_LEVELS.map((l) => l.label),
    ['Blocked', 'Read only', 'Read & ask to change'],
  );
});

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test('a refusal macOS repeats opens the exact pane, waits, and connects by itself when the switch goes on', async () => {
  const s = setup({ grant: 'denied', watch: { intervalMs: 0, sleep: () => new Promise((r) => setTimeout(r, 1)), timeoutMs: 60_000 } });
  assert.deepEqual(await s.call('momoSources:connect', 'calendar'), { ok: true, connected: false, grant: 'denied', waiting: true });
  assert.deepEqual(s.opened, [PRIVACY_PANES.calendar]);
  assert.deepEqual((await s.call('momoSources:list')).waiting, ['calendar']);
  assert.equal(s.sources.hub.get('calendar'), null);
  s.live.status = 'granted';
  await waitFor(() => s.sources.hub.get('calendar'), 'calendar to connect');
  assert.equal(s.sources.hub.get('calendar').level, 'read');
  await settle();
  assert.deepEqual((await s.call('momoSources:list')).waiting, []);
  assert.ok(s.sent.length >= 2);
});

test('writeOnly also opens the pane; a refusal the user just gave at the prompt, a restriction or no shell does not', async () => {
  const w = setup({ grant: 'writeOnly' });
  assert.equal((await w.call('momoSources:connect', 'reminders')).waiting, true);
  assert.deepEqual(w.opened, [PRIVACY_PANES.reminders]);
  w.off();
  for (const o of [{ grant: 'denied', asked: true }, { grant: 'restricted' }, { grant: 'denied', openExternal: null }] as any[]) {
    const s = setup(o);
    const r = await s.call('momoSources:connect', 'calendar');
    assert.equal(r.waiting, undefined);
    assert.deepEqual(s.opened, []);
    assert.deepEqual((await s.call('momoSources:list')).waiting, []);
  }
});

test('cancelling stops the wait; Connect again replaces it; a disconnect voids the connect it was waiting for; unregistering stops it', async () => {
  const s = setup({ grant: 'denied', watch: { intervalMs: 0, sleep: () => new Promise((r) => setTimeout(r, 1)), timeoutMs: 60_000 } });
  await s.call('momoSources:connect', 'calendar');
  await s.call('momoSources:connect', 'calendar');
  assert.deepEqual(s.opened, [PRIVACY_PANES.calendar, PRIVACY_PANES.calendar]);
  assert.deepEqual(await s.call('momoSources:cancelConnect', 'calendar'), { ok: true, cancelled: true });
  assert.deepEqual(await s.call('momoSources:cancelConnect', 'calendar'), { ok: true, cancelled: false });
  assert.equal((await s.call('momoSources:cancelConnect', 'mail')).reason, 'unknown');
  s.live.status = 'granted';
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.sources.hub.get('calendar'), null, 'cancelled: the grant connects nothing');
  s.live.status = 'denied';
  await s.call('momoSources:connect', 'reminders');
  s.sources.hub.disconnect('reminders');
  s.live.status = 'granted';
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.sources.hub.get('reminders'), null, 'the epoch moved on: the late grant is void');
  s.live.status = 'denied';
  await s.call('momoSources:connect', 'calendar');
  s.off();
  s.live.status = 'granted';
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.sources.hub.get('calendar'), null);
});

test('the wait ends by itself after its timeout', async () => {
  let t = 0;
  const s = setup({ grant: 'denied', watch: { intervalMs: 0, sleep: async () => void (t += 100), now: () => t, timeoutMs: 500 } });
  await s.call('momoSources:connect', 'calendar');
  await settle();
  assert.deepEqual((await s.call('momoSources:list')).waiting, []);
  assert.equal(s.sources.hub.get('calendar'), null);
});

test('the helper is quit before the pane opens; one that is working is not cut off: the row says so and no pane opens or wait starts', async () => {
  const s = setup({ grant: 'denied', watch: { intervalMs: 0, sleep: () => new Promise((r) => setTimeout(r, 1)), timeoutMs: 60_000 } });
  const r = await s.call('momoSources:connect', 'calendar');
  assert.equal(r.waiting, true);
  assert.deepEqual(s.order.slice(0, 2), ['release', 'open'], 'quit first, then the pane');
  await s.call('momoSources:cancelConnect', 'calendar');
  s.live.status = 'granted';
  const busy = setup({ grant: 'denied', busy: true });
  const b = await busy.call('momoSources:connect', 'reminders');
  assert.deepEqual([b.ok, b.reason, b.error], [false, 'busy', 'Computer use is working. Try again when it is done.']);
  assert.deepEqual(busy.opened, []);
  assert.deepEqual((await busy.call('momoSources:list')).waiting, []);
  assert.ok(busy.order.includes('release') && !busy.order.includes('open'));
});

test('Open Settings works whatever macOS last answered: it quits an idle helper, opens the pane and waits for the switch; a busy helper refuses first', async () => {
  // macOS never showed its prompt (not determined): a connect would not open the pane, the button still must
  const s = setup({ grant: 'notDetermined', asked: true });
  assert.deepEqual(await s.call('momoSources:openPrivacy', 'calendar'), { ok: true });
  assert.deepEqual(s.order.slice(0, 2), ['release', 'open'], 'quit first, then the pane');
  assert.deepEqual((await s.call('momoSources:list')).waiting, ['calendar'], 'the row connects by itself when the switch goes on');
  s.live.status = 'granted';
  await waitFor(() => s.sources.hub.get('calendar') !== null, 'calendar to connect');
  assert.ok(s.sources.hub.get('calendar'), 'connected by the watch');
  s.off();
  const busy = setup({ grant: 'notDetermined', busy: true });
  const b = await busy.call('momoSources:openPrivacy', 'calendar');
  assert.deepEqual([b.ok, b.reason, b.error], [false, 'busy', 'Computer use is working. Try again when it is done.']);
  assert.deepEqual(busy.opened, []);
  assert.deepEqual((await busy.call('momoSources:list')).waiting, []);
  busy.off();
});

test('recheck reads the grant now: it connects once the switch is on and stops the wait; otherwise it changes nothing', async () => {
  const s = setup({ grant: 'denied' });
  // the switch is still off: the read says so and nothing connects
  s.live.status = 'denied';
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: false });
  assert.equal(s.sources.hub.get('calendar'), null);
  // a wait is running (the pane was opened), then the switch goes on and the window comes back to the front
  await s.call('momoSources:openPrivacy', 'calendar');
  assert.deepEqual((await s.call('momoSources:list')).waiting, ['calendar']);
  s.live.status = 'granted';
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: true });
  assert.ok(s.sources.hub.get('calendar'));
  assert.deepEqual((await s.call('momoSources:list')).waiting, [], 'the wait is over');
  // already connected: not connected again (its connect day stays), and the helper is not asked
  const day = s.sources.hub.get('calendar').connectedAt;
  s.order.length = 0;
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: true });
  assert.equal(s.sources.hub.get('calendar').connectedAt, day);
  assert.deepEqual(s.order, []);
  // Files have no macOS switch; an unknown source is refused; a helper that cannot read says why
  assert.deepEqual(await s.call('momoSources:recheck', 'files'), { ok: true, connected: false });
  assert.equal((await s.call('momoSources:recheck', 'mail')).reason, 'unknown');
  s.sources.eventKit.status = async () => {
    throw new Error('helper gone');
  };
  const failed = await s.call('momoSources:recheck', 'reminders');
  assert.deepEqual([failed.ok, failed.error], [false, 'helper gone']);
  s.off();
});

test('a grant turned on while the helper ran quits that helper before connecting (it keeps its first answer), on the recheck and on the wait; a working helper is left to finish', async () => {
  // the window came back after the switch went on, with no wait running: the helper that has been up since the prompt still says
  // denied, so it is quit and the next read launches a fresh one
  const s = setup({ grant: 'denied' });
  s.live.status = 'granted';
  s.order.length = 0;
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: true });
  assert.deepEqual(s.order, ['offline:eventkit', 'release']);
  s.off();
  // the pane was opened (the helper quit once, then a read may have started another that cached "off"), the switch goes on: quit again
  const w = setup({ grant: 'notDetermined', asked: true });
  await w.call('momoSources:openPrivacy', 'calendar');
  w.order.length = 0;
  w.live.status = 'granted';
  await waitFor(() => w.sources.hub.get('calendar') !== null, 'calendar to connect');
  assert.ok(w.sources.hub.get('calendar'), 'connected by the watch');
  assert.equal(w.order.at(-1), 'release', 'the helper is quit as the connect finishes');
  w.off();
  // a helper that is working (computer use) is not cut off: the source still connects, and the next read after it ends is a fresh one
  const busy = setup({ grant: 'denied', busy: true });
  busy.live.status = 'granted';
  assert.deepEqual(await busy.call('momoSources:recheck', 'reminders'), { ok: true, connected: true });
  assert.ok(busy.order.includes('release'));
  busy.off();
});

test('a connected source macOS refuses: the names Settings reads find it, the list says it needs the grant, and a name that works clears it', async () => {
  const s = setup();
  s.sources.hub.connect('reminders');
  s.sources.hub.connect('calendar');
  s.sent.length = 0;
  // Reminders' lists are refused by macOS (the test helper answers Calendar only)
  const d = await s.call('momoSources:detail', 'reminders');
  assert.deepEqual([d.ok, d.reason], [false, 'not_granted']);
  const listed = await s.call('momoSources:list');
  assert.deepEqual(
    listed.sources.map((x: any) => [x.id, x.connected, x.needsGrant]),
    [
      ['calendar', true, undefined],
      ['reminders', true, true],
      ['files', false, undefined],
    ],
  );
  assert.equal(s.sent.length, 1, 'the windows read the list again once');
  await s.call('momoSources:detail', 'reminders');
  assert.equal(s.sent.length, 1, 'the same refusal again tells nothing new');
  // a source that is granted stays unmarked, and a not-connected one shows no names and asks macOS nothing
  assert.deepEqual(await s.call('momoSources:detail', 'calendar'), { ok: true, items: ['Work'] });
  s.sources.hub.disconnect('calendar');
  s.sources.hub.markUngranted('reminders');
  s.sources.hub.markGranted('reminders');
  assert.equal(marked(s.sources.hub, 'reminders'), false);
  s.off();
});

test('recheck of a connected source macOS refuses reads the grant: still off changes nothing, switched on clears it and quits the stale helper', async () => {
  const s = setup();
  s.sources.hub.connect('calendar');
  s.sources.hub.markUngranted('calendar');
  s.live.status = 'denied';
  s.order.length = 0;
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: false });
  assert.equal(marked(s.sources.hub, 'calendar'), true);
  s.live.status = 'granted';
  s.order.length = 0;
  s.sent.length = 0;
  assert.deepEqual(await s.call('momoSources:recheck', 'calendar'), { ok: true, connected: true });
  assert.equal(marked(s.sources.hub, 'calendar'), false);
  assert.deepEqual(s.order, ['offline:eventkit', 'release'], 'a helper launched for the read saw it; the running one is quit');
  assert.ok(s.sent.length >= 1, 'the windows read the list again');
  s.off();
});

test('Connect on a connected source macOS refuses asks again; a refusal opens the pane and the switch turned on clears it by itself', async () => {
  const s = setup({ grant: 'denied', watch: { intervalMs: 0, sleep: () => new Promise((r) => setTimeout(r, 1)), timeoutMs: 60_000 } });
  s.sources.hub.connect('calendar');
  s.sources.hub.markUngranted('calendar');
  assert.deepEqual(await s.call('momoSources:connect', 'calendar'), { ok: true, connected: false, grant: 'denied', waiting: true });
  assert.deepEqual(s.opened, [PRIVACY_PANES.calendar]);
  assert.equal(marked(s.sources.hub, 'calendar'), true, 'still refused while the pane is open');
  s.live.status = 'granted';
  await waitFor(() => !marked(s.sources.hub, 'calendar'), 'calendar to be unmarked');
  assert.equal(marked(s.sources.hub, 'calendar'), false);
  assert.equal(s.sources.hub.get('calendar').level, 'read', 'its connect day and level stay');
  await settle();
  assert.deepEqual((await s.call('momoSources:list')).waiting, []);
  // macOS asks again (the grant was reset) and the user allows: connected, cleared
  const t = setup();
  t.sources.hub.connect('calendar');
  t.sources.hub.markUngranted('calendar');
  assert.deepEqual(await t.call('momoSources:connect', 'calendar'), { ok: true, connected: true, grant: 'granted' });
  assert.equal(marked(t.sources.hub, 'calendar'), false);
  s.off();
  t.off();
});

test('a connect macOS answers without its prompt is passed on as such, opens no pane and is recorded for the diagnostics (#2999)', async () => {
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  const s = setup({ grant: 'notDetermined', asked: true });
  const r = await s.call('momoSources:connect', 'calendar');
  assert.deepEqual([r.ok, r.connected, r.grant, r.noPrompt, r.waiting], [true, false, 'notDetermined', true, undefined]);
  assert.deepEqual(s.opened, [], 'the pane has no entry for an undecided source: not opened');
  assert.deepEqual((await s.call('momoSources:list')).waiting, []);
  assert.match(recentIgnored().at(-1).context, /macOS showed no calendar prompt \(the helper's grant record was not cleared\)/);
  assert.match(recentIgnored().at(-1).message, /returned without a prompt/);
  s.off();
  // with the helper's own words, and after the record was cleared
  clearIgnored();
  const t = setup({ grant: 'notDetermined', asked: true, requestError: 'EKErrorDomain 100: Access denied', canReset: true });
  const q = await t.call('momoSources:connect', 'reminders');
  assert.deepEqual([q.noPrompt, q.reset, q.requestError], [true, true, 'EKErrorDomain 100: Access denied']);
  assert.ok(t.order.includes('reset:reminders'), 'the helper’s record was cleared once and macOS asked again');
  assert.match(recentIgnored().at(-1).context, /the helper's grant record was cleared once/);
  assert.match(recentIgnored().at(-1).message, /EKErrorDomain 100: Access denied/);
  t.off();
});
