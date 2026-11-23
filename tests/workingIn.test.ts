// The "working in" state machine (start, step, done/stopped/failed) on MoPilot's desktop tools and a vendor's computer use, and Mac key names in step narration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceWorkingIn, workingEvents, workingInOf } from '../src/lib/workingIn.ts';
import { controlStep, isMoPilotControl, macKeys } from '../src/lib/agentNarration.ts';

const result = (text = '', extra: any[] = []) => ({ content: [...(text ? [{ type: 'text', text }] : []), ...extra] });
/** MoPilot's background tool from Codex/ACP (desktop_app_*) */
const sage = (tool: string, args: any, status = 'completed', text = '', extra: any[] = []) => ({
  type: 'mcpToolCall',
  server: 'sage_x',
  tool,
  arguments: args,
  status,
  result: result(text, extra),
});
/** MoPilot's tools as Claude Code sees them */
const claude = (tool: string, args: any, text = '') => ({
  type: 'mcpToolCall',
  server: 'mopilot_computer',
  tool,
  arguments: args,
  status: 'completed',
  result: result(text),
});
/** Codex's own computer use: one cua_repl program */
const cua = (code: string, status = 'completed') => ({
  type: 'mcpToolCall',
  server: 'cua_repl',
  tool: 'js',
  arguments: { code },
  status,
  result: result(),
});
const turn = (status: any, items: any[], id = 't1') => ({ id, status, items });

test('macKeys: modifiers as Mac symbols in Mac order, named keys, arrows, and text it does not know', () => {
  assert.equal(macKeys('super+n'), '⌘N');
  assert.equal(macKeys('cmd+shift+z'), '⇧⌘Z');
  assert.equal(macKeys('Control+Alt+Delete'), '⌃⌥⌫');
  assert.equal(macKeys('option+Meta+Command+win+opt'), '⌥⌘');
  assert.equal(macKeys('shift+cmd+return'), '⇧⌘↩');
  assert.equal(macKeys('return'), 'Return');
  assert.equal(macKeys('Enter'), 'Return');
  assert.equal(macKeys('escape'), 'Esc');
  assert.equal(macKeys('cmd+esc'), '⌘⎋');
  assert.equal(macKeys('ArrowLeft'), '←');
  assert.equal(macKeys('ctrl+up'), '⌃↑');
  assert.equal(macKeys('right down'), '→ ↓');
  assert.equal(macKeys('tab'), 'Tab');
  assert.equal(macKeys('BackSpace'), 'Delete');
  assert.equal(macKeys('space'), 'Space');
  assert.equal(macKeys('f5'), 'F5');
  assert.equal(macKeys('ctrl+a ctrl+c'), '⌃A ⌃C');
  assert.equal(macKeys('shift'), '⇧');
  // two plain keys in one chord, or no key at all: left as written
  assert.equal(macKeys('a+b'), 'a+b');
  assert.equal(macKeys('+'), '+');
  assert.equal(macKeys('  '), '');
});

test('narration: vendor and MoPilot desktop keys read as a Mac shows them; a page keeps its key names', () => {
  const step = (item: any) => controlStep(item)!;
  assert.equal(step(cua('let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")')).done, 'Pressed ⌘N in TextEdit');
  assert.equal(step(cua('let app = await cua.getApp("TextEdit"); await app.pressKey("super+n")')).app, 'TextEdit');
  assert.equal(step(cua('await tab.playwright.keyboard.press("Enter")')).done, 'Pressed Enter');
  assert.equal(step(cua('let app = await cua.getApp("Notes"); await app.press()')).done, 'Pressed a key in Notes');
  assert.equal(step(sage('desktop_app_key', { app: 'Notes', combo: 'super+n' })).done, 'Pressed ⌘N in Notes');
  assert.equal(step(sage('desktop_app_key', { app: 'Notes' })).done, 'Pressed  in Notes');
  assert.equal(step(sage('desktop_key', { text: 'escape' })).done, 'Pressed Esc');
  assert.equal(step(sage('desktop_key', {})).doing, 'Pressing ');
  // the app each step works in: a getApp without a binding, a display-scope tool's argument or record, the computer-use server
  assert.equal(step(cua('await cua.getApp("Mail")')).app, 'Mail');
  assert.equal(step(cua('await cua.getApp(name)')).app, undefined);
  assert.equal(step(sage('desktop_open_application', { app: 'Mail' })).app, 'Mail');
  assert.equal(step(sage('desktop_left_click', {})).app, undefined);
  assert.equal(step(sage('browser_navigate', { url: 'https://a.example' })).app, undefined);
  assert.equal(step({ type: 'mcpToolCall', server: 'computer-use', tool: 'app_click', arguments: { app: 'Notes' } }).app, 'Notes');
  assert.equal(step({ type: 'mcpToolCall', server: 'computer-use', tool: 'left_click', arguments: {} }).app, undefined);
  assert.equal(step(claude('app_click', { app: 'com.apple.Notes' })).app, 'Notes');
  assert.equal(step(claude('left_click', {}, '{"app":"Finder"}')).app, 'Finder');
  assert.equal(step(claude('left_click', {})).app, undefined);
  // a program it cannot read names an app only when it uses one
  assert.equal(step(cua('nodeRepl.write(1)')).app, undefined);
  // MoPilot's own tools, on any harness, and the vendors'
  assert.equal(isMoPilotControl(sage('desktop_app_click', {})), true);
  assert.equal(isMoPilotControl(claude('app_click', {})), true);
  assert.equal(isMoPilotControl(cua('1')), false);
  assert.equal(isMoPilotControl(null), false);
});

test('reduceWorkingIn: start, steps (latest app first, its picture kept), end states, and other turns ignored', () => {
  let s = reduceWorkingIn(null, { type: 'step', turnId: 't1', app: 'Notes', path: 'sage', step: 'x' });
  assert.equal(s, null, 'no step before a start');
  s = reduceWorkingIn(s, { type: 'start', turnId: 't1' });
  assert.deepEqual(s, { turnId: 't1', status: 'working', apps: [] });
  s = reduceWorkingIn(s, { type: 'step', turnId: 't1', app: 'Notes', path: 'vendor', step: 'Opening Notes', shot: 'data:a' });
  s = reduceWorkingIn(s, { type: 'step', turnId: 't1', app: 'Mail', path: 'vendor', step: 'Clicking in Mail' });
  s = reduceWorkingIn(s, { type: 'step', turnId: 't1', app: 'notes', path: 'vendor', step: 'Typing 3 characters in Notes' });
  assert.deepEqual(s!.apps, [
    { app: 'notes', path: 'vendor', step: 'Typing 3 characters in Notes', shot: 'data:a' },
    { app: 'Mail', path: 'vendor', step: 'Clicking in Mail', shot: null },
  ]);
  // a late event of another turn changes nothing
  assert.equal(reduceWorkingIn(s, { type: 'end', turnId: 't0', outcome: 'failed' }), s);
  for (const outcome of ['done', 'stopped', 'failed'] as const) {
    const ended = reduceWorkingIn(s, { type: 'end', turnId: 't1', outcome })!;
    assert.equal(ended.status, outcome);
    // the end state stays: a step after it does not bring the turn back
    assert.equal(reduceWorkingIn(ended, { type: 'step', turnId: 't1', app: 'X', path: 'sage', step: 'y' }), ended);
  }
  // the next turn starts empty
  assert.deepEqual(reduceWorkingIn(s, { type: 'start', turnId: 't2' }), { turnId: 't2', status: 'working', apps: [] });
});

test('workingInOf: MoPilot path — app tools, a running step in the doing tense, its screenshot, and the turn end', () => {
  const shot = { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' };
  const running = workingInOf(
    turn('inProgress', [
      { type: 'agentMessage', text: 'hi' },
      sage('browser_navigate', { url: 'https://a.example' }),
      sage('desktop_app_screenshot', { app: 'com.apple.TextEdit' }, 'completed', '', [shot]),
      sage('desktop_app_key', { app: 'TextEdit', combo: 'cmd+n' }, 'inProgress'),
    ]),
  )!;
  assert.equal(running.status, 'working');
  assert.equal(running.apps.length, 1);
  assert.equal(running.apps[0].app, 'TextEdit');
  assert.equal(running.apps[0].path, 'sage');
  assert.equal(running.apps[0].step, 'Pressing ⌘N in TextEdit');
  assert.match(running.apps[0].shot!, /^data:image\/jpeg;base64,QUJD/);
  const done = workingInOf(turn('completed', [sage('desktop_app_key', { app: 'TextEdit', combo: 'cmd+n' }, 'inProgress')]))!;
  assert.equal(done.status, 'done');
  assert.equal(done.apps[0].step, 'Pressed ⌘N in TextEdit', 'a finished turn reads in the past tense');
  assert.equal(workingInOf(turn('interrupted', [claude('app_click', { app: 'Notes' })]))!.status, 'stopped');
  assert.equal(workingInOf(turn('failed', [claude('app_click', { app: 'Notes' })]))!.apps[0].path, 'sage');
});

test('workingInOf: vendor path — the app a program bound, later steps without an app go to it, failure and nothing to show', () => {
  const items = [
    cua('let te = await cua.getApp("TextEdit")'),
    cua('await te.pressKey("super+n")'),
    cua('await cua.listApps()'),
    cua('nodeRepl.write(1)', 'inProgress'),
  ];
  const w = workingInOf(turn('inProgress', items))!;
  assert.deepEqual(
    w.apps.map((a) => [a.app, a.path, a.step]),
    [['TextEdit', 'vendor', 'Running a computer-use script']],
  );
  assert.equal(workingInOf(turn('failed', items))!.status, 'failed');
  // steps of the other path do not borrow the vendor's app
  const mixed = workingInOf(turn('completed', [cua('await cua.getApp("Mail")'), sage('desktop_left_click', {})]))!;
  assert.deepEqual(
    mixed.apps.map((a) => a.app),
    ['Mail'],
  );
  // a step before any app is known, browser-only turns, no turn: nothing to show
  assert.equal(workingInOf(turn('completed', [cua('await cua.listApps()')])), null);
  assert.equal(workingInOf(turn('completed', [cua('await tab.goto("https://a.example")')])), null);
  assert.equal(workingInOf(null), null);
  assert.equal(workingInOf(undefined), null);
  assert.deepEqual(
    workingEvents(turn('completed', [])).map((e) => e.type),
    ['start', 'end'],
  );
});
