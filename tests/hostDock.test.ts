// MoPilot's windows while a chat holds the screen (electron/capabilities/computerPresentation.cjs hostWindows, electron/capabilities/hostDock.cjs): the largest docks as an on-top corner panel showing the chat in control, kept out of screenshots; the others hide; all go back when control ends; a card brings the panel forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hostWindows } = require('../electron/capabilities/computerPresentation.cjs');
const { dock, undock, panelBounds, PANEL } = require('../electron/capabilities/hostDock.cjs');

function fake(o: { protectedApi?: boolean } = {}) {
  const events: string[] = [];
  const windows: any[] = [];
  class W {
    visible = false;
    destroyed = false;
    onTop = false;
    allSpaces = false;
    protectedNow = false;
    sent: any[] = [];
    bounds: any;
    constructor(width = 800, height = 600) {
      this.bounds = { x: 100, y: 100, width, height };
      windows.push(this);
    }
    static getAllWindows = () => windows;
    isVisible = () => this.visible;
    isDestroyed = () => this.destroyed;
    getBounds = () => this.bounds;
    setBounds = (b: any) => void (this.bounds = b);
    isAlwaysOnTop = () => this.onTop;
    setAlwaysOnTop = (on: boolean) => void (this.onTop = on);
    setVisibleOnAllWorkspaces = (on: boolean) => void (this.allSpaces = on);
    setContentProtection = (on: boolean) => void (this.protectedNow = on);
    isContentProtected = o.protectedApi === false ? undefined : () => this.protectedNow;
    webContents = { send: (...a: any[]) => this.sent.push(a) };
    show = () => ((this.visible = true), events.push('show'));
    showInactive = () => ((this.visible = true), events.push('showInactive'));
    hide = () => ((this.visible = false), events.push('hide'));
    focus = () => events.push('focus');
    min = [760, 500];
    getMinimumSize = () => this.min;
    setMinimumSize = (w: number, h: number) => void (this.min = [w, h]);
  }
  const area = { x: 0, y: 25, width: 1440, height: 875 };
  const electron = {
    BrowserWindow: W,
    screen: { getDisplayMatching: () => ({ workArea: area }) },
    app: { focus: (x: any) => events.push(`app:focus:${x.steal}`) },
  };
  return { electron, W, events, area };
}

test('the panel sits in the top-right corner of the work area, at most 520 x 720', () => {
  assert.deepEqual(panelBounds({ x: 0, y: 25, width: 1440, height: 875 }), { x: 908, y: 37, width: 520, height: 720 });
  // a small screen: the panel shrinks to fit inside the margins
  assert.deepEqual(panelBounds({ x: 1440, y: 0, width: 500, height: 600 }), { x: 1452, y: 12, width: 476, height: 576 });
  assert.equal(PANEL.width, 520);
});

test('hide: the largest window docks as the panel on the chat (not the overlay), the rest hide; show puts everything back', () => {
  const f = fake();
  const overlay = new f.W(1440, 900);
  overlay.visible = true;
  const settings = new f.W(600, 400); // before the largest and after it: the largest docks, whatever the order
  settings.visible = true;
  const main = new f.W(1200, 800);
  main.visible = true;
  const tiny = new f.W(300, 200);
  tiny.visible = true;
  new f.W(); // never shown
  const host = hostWindows(f.electron, () => [overlay]);
  assert.equal(host.hide('c1'), true);
  assert.deepEqual(main.bounds, { x: 908, y: 37, width: 520, height: 720 });
  assert.deepEqual([main.visible, main.onTop, main.allSpaces, main.protectedNow], [true, true, true, true]);
  assert.deepEqual(main.min, [496, 320], 'its minimum size lets it be panel-sized');
  assert.deepEqual(main.sent, [
    ['app:command', 'docked', true],
    ['app:command', 'open-chat', 'c1'],
  ]);
  assert.deepEqual([settings.visible, tiny.visible, overlay.visible], [false, false, true]);
  // again within the hold: nothing more docks or hides
  assert.equal(host.hide('c1'), true);
  assert.equal(main.sent.length, 2);
  // a card: the panel comes forward with the keyboard
  assert.equal(host.attend(), true);
  assert.deepEqual(f.events.slice(-2), ['show', 'focus']);
  host.show(true);
  assert.deepEqual(main.bounds, { x: 100, y: 100, width: 1200, height: 800 });
  assert.deepEqual([main.onTop, main.allSpaces, main.protectedNow], [false, false, false]);
  assert.deepEqual(main.min, [760, 500]);
  assert.deepEqual(main.sent.at(-1), ['app:command', 'docked', false], 'the page shows the whole app again');
  assert.equal(settings.visible, true);
  assert.equal(f.events.at(-1), 'app:focus:true');
  assert.equal(host.attend(), false, 'nothing docked');
});

test('hide with nothing on screen docks nothing; a docked window closed meanwhile is left alone; no focus without the app', () => {
  const f = fake({ protectedApi: false });
  const host = hostWindows(f.electron, () => []);
  assert.equal(host.hide(), false, 'nothing visible');
  const main = new f.W();
  main.visible = true;
  assert.equal(host.hide(), true);
  assert.deepEqual(main.sent, [['app:command', 'docked', true]], 'no chat to open');
  main.destroyed = true;
  assert.equal(host.attend(), false);
  host.show(false);
  assert.equal(main.onTop, true, 'a closed window is not touched');
  const noApp = hostWindows({ BrowserWindow: f.W }, () => []);
  main.destroyed = false;
  noApp.hide();
  noApp.show(true);
  assert.equal(
    hostWindows(null, () => []),
    null,
  );
  assert.equal(
    hostWindows({ BrowserWindow: {} }, () => []),
    null,
  );
});

test('dock and undock keep what the window had: its place, on-top state and content protection; a failing restore is noted', () => {
  const f = fake();
  const w = new f.W();
  (w as any).getMinimumSize = undefined;
  w.onTop = true;
  w.protectedNow = true;
  const saved = dock({ screen: {} }, w, null);
  assert.deepEqual(w.bounds, { x: 100, y: 100, width: 800, height: 600 }, 'no display known: it stays where it is');
  undock(saved);
  assert.deepEqual([w.onTop, w.protectedNow, w.allSpaces], [true, true, false]);
  const again = dock(f.electron, w, null);
  w.setBounds = () => {
    throw new Error('closing');
  };
  assert.doesNotThrow(() => undock(again));
});

test('a card while the screen is held brings the docked panel forward; with nothing docked the windows come back', async () => {
  const DK = await import('./support/desktop-kit.ts');
  for (const [attend, comesBack] of [
    [() => true, false],
    [() => false, true],
    [undefined, true],
  ] as const) {
    const shown: boolean[] = [];
    const attended: number[] = [];
    const host: any = { hide: () => true, show: (f: boolean) => shown.push(f) };
    if (attend) host.attend = () => (attended.push(1), attend());
    const r = DK.rig({ hide: true, host });
    await r.ready([DK.NOTES]);
    r.d.session('c1').consent = true;
    r.helper.at = DK.NOTES;
    await r.call('desktop_left_click', { coordinate: [10, 10] }); // takes the screen: the host docks
    await r.call('desktop_left_click', { element_index: 1 }); // a card that can't be undone asks the person
    assert.equal(attended.length, attend ? 1 : 0);
    assert.deepEqual(shown, comesBack ? [true] : [], comesBack ? 'the windows come back' : 'the panel stays docked');
  }
});
