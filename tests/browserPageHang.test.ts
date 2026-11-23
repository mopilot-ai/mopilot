// Built-in browser pages that stop responding (pageHang.cjs): the check that finds a busy script, Electron's own
// events, and the commands that fail at once on a hung page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { PageHang, untilHung, SUSPECT_MS, PROBE_MS } = require('../electron/capabilities/browser/pageHang.cjs');

let ids = 900;
/** A page's webContents as pageHang.cjs uses it. */
function page(o: any = {}) {
  const wc: any = Object.assign(new EventEmitter(), { id: ids++, destroyed: false, url: 'https://task.test/form' }, o);
  wc.isDestroyed = () => wc.destroyed;
  wc.getURL = o.getURL ?? (() => wc.url);
  return wc;
}

test('hang: a page whose check does not run in time is hung; answering later makes it responsive again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release: () => void = () => {};
  const probes: any[] = [];
  const hang = new PageHang({
    probe: (wc: any) => {
      probes.push(wc.id);
      return new Promise<void>((r) => (release = r));
    },
  });
  const changes: any[] = [];
  hang.on('change', (wc: any, hung: boolean) => changes.push([wc.id, hung]));
  const wc = page();
  hang.suspect(wc);
  hang.suspect(wc); // one check at a time
  assert.equal(probes.length, 1);
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(wc), true);
  assert.deepEqual(changes, [[wc.id, true]]);
  hang.suspect(wc); // a hung page isn't checked again until its check answers
  assert.equal(probes.length, 1);
  release();
  await flush();
  assert.equal(hang.hung(wc), false);
  assert.deepEqual(changes.at(-1), [wc.id, false]);
  // a check that answers in time: nothing changes, and a later timer finds nothing to do
  hang.suspect(wc);
  release();
  await flush();
  t.mock.timers.tick(PROBE_MS);
  assert.equal(changes.length, 2);
  assert.equal(hang.hung(null), false);
});

test('hang: a check that fails, a page that goes, or a page waiting on its dialog never counts as hung', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blocked = false;
  const hang = new PageHang({
    blocked: () => blocked,
    probe: (wc: any) => {
      if (wc.throws) throw new Error('no frame');
      return wc.fails ? Promise.reject(new Error('navigated')) : new Promise(() => {});
    },
  });
  const changes: any[] = [];
  hang.on('change', (_wc: any, hung: boolean) => changes.push(hung));
  const throws = page({ throws: true });
  hang.suspect(throws);
  await flush();
  t.mock.timers.tick(PROBE_MS);
  const fails = page({ fails: true });
  hang.suspect(fails);
  await flush();
  t.mock.timers.tick(PROBE_MS);
  assert.deepEqual(changes, []);
  // gone before the check could answer
  const goes = page();
  hang.suspect(goes);
  goes.destroyed = true;
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(goes), false);
  hang.suspect(goes);
  hang.suspect(null);
  // a dialog opened under the check
  const waits = page();
  hang.suspect(waits);
  blocked = true;
  t.mock.timers.tick(PROBE_MS);
  hang.suspect(waits);
  assert.equal(hang.state.size, 0);
  // the renderer went while the check ran: nothing left to decide
  blocked = false;
  const killed = page();
  hang.suspect(killed);
  killed.emit('render-process-gone');
  t.mock.timers.tick(PROBE_MS);
  assert.deepEqual(changes, []);
});

test('hang: a check that fails on a hung page (CDP detached at the turn end) leaves it hung and checks it again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const probes: any[] = [];
  const hang = new PageHang({
    probe: () =>
      new Promise((resolve, reject) => {
        probes.push({ resolve, reject });
      }),
  });
  const wc = page();
  hang.suspect(wc);
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(wc), true);
  probes[0].reject(new Error('target closed while handling command'));
  await flush();
  assert.equal(hang.hung(wc), true, 'a failed check says nothing about the script');
  t.mock.timers.tick(PROBE_MS);
  assert.equal(probes.length, 2, 'checked again');
  probes[1].resolve();
  await flush();
  assert.equal(hang.hung(wc), false);
  // a page that responded or went meanwhile is not checked again
  hang.suspect(wc);
  t.mock.timers.tick(PROBE_MS);
  probes[2].reject(new Error('detached'));
  await flush();
  hang.emit('change', wc, false);
  hang.state.delete(wc.id);
  t.mock.timers.tick(PROBE_MS);
  const gone = page();
  hang.suspect(gone);
  t.mock.timers.tick(PROBE_MS);
  probes[3].reject(new Error('detached'));
  await flush();
  gone.destroyed = true;
  t.mock.timers.tick(PROBE_MS);
  assert.equal(probes.length, 4);
});

test('hang: a page still waiting on its server is not hung, though a CDP check queues behind its navigation', async (t) => {
  // measured on a page whose server answered after 12 s: Runtime.evaluate over CDP answered only once the pending
  // Page.navigate committed, so every page slower than SUSPECT_MS + PROBE_MS was reported as a busy script
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let waiting = true;
  let answer: () => void = () => {};
  const hang = new PageHang({ probe: () => new Promise<void>((r) => (answer = r)) });
  const changes: any[] = [];
  hang.on('change', (_wc: any, hung: boolean) => changes.push(hung));
  const slow = page({ isWaitingForResponse: () => waiting });
  const error = () => new Error('not responding');
  let failed = false;
  untilHung(hang, slow, () => new Promise(() => {}), error).catch(() => (failed = true));
  t.mock.timers.tick(SUSPECT_MS);
  t.mock.timers.tick(PROBE_MS * 3);
  await flush();
  assert.equal(hang.hung(slow), false);
  // the response is in: the page gets a full PROBE_MS to commit, and the queued check answers when it does
  waiting = false;
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(slow), false, 'still committing');
  answer();
  await flush();
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(slow), false);
  assert.equal(failed, false, 'the navigation keeps waiting for its page');
  assert.deepEqual(changes, []);
  assert.equal(hang.state.size, 0);
});

test('hang: a renderer busy when its slow page finally arrives is still found hung', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let waiting = true;
  const hang = new PageHang({ probe: () => new Promise(() => {}) });
  const busy = page({ isWaitingForResponse: () => waiting });
  hang.suspect(busy);
  t.mock.timers.tick(PROBE_MS * 2);
  waiting = false;
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(busy), false, 'a full PROBE_MS after the response first');
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.hung(busy), true);
  // a page that went while it waited is let go
  const gone = page({ isWaitingForResponse: () => true });
  hang.suspect(gone);
  t.mock.timers.tick(PROBE_MS);
  gone.destroyed = true;
  t.mock.timers.tick(PROBE_MS);
  assert.equal(hang.state.has(gone.id), false);
});

test("hang: Electron's own unresponsive and responsive events count too, except while the page waits on its dialog", () => {
  let blocked = true;
  const hang = new PageHang({ blocked: () => blocked });
  const wc = page();
  hang.watch(wc);
  hang.watch(wc);
  hang.watch(null);
  wc.emit('unresponsive');
  assert.equal(hang.hung(wc), false);
  blocked = false;
  wc.emit('unresponsive');
  assert.equal(hang.hung(wc), true);
  wc.emit('responsive');
  assert.equal(hang.hung(wc), false);
  wc.emit('unresponsive');
  wc.emit('render-process-gone');
  assert.equal(hang.hung(wc), false);
  wc.emit('unresponsive');
  wc.emit('destroyed');
  assert.equal(hang.state.size, 0);
  assert.equal(wc.listenerCount('unresponsive'), 1, 'watched once');
});

test('hang: the default check runs over CDP while an agent holds the page, else in its main frame', async () => {
  const calls: any[] = [];
  const hang = new PageHang();
  const attached = page({
    debugger: { isAttached: () => true, sendCommand: async (...a: any[]) => calls.push(['cdp', ...a]) },
  });
  const free = page({
    debugger: { isAttached: () => false },
    mainFrame: { executeJavaScript: async (s: string) => calls.push(['frame', s]) },
  });
  const bare = page({ mainFrame: { executeJavaScript: async (s: string) => calls.push(['bare', s]) } });
  hang.suspect(attached);
  hang.suspect(free);
  hang.suspect(bare);
  await flush();
  assert.deepEqual(calls, [
    ['cdp', 'Runtime.evaluate', { expression: '0', returnByValue: true }],
    ['frame', '0'],
    ['bare', '0'],
  ]);
});

test('hang: a command to a hung page fails at once, and one waiting fails as soon as its page is found hung', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = new PageHang({ probe: () => new Promise(() => {}) });
  const wc = page();
  const error = () => new Error('not responding');
  assert.equal(await untilHung(null, wc, async () => 'sent', error), 'sent');
  assert.equal(await untilHung(hang, wc, async () => 'ok', error), 'ok');
  await assert.rejects(
    untilHung(
      hang,
      wc,
      () => {
        throw new Error('detached');
      },
      error,
    ),
    /detached/,
  );
  await assert.rejects(
    untilHung(hang, wc, async () => Promise.reject(new Error('cdp failed')), error),
    /cdp failed/,
  );
  // a command that waits: the page is checked after SUSPECT_MS and found hung after PROBE_MS
  const waiting = untilHung(hang, wc, () => new Promise(() => {}), error);
  t.mock.timers.tick(SUSPECT_MS);
  t.mock.timers.tick(PROBE_MS);
  await assert.rejects(waiting, /not responding/);
  await assert.rejects(
    untilHung(hang, wc, async () => 'never sent', error),
    /not responding/,
  );
  // another page going hung doesn't touch this one's command
  const other = page();
  const mine = untilHung(hang, other, () => new Promise((r) => setTimeout(() => r('done'), 10)), error);
  hang.emit('change', page(), true);
  hang.emit('change', other, false);
  t.mock.timers.tick(10);
  assert.equal(await mine, 'done');
  assert.equal(hang.listenerCount('change'), 0, 'every command stops listening once it settles');
});

test("hang: a backend's wrapped page is its webContents: a slow load, its dialog and a hang the pane saw (#2786)", async (t) => {
  // the host's tabs send through tab.backend since #2778: a LocalTabContents, which carries no isWaitingForResponse or
  // mainFrame, so an 8 s page read as a busy script and failed the navigation (cuj-browser-interruptions)
  const { LocalTabContents } = require('../electron/capabilities/browser/localBackend.cjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let waiting = true;
  const slow = page({ isWaitingForResponse: () => waiting });
  const hang = new PageHang({ probe: () => new Promise(() => {}) });
  let failed = false;
  untilHung(
    hang,
    new LocalTabContents(slow),
    () => new Promise(() => {}),
    () => new Error('not responding'),
  ).catch(() => (failed = true));
  t.mock.timers.tick(SUSPECT_MS);
  t.mock.timers.tick(PROBE_MS * 3);
  await flush();
  assert.equal(hang.hung(slow), false, 'still waiting on its server');
  assert.equal(failed, false);
  waiting = false;

  // its own dialog is looked up by the webContents the dialog layer keeps
  const held = page();
  const blocked = new PageHang({ blocked: (wc: any) => wc === held, probe: () => new Promise(() => {}) });
  blocked.suspect(new LocalTabContents(held));
  t.mock.timers.tick(PROBE_MS);
  assert.equal(blocked.hung(held), false);

  // a hang Electron reported on the webContents fails the command waiting on the wrapper
  const busy = page();
  const seen = new PageHang({ probe: () => new Promise(() => {}) });
  seen.watch(busy);
  const wrapped = new LocalTabContents(busy);
  const sent = untilHung(
    seen,
    wrapped,
    () => new Promise(() => {}),
    () => new Error('not responding'),
  );
  busy.emit('unresponsive');
  await assert.rejects(sent, /not responding/);
  assert.equal(seen.hung(wrapped), true);
  const changed: any[] = [];
  seen.on('change', (wc: any) => changed.push(wc));
  busy.emit('responsive');
  assert.deepEqual(changed, [busy], 'the pane hears of the webContents');

  // the default check runs in the page's main frame, which only the webContents has
  const script: string[] = [];
  const frame = page({ mainFrame: { executeJavaScript: (s: string) => (script.push(s), new Promise(() => {})) } });
  const checks = new PageHang();
  checks.suspect(new LocalTabContents(frame));
  t.mock.timers.tick(PROBE_MS);
  assert.deepEqual(script, ['0']);
  assert.equal(checks.hung(frame), true);
});
