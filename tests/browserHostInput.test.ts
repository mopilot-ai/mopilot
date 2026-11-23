// The browser host's input (electron/capabilities/browser/host.cjs): mouse, wheel, typing and keys, dialogs,
// file choosers and viewport resizing, all through CDP on the top frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PAGE_AGENT_SOURCE, drive, setup, tabOf, framedTab } from './support/browser-host-kit.ts';

const { recentIgnored, clearIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');

test('mouse input: click (buttons, counts, modifiers), hover, drag and wheel go through CDP on the top frame', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const mouse = () => tab.wc.debugger.sent('Input.dispatchMouseEvent').map((c) => c.params);
  assert.equal(await drive(t, h.tabs.click(tab, { x: 1, y: 2 })), 'done');
  assert.deepEqual(mouse(), [
    { type: 'mouseMoved', x: 1, y: 2, modifiers: 0 },
    { type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 },
    { type: 'mouseReleased', x: 1, y: 2, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 },
  ]);
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.click(tab, { x: 1, y: 2 }, { button: 'right', clickCount: 2, modifiers: 8 }));
  assert.deepEqual(
    mouse().map((p) => [p.type, p.button, p.buttons, p.clickCount, p.modifiers]),
    [
      ['mouseMoved', undefined, undefined, undefined, 8],
      ['mousePressed', 'right', 2, 1, 8],
      ['mouseReleased', 'right', 0, 1, 8],
      ['mousePressed', 'right', 2, 2, 8],
      ['mouseReleased', 'right', 0, 2, 8],
    ],
  );
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.click(tab, { x: 1, y: 2 }, { button: 'middle' }));
  assert.equal(mouse()[1].buttons, 4);
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.hover(tab, { x: 3, y: 4 }));
  assert.deepEqual(mouse(), [{ type: 'mouseMoved', x: 3, y: 4 }]);
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.drag(tab, { x: 0, y: 0 }, { x: 120, y: 60 }));
  const drag = mouse();
  assert.equal(drag.length, 15);
  assert.deepEqual(drag[1], { type: 'mousePressed', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1 });
  assert.deepEqual(drag[2], { type: 'mouseMoved', x: 10, y: 5, button: 'left', buttons: 1 });
  assert.deepEqual(drag[14], { type: 'mouseReleased', x: 120, y: 60, button: 'left', buttons: 0, clickCount: 1 });
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.scroll(tab, { x: 5, y: 5 }, 'down'));
  await drive(t, h.tabs.scroll(tab, { x: 5, y: 5 }, 'up', 99));
  await drive(t, h.tabs.scroll(tab, { x: 5, y: 5 }, 'left', 0));
  await drive(t, h.tabs.scroll(tab, { x: 5, y: 5 }, 'right', 2.4));
  assert.deepEqual(
    mouse().map((p) => [p.type, p.deltaX, p.deltaY]),
    [
      ['mouseWheel', 0, 300],
      ['mouseWheel', 0, -1000],
      ['mouseWheel', -100, 0],
      ['mouseWheel', 200, 0],
    ],
  );
  await assert.rejects(h.tabs.scroll(tab, { x: 5, y: 5 }, 'sideways'), { code: 'bad_args' });
});

test('input that opens a dialog or file chooser ends the wait with "dialog"; failures surface', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, tab.attach());
  tab.wc.handlers['Input.dispatchMouseEvent'] = (p: any) => {
    if (p.type === 'mousePressed') {
      tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?' });
      return new Promise(() => {});
    }
    return {};
  };
  assert.equal(await drive(t, h.tabs.click(tab, { x: 1, y: 1 })), 'dialog');
  assert.equal(tab.dialogWaiters.size, 0, 'the wait is dropped');
  // the input fails after the dialog won: no caller is left, so the failure is recorded
  clearIgnored();
  let late: (e: Error) => void = () => {};
  tab.dialog = null;
  tab.wc.handlers['Input.dispatchMouseEvent'] = (p: any) => {
    if (p.type === 'mousePressed') {
      tab.wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete?' });
      return new Promise((_resolve, reject) => (late = reject));
    }
    return {};
  };
  assert.equal(await drive(t, h.tabs.click(tab, { x: 1, y: 1 })), 'dialog');
  late(new Error('Target closed'));
  await drive(t, new Promise((r) => setTimeout(r, 0)));
  assert.deepEqual(
    recentIgnored().map((e: any) => [e.context, e.message]),
    [['finish an input action a dialog interrupted', 'Target closed']],
  );
  clearIgnored();
  tab.wc.handlers['Input.insertText'] = () => {
    throw new Error('Target closed');
  };
  await assert.rejects(drive(t, h.tabs.typeText(tab, 'x')), /Target closed/);
});

test('typing and keys: text is inserted; keys are pressed as chords, repeated within 1..100', async (t) => {
  const h = setup(t, { platform: 'darwin' });
  const tab = tabOf(h);
  await drive(t, h.tabs.typeText(tab, 42));
  assert.deepEqual(tab.wc.debugger.sent('Input.insertText')[0].params, { text: '42' });
  await drive(t, h.tabs.keys(tab, ' cmd+a  Backspace '));
  const keys = tab.wc.debugger.sent('Input.dispatchKeyEvent').map((c) => [c.params.type, c.params.key, c.params.commands]);
  assert.deepEqual(keys, [
    ['rawKeyDown', 'Meta', undefined],
    ['rawKeyDown', 'a', ['selectAll']],
    ['keyUp', 'a', undefined],
    ['keyUp', 'Meta', undefined],
    ['rawKeyDown', 'Backspace', undefined],
    ['keyUp', 'Backspace', undefined],
  ]);
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.keys(tab, 'Tab', 500));
  assert.equal(tab.wc.debugger.sent('Input.dispatchKeyEvent').length, 200);
  tab.wc.debugger.calls.length = 0;
  await drive(t, h.tabs.keys(tab, 'Tab', 0));
  assert.equal(tab.wc.debugger.sent('Input.dispatchKeyEvent').length, 2);
  await assert.rejects(h.tabs.keys(tab, '   '), { code: 'bad_args', message: 'Give the key(s) to press.' });
  await assert.rejects(h.tabs.keys(tab, 'ctrl+nope'), { code: 'bad_args' });
});

test('handleDialog: accept or dismiss (with prompt text); an already-closed dialog; cancel a file chooser; nothing open', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  tab.wc.ops.state = () => ({ quietMs: 1000 });
  tab.dialog = { type: 'prompt', message: 'Your name?' };
  assert.equal(await drive(t, h.tabs.handleDialog(tab, true, 7)), 'Accepted the prompt dialog "Your name?".');
  assert.deepEqual(tab.wc.debugger.sent('Page.handleJavaScriptDialog').at(-1)!.params, { accept: true, promptText: '7' });
  assert.equal(tab.dialog, null);
  tab.dialog = { type: 'confirm', message: 'Sure?' };
  assert.equal(await drive(t, h.tabs.handleDialog(tab, false)), 'Dismissed the confirm dialog "Sure?".');
  assert.deepEqual(tab.wc.debugger.sent('Page.handleJavaScriptDialog').at(-1)!.params, { accept: false });
  tab.wc.handlers['Page.handleJavaScriptDialog'] = () => {
    throw new Error('No dialog is showing');
  };
  tab.dialog = { type: 'confirm', message: 'Gone?' };
  assert.equal(await drive(t, h.tabs.handleDialog(tab, true)), 'The confirm dialog "Gone?" had already closed.');
  assert.equal(tab.dialog, null);
  tab.wc.handlers['Page.handleJavaScriptDialog'] = () => {
    throw new Error('Target closed');
  };
  tab.dialog = { type: 'confirm', message: '' };
  await assert.rejects(drive(t, h.tabs.handleDialog(tab, true)), /Target closed/);
  tab.wc.handlers['Page.handleJavaScriptDialog'] = () => {
    throw 'odd';
  };
  await assert.rejects(drive(t, h.tabs.handleDialog(tab, true)), (e: any) => e === 'odd');
  tab.dialog = null;
  tab.fileChooser = { mode: 'selectSingle' };
  await assert.rejects(h.tabs.handleDialog(tab, true), { code: 'bad_args', message: 'No dialog is open in tab_aaaaaa.' });
  assert.equal(await h.tabs.handleDialog(tab, false), 'Cancelled the file chooser.');
  assert.equal(tab.fileChooser, null);
  await assert.rejects(h.tabs.handleDialog(tab, false), { code: 'bad_args' });
});

test('setFiles: on a file input by ref (top frame or a frame) or on the open chooser; otherwise refused', async (t) => {
  const h = setup(t);
  const tab = framedTab(t, h);
  tab.noteRefs(['[ref_1]'], '');
  tab.noteRefs(['[ref_11]'], 'F1');
  tab.wc.ops.state = () => ({ quietMs: 1000 });
  tab.wc.handlers['Runtime.evaluate'] = (p: any, s?: string) => {
    if (p.expression === `${PAGE_AGENT_SOURCE}, true`) return { result: { value: true } };
    if (p.expression.startsWith('globalThis.__mopilotAgent.element('))
      return p.expression.includes('ref_404') ? { result: {} } : { result: { objectId: `obj:${s ?? 'top'}:${p.contextId}` } };
    return { result: { value: { value: { quietMs: 1000 }, seq: 0 } } };
  };
  await drive(t, h.tabs.setFiles(tab, 'ref_1', ['/u/a.txt']));
  await drive(t, h.tabs.setFiles(tab, 'ref_11', ['/u/b.txt']));
  const set = tab.wc.debugger.sent('DOM.setFileInputFiles');
  assert.deepEqual(
    set.map((c) => [c.params, c.sessionId]),
    [
      [{ files: ['/u/a.txt'], objectId: 'obj:top:1' }, undefined],
      [{ files: ['/u/b.txt'], objectId: 'obj:F1:2' }, 'F1'],
    ],
  );
  const evalCall = tab.wc.debugger
    .sent('Runtime.evaluate')
    .find((c) => c.params.expression.startsWith('globalThis.__mopilotAgent.element('))!;
  assert.equal(evalCall.params.returnByValue, false);
  tab.noteRefs(['[ref_404]'], '');
  await assert.rejects(drive(t, h.tabs.setFiles(tab, 'ref_404', ['/u/a.txt'])), { code: 'stale_ref' });
  tab.wc.handlers['Runtime.evaluate'] = (p: any) =>
    p.expression.startsWith('globalThis.__mopilotAgent.element(') ? undefined : { result: { value: { value: {}, seq: 0 } } };
  await assert.rejects(drive(t, h.tabs.setFiles(tab, 'ref_1', ['/u/a.txt'])), { code: 'stale_ref' });

  tab.fileChooser = { mode: 'selectSingle', backendNodeId: 0, frameSession: 'F1' };
  await drive(t, h.tabs.setFiles(tab, null, ['/u/c.txt']));
  assert.deepEqual(tab.wc.debugger.sent('DOM.setFileInputFiles').at(-1), {
    method: 'DOM.setFileInputFiles',
    params: { files: ['/u/c.txt'], backendNodeId: 0 },
    sessionId: 'F1',
  });
  assert.equal(tab.fileChooser, null);
  tab.fileChooser = { mode: 'selectSingle', backendNodeId: null, frameSession: '' };
  await assert.rejects(h.tabs.setFiles(tab, null, ['/u/c.txt']), {
    code: 'bad_args',
    message: 'Name the file input with a ref (no file chooser is open).',
  });
  tab.fileChooser = null;
  await assert.rejects(h.tabs.setFiles(tab, null, ['/u/c.txt']), { code: 'bad_args' });
});

test('resize: presets emulate a device (size, DPR, touch, user agent); sizes a viewport; desktop resets all of it', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const sent = () =>
    tab.wc.debugger.calls
      .filter((c) => c.method.startsWith('Emulation.') && c.method !== 'Emulation.setDefaultBackgroundColorOverride')
      .map((c) => [c.method, c.params]);
  h.log.changes.length = 0;
  assert.equal(
    await drive(t, h.tabs.resize(tab, { preset: 'mobile' })),
    'Emulating a mobile device: 375x812 at 3x, touch and a phone user agent. Reload the page so it re-checks the device.',
  );
  assert.deepEqual(tab.emulated, { preset: 'mobile', w: 375, h: 812, dpr: 3, mobile: true, touch: true });
  const mobile = sent();
  assert.deepEqual(mobile[0], [
    'Emulation.setDeviceMetricsOverride',
    { width: 375, height: 812, deviceScaleFactor: 3, mobile: true, screenWidth: 375, screenHeight: 812 },
  ]);
  assert.deepEqual(mobile[1], ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }]);
  assert.match(mobile[2][1].userAgent, /Android 14; Pixel 8.*Mobile Safari/);
  // the pane hears about it (its toolbar shows the device)
  assert.deepEqual(h.log.changes, ['c']);
  tab.wc.debugger.calls.length = 0;
  assert.equal(
    await drive(t, h.tabs.resize(tab, { preset: 'tablet' })),
    'Emulating a tablet device: 768x1024 at 2x, touch and a tablet user agent. Reload the page so it re-checks the device.',
  );
  assert.deepEqual(sent().slice(0, 2), [
    [
      'Emulation.setDeviceMetricsOverride',
      { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, screenWidth: 768, screenHeight: 1024 },
    ],
    ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
  ]);
  assert.doesNotMatch(sent()[2][1].userAgent, /Mobile/);
  tab.wc.debugger.calls.length = 0;
  // a desktop size after a phone puts the tab's own user agent back
  assert.equal(await drive(t, h.tabs.resize(tab, { width: 1280.4, height: 720 })), 'Emulating a 1280x720 viewport.');
  assert.deepEqual(sent(), [
    [
      'Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 720, deviceScaleFactor: 0, mobile: false, screenWidth: 1280, screenHeight: 720 },
    ],
    ['Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 }],
    ['Emulation.setUserAgentOverride', { userAgent: 'Real UA' }],
  ]);
  assert.deepEqual(tab.emulated, { preset: null, w: 1280, h: 720, dpr: 0, mobile: false, touch: false });
  // touch and UA overrides are best-effort
  tab.wc.handlers['Emulation.setTouchEmulationEnabled'] = () => {
    throw new Error('no');
  };
  tab.wc.handlers['Emulation.setUserAgentOverride'] = () => {
    throw new Error('no');
  };
  assert.equal(
    await drive(t, h.tabs.resize(tab, { width: 300, height: 500 })),
    'Emulating a 300x500 viewport (mobile: touch and a phone user agent). Reload the page so it re-checks the device.',
  );
  tab.wc.debugger.calls.length = 0;
  h.log.changes.length = 0;
  assert.equal(
    await drive(t, h.tabs.resize(tab, { preset: 'desktop' })),
    "Cleared the device emulation: the page has the pane's own size, pixel ratio, input and user agent again.",
  );
  assert.equal(tab.emulated, null);
  assert.deepEqual(sent(), [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: 'Real UA' }],
  ]);
  assert.deepEqual(h.log.changes, ['c']);
  // desktop again: nothing was emulated, nothing to announce
  await drive(t, h.tabs.resize(tab, { preset: 'desktop' }));
  assert.deepEqual(h.log.changes, ['c']);
  for (const args of [{ preset: 'watch' }, { width: 100, height: 500 }, { width: 500, height: 5000 }, { width: 'x', height: 500 }, {}])
    await assert.rejects(h.tabs.resize(tab, args), { code: 'bad_args' });
  // the size override is the one that must work
  tab.wc.handlers['Emulation.setDeviceMetricsOverride'] = () => {
    throw new Error('no target');
  };
  await assert.rejects(h.tabs.resize(tab, { preset: 'mobile' }), /no target/);
  tab.wc.handlers['Emulation.clearDeviceMetricsOverride'] = () => {
    throw new Error('no target');
  };
  await assert.rejects(h.tabs.resize(tab, { preset: 'desktop' }), /no target/);
});

test('wheel: a mouse wheel turn of any delta at a point', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  await drive(t, h.tabs.wheel(tab, { x: 5, y: 6 }, 30, -250));
  await drive(t, h.tabs.wheel(tab, { x: 5, y: 6 }, 'x', undefined));
  assert.deepEqual(
    tab.wc.debugger.sent('Input.dispatchMouseEvent').map((c) => c.params),
    [
      { type: 'mouseWheel', x: 5, y: 6, deltaX: 30, deltaY: -250 },
      { type: 'mouseWheel', x: 5, y: 6, deltaX: 0, deltaY: 0 },
    ],
  );
});
