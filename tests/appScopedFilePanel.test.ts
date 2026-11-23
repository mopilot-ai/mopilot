// desktop_app_file_panel (electron/capabilities/tools/appScopedFilePanel.cjs): choosing the folder and file name of a
// Save or Open panel of an app in the background (#1528), the refusals that send the model there, and its narration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createRequire } from 'node:module';
import { SPECS, keyVerdict, helperFailure, rig, rejects } from './support/app-scoped-kit.ts';
import { appStep } from '../src/lib/agentNarration/tools.ts';

const require = createRequire(import.meta.url);
const { panelFolder, panelFileName } = require('../electron/capabilities/tools/appScopedFilePanel.cjs');
const { menuDisabledError, PANEL_HINT } = require('../electron/capabilities/tools/appScopedUtil.cjs');
const HOME = os.homedir();

test('panelFolder: absolute or ~/ paths, normalized; anything else is refused before the panel is touched', () => {
  assert.equal(panelFolder('~', '/Users/me'), '/Users/me');
  assert.equal(panelFolder(' ~/Documents/Reports/ ', '/Users/me'), '/Users/me/Documents/Reports');
  assert.equal(panelFolder('/tmp//a/../b/'), '/tmp/b');
  assert.equal(panelFolder('/'), '/');
  assert.equal(panelFolder('~/x'), `${HOME}/x`);
  for (const bad of [undefined, 3, '', '  '])
    assert.throws(
      () => panelFolder(bad),
      (e: any) => e.code === 'bad_args' && /folder is required/.test(e.message),
    );
  for (const bad of ['Documents', './x', '~bob/x'])
    assert.throws(
      () => panelFolder(bad),
      (e: any) => e.code === 'bad_args' && /absolute or start with ~\//.test(e.message),
    );
  for (const bad of ['/a\nb', '/a\u007fb', `/${'a'.repeat(1024)}`])
    assert.throws(
      () => panelFolder(bad),
      (e: any) => e.code === 'bad_args' && /plain path/.test(e.message),
    );
});

test('panelFileName: a name only, trimmed; none is undefined; a folder, control characters or dots are refused', () => {
  assert.equal(panelFileName(undefined), undefined);
  assert.equal(panelFileName(null), undefined);
  assert.equal(panelFileName(' report.pdf '), 'report.pdf');
  for (const bad of ['', ' ', 5])
    assert.throws(
      () => panelFileName(bad),
      (e: any) => e.code === 'bad_args' && /non-empty/.test(e.message),
    );
  assert.throws(
    () => panelFileName('a/b.txt'),
    (e: any) => e.code === 'bad_args' && /name only/.test(e.message),
  );
  for (const bad of ['.', '..', 'a\tb', 'x'.repeat(256)])
    assert.throws(
      () => panelFileName(bad),
      (e: any) => e.code === 'bad_args' && /plain name/.test(e.message),
    );
});

test('the tool: the helper gets the panel request for the captured window; the record names the location; the old frame is dropped', async () => {
  const r = rig();
  await r.shoot();
  r.helper.answers['app.filePanel'] = () => ({ ok: true, reached: true, location: 'Reports', fileName: 'r.txt', route: 'ax+pid' });
  const out = await r.text('desktop_app_file_panel', { app: 'Notes', folder: '~/Documents/Reports/', file_name: 'r.txt' });
  const [line, next] = out.split('\n');
  assert.deepEqual(JSON.parse(line), {
    action: 'file_panel',
    effect: 'confirmed',
    route: 'ax+pid',
    app: 'Notes',
    window_id: 5,
    folder: `${HOME}/Documents/Reports`,
    location: 'Reports',
    file_name: 'r.txt',
  });
  assert.equal(
    next,
    'The panel is still open: take a desktop_app_screenshot of window 5 to check it, then call desktop_app_file_panel again with confirm: true (or press its Save or Open button by element_index with desktop_app_click; a click by coordinate does not reach the panel in the background).',
  );
  assert.deepEqual(r.last('app.filePanel'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    folder: `${HOME}/Documents/Reports`,
    fileName: 'r.txt',
    foreground: false,
  });
  assert.equal(r.apps.lockedBy('com.apple.Notes', 'c2'), 'c1');
  // the panel changed: element indexes of the old screenshot no longer hold
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'bad_args', /screenshot of Notes first/);
});

test('the tool: no screenshot yet, no name, an older answer shape; a panel that did not reach the folder is ineffective', async () => {
  const r = rig();
  r.helper.answers['app.filePanel'] = () => ({ ok: true });
  const first = JSON.parse((await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/tmp' })).split('\n')[0]);
  assert.deepEqual(first, { action: 'file_panel', effect: 'unverifiable', route: 'ax', app: 'Notes', folder: '/tmp' });
  assert.deepEqual(r.last('app.filePanel'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: undefined,
    folder: '/tmp',
    foreground: false,
  });
  r.helper.answers['app.filePanel'] = () => ({
    ok: false,
    reached: false,
    location: 7,
    fileName: 3,
    message: 'The folder can’t be found.',
  });
  const [line, next] = (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/nope' })).split('\n');
  assert.deepEqual(JSON.parse(line), {
    action: 'file_panel',
    effect: 'ineffective',
    route: 'ax',
    app: 'Notes',
    folder: '/nope',
    reason: 'The folder can’t be found.',
  });
  assert.match(next, /did not move to that folder\. Check that the folder exists/);
  r.helper.answers['app.filePanel'] = () => ({ reached: false, location: 'x'.repeat(200) });
  const long = JSON.parse((await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/nope' })).split('\n')[0]);
  assert.equal(long.reason, 'the panel did not show the folder');
  assert.equal(long.location.length, 120);
  // the panel listed as a window of its own (a sheet wider than its document window): the model is sent there
  r.helper.answers['app.filePanel'] = () => ({ ok: true, reached: true, panelWindowId: 9 });
  const [own, there] = (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/' })).split('\n');
  assert.equal(JSON.parse(own).panel_window_id, 9);
  assert.match(there, /take a desktop_app_screenshot of window 9 /);
  r.helper.answers['app.filePanel'] = () => null;
  assert.equal(JSON.parse((await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/' })).split('\n')[0]).effect, 'unverifiable');
});

test('the tool: bad arguments, a weaker grant, a read-only chat and helper refusals end before or at the panel, with a record', async () => {
  const r = rig({
    saved: [
      { bundleId: 'com.apple.Notes', name: 'Notes', level: 'full' },
      { bundleId: 'com.apple.mail', name: 'Mail', level: 'click' },
    ],
  });
  await rejects(r.call('desktop_app_file_panel', { app: 'Notes', folder: 'Documents' }), 'bad_args', /absolute/);
  await rejects(r.call('desktop_app_file_panel', { app: 'Notes', folder: '/tmp', file_name: 'a/b' }), 'bad_args', /name only/);
  await assert.rejects(
    r.call('desktop_app_file_panel', { app: 'Mail', folder: '/tmp' }),
    (e: any) => e.code === 'tier' && /choosing a folder in a Save or Open panel/.test(e.message) && e.record.effect === 'refused',
  );
  assert.equal(r.callsOf('app.filePanel').length, 0);
  r.helper.fail['app.filePanel'] = helperFailure('unsupported', 'unsupported(no_file_panel): no Save or Open panel is open in this window');
  await assert.rejects(
    r.call('desktop_app_file_panel', { app: 'Notes', folder: '/tmp' }),
    (e: any) =>
      e.code === 'unsupported' &&
      /no_file_panel/.test(e.message) &&
      e.record.effect === 'unsupported' &&
      /"action":"file_panel"/.test(e.message),
  );
  // an older helper without the method: named as outdated, not a crash
  r.helper.fail['app.filePanel'] = helperFailure('method_not_found', 'method not found: app.filePanel');
  await assert.rejects(
    r.call('desktop_app_file_panel', { app: 'Notes', folder: '/tmp' }),
    (e: any) => e.code === 'unavailable' && e.record.effect === 'refused',
  );
  r.state.session = { permission: 'plan' };
  r.cu.harness = () => 'claude';
  r.cu.anchor = () => 'readOnly';
  await assert.rejects(r.call('desktop_app_file_panel', { app: 'Notes', folder: '/tmp' }), (e: any) => e.code === 'read_only');
});

test('the tool: a folder outside the sidebar goes through Go to Folder with brief switching, and the record says so; off, the model is told what else to do', async () => {
  const on = { allowed: () => true, rung: () => 'background', remember: () => false };
  const r = rig({ apps: { ladder: on } });
  r.helper.answers['app.filePanel'] = (p: any) =>
    p.foreground
      ? {
          ok: true,
          route: 'foreground',
          reached: true,
          location: 'Target',
          foreground: { activated: true, restored: true, userTookOver: false },
        }
      : null;
  const rec = JSON.parse((await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/x/Target' })).split('\n')[0]);
  assert.equal(r.last('app.filePanel').foreground, true);
  assert.equal(rec.rung, 'foreground');
  assert.equal(rec.route, 'foreground');
  assert.match(
    rec.ladder,
    /^Notes needs brief foreground for Go to Folder: it was brought to the front for this action, then the previous app and pointer were restored\.$/,
  );
  // an Open panel: no name field to set, said in a note
  const click = rig({ apps: { ladder: on }, saved: [{ bundleId: 'com.apple.Notes', name: 'Notes', level: 'full' }] });
  click.helper.answers['app.filePanel'] = () => ({ ok: true, reached: true, nameField: false, fileName: 'x' });
  const noName = JSON.parse((await click.text('desktop_app_file_panel', { app: 'Notes', folder: '/', file_name: 'x' })).split('\n')[0]);
  assert.match(noName.note, /no file name field \(an Open panel\)/);
  assert.equal(noName.rung, undefined);
  // brief switching off: the helper refuses, the model reads its other ways
  const off = rig();
  off.helper.fail['app.filePanel'] = helperFailure(
    'unsupported',
    "unsupported(needs_foreground): /x/Target couldn't be chosen from the panel's sidebar",
  );
  await assert.rejects(
    off.call('desktop_app_file_panel', { app: 'Notes', folder: '/x/Target' }),
    (e: any) =>
      e.code === 'unsupported' &&
      /needs_foreground.*Choose a sidebar folder instead .*"Allow brief switching to the app" in Settings → Computer use\./.test(
        e.message,
      ) &&
      e.record.effect === 'unsupported',
  );
});

test('confirm: sent only when asked; the panel closing, an alert left unanswered, a press that changed nothing and one that was not made each read as such (#1381 f2)', async () => {
  const r = rig();
  await r.shoot();
  r.helper.answers['app.filePanel'] = () => ({
    ok: true,
    reached: true,
    route: 'ax',
    panelWindowId: 9,
    selected: 'scan.txt',
    confirmed: true,
    pressed: 'Open',
    closed: true,
  });
  const [closed, closedNext] = (
    await r.text('desktop_app_file_panel', { app: 'Notes', window_id: 5, folder: '/d', file_name: 'scan.txt', confirm: true })
  ).split('\n');
  assert.equal(r.last('app.filePanel').confirm, true);
  assert.equal(r.last('app.filePanel').windowId, 5);
  assert.deepEqual(JSON.parse(closed), {
    action: 'file_panel',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    window_id: 5,
    panel_window_id: 9,
    folder: '/d',
    selected: 'scan.txt',
    pressed: 'Open',
    closed: true,
  });
  assert.equal(
    closedNext,
    'The panel closed after Open. Take a desktop_app_screenshot of the app to check the result (desktop_app_list_windows lists its windows).',
  );
  // Save into a folder that has the file: the Replace alert is reported, never pressed
  r.helper.answers['app.filePanel'] = () => ({
    reached: true,
    panelWindowId: 9,
    confirmed: true,
    pressed: 'Save',
    closed: false,
    prompt: '“r.pdf” already exists. Do you want to replace it?',
    promptButtons: ['Cancel', 'Replace', 7],
  });
  const [alert, alertNext] = (
    await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file_name: 'r.pdf', confirm: true })
  ).split('\n');
  assert.deepEqual(JSON.parse(alert).prompt_buttons, ['Cancel', 'Replace']);
  assert.match(JSON.parse(alert).prompt, /already exists/);
  assert.equal(
    alertNext,
    'Save brought up an alert in the panel (buttons: Cancel, Replace). Nothing in it was pressed: if it asks to replace a file, replace it only when the user wants that; take a desktop_app_screenshot of window 9, then press a button by element_index with desktop_app_click.',
  );
  r.helper.answers['app.filePanel'] = () => ({ reached: true, confirmed: true, pressed: 'Save', closed: false });
  assert.match(
    (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n')[1],
    /^Save was pressed but the panel is still open: take a desktop_app_screenshot of window 5 to see why\.$/,
  );
  // not pressed: the record is ineffective with the helper's reason
  r.helper.answers['app.filePanel'] = () => ({
    reached: true,
    confirmed: false,
    confirmMessage: 'Open is disabled: the panel has nothing chosen it can open',
  });
  const [no, noNext] = (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n');
  assert.equal(JSON.parse(no).effect, 'ineffective');
  assert.equal(
    noNext,
    'Not pressed: Open is disabled: the panel has nothing chosen it can open. Take a desktop_app_screenshot of window 5 to check the panel.',
  );
  r.helper.answers['app.filePanel'] = () => ({ reached: true, confirmed: false });
  assert.equal(
    JSON.parse((await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n')[0]).reason,
    'the default button was not pressed',
  );
  // the helper's own buttons may lack a title: the next step still reads
  r.helper.answers['app.filePanel'] = () => ({ reached: true, confirmed: true, closed: true });
  assert.match(
    (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n')[1],
    /^The panel closed after the default button\./,
  );
  r.helper.answers['app.filePanel'] = () => ({ reached: true, confirmed: true, closed: false });
  assert.match(
    (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n')[1],
    /^The default button was pressed but/,
  );
  r.helper.answers['app.filePanel'] = () => ({ reached: true, prompt: 'Sure?' });
  assert.match(
    (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: true })).split('\n')[1],
    /^An alert is up in the panel\. Nothing/,
  );
  // without confirm the helper is not asked to press anything
  r.helper.answers['app.filePanel'] = () => ({ reached: true });
  await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', confirm: 'yes' });
  assert.equal(r.last('app.filePanel').confirm, undefined);
});

test('an Open panel given a file that is not in the folder, and Finder going to a folder through Go to Folder', async () => {
  const r = rig();
  r.helper.answers['app.filePanel'] = () => ({ reached: true, selected: false, panelWindowId: 9 });
  const [miss, missNext] = (
    await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file_name: 'nope.txt', confirm: true })
  ).split('\n');
  assert.equal(JSON.parse(miss).effect, 'ineffective');
  assert.equal(JSON.parse(miss).reason, 'that file is not in the folder’s list');
  assert.equal(
    missNext,
    'The panel shows the folder, but that file is not in its list: take a desktop_app_screenshot of window 9 to check the name, then call again with the name it shows.',
  );
  r.helper.answers['app.filePanel'] = () => ({
    ok: true,
    route: 'ax',
    finder: true,
    reached: true,
    location: 'docs',
    fileName: 'scan.txt',
    panelWindowId: 4,
  });
  const [finder, finderNext] = (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file_name: 'scan.txt' })).split('\n');
  assert.equal(JSON.parse(finder).effect, 'confirmed');
  assert.equal(
    finderNext,
    'Finder window 4 shows the folder, with “scan.txt” selected. To open it, call again with confirm: true; take a desktop_app_screenshot of window 4 to check it.',
  );
  r.helper.answers['app.filePanel'] = () => ({ finder: true, reached: true });
  assert.equal(
    (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d' })).split('\n')[1],
    'Finder shows the folder. To open a file in it, call again with its file_name and confirm: true; take a desktop_app_screenshot to check it.',
  );
});

test('Finder confirm opens the document in its default app in the background, or says why not; file is taken for file_name', async () => {
  const r = rig();
  r.helper.answers['app.filePanel'] = () => ({
    finder: true,
    reached: true,
    fileName: 'scan.txt',
    confirmed: true,
    pressed: 'Open',
    closed: true,
    opened: 'TextEdit',
  });
  const [rec, next] = (await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file: 'scan.txt', confirm: true })).split('\n');
  assert.equal(r.last('app.filePanel').fileName, 'scan.txt');
  // the apps it may open in: the chat's grants, sent with confirm only
  assert.deepEqual(r.last('app.filePanel').openGranted, ['com.apple.Notes', 'com.apple.mail', 'com.apple.Terminal', 'com.apple.Safari']);
  assert.equal(JSON.parse(rec).opened, 'TextEdit');
  assert.equal(
    next,
    'Opened “scan.txt” in TextEdit, which stays in the background: desktop_app_list_windows for TextEdit finds its window.',
  );
  r.helper.answers['app.filePanel'] = () => ({
    finder: true,
    reached: true,
    fileName: 'run.command',
    confirmed: false,
    confirmMessage: '“run.command” wasn’t opened: opening it would run something (an app, script or installer)',
  });
  const [no, noNext] = (
    await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file_name: 'run.command', confirm: true })
  ).split('\n');
  assert.equal(JSON.parse(no).effect, 'ineffective');
  assert.equal(
    noNext,
    'Finder shows the folder, but the file was not opened: “run.command” wasn’t opened: opening it would run something (an app, script or installer).',
  );
  // file_name wins over the alias
  await r.text('desktop_app_file_panel', { app: 'Notes', folder: '/d', file_name: 'a.txt', file: 'b.txt' });
  assert.equal(r.last('app.filePanel').fileName, 'a.txt');
});

test('confirm flagged irreversible asks the user first; a denial presses nothing', async () => {
  const r = rig();
  r.helper.answers['app.filePanel'] = () => ({ reached: true, confirmed: true, closed: true, pressed: 'Save' });
  const args = {
    app: 'Notes',
    folder: '/d',
    file_name: 'r.pdf',
    confirm: true,
    irreversible: true,
    action_summary: 'Overwrites the report',
  };
  await r.text('desktop_app_file_panel', args);
  assert.deepEqual(
    r.asks.map((a) => [a.kind, a.params.tool, a.params.summary]),
    [['computerConfirm', 'desktop_app_file_panel', 'Overwrites the report']],
  );
  r.answers.computerConfirm = { decision: 'deny' };
  const n = r.callsOf('app.filePanel').length;
  await assert.rejects(r.call('desktop_app_file_panel', args), (e: any) => e.code === 'denied' && e.record.effect === 'refused');
  assert.equal(r.callsOf('app.filePanel').length, n);
  // the flag without confirm (nothing is pressed) asks nobody
  r.asks.length = 0;
  r.answers.computerConfirm = { decision: 'allow' };
  await r.text('desktop_app_file_panel', { ...args, confirm: false });
  assert.equal(r.asks.length, 0);
});

test('the refusals that met a Save panel name desktop_app_file_panel: the Where pop-up, a right click, cmd shortcuts, the disabled-menu advice', async () => {
  const r = rig();
  await r.shoot();
  // [3] is the Font pop-up button in the kit's window
  await rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 3 }),
    'unsupported',
    /unsupported\(menu\).*desktop_app_file_panel/,
  );
  await rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 1, button: 'right' }),
    'unsupported',
    /context_menu.*desktop_app_file_panel/,
  );
  // Go to Folder (#1381 f2: the model kept pressing it in TextEdit's Open panel and Finder) names the panel tool alone
  for (const combo of ['cmd+shift+g', 'shift+cmd+g'])
    assert.match(
      String(keyVerdict(combo)?.message),
      /^unsupported\(use_file_panel\): .* is Go to Folder.*desktop_app_file_panel with folder .*in Finder goes through Go to Folder itself\.$/,
    );
  // other shifted shortcuts may be an app's own command (Mail's cmd+shift+d sends): the menu refusal, with the panel hint
  for (const combo of ['cmd+shift+d', 'cmd+alt+g', 'ctrl+shift+g'])
    assert.match(String(keyVerdict(combo)?.message), /use_app_menu.*desktop_app_file_panel/);
  assert.match(PANEL_HINT, /Save or Open panel/);
  const disabled = menuDisabledError('TextEdit', ['File', 'Save'], true).message;
  assert.match(disabled, /desktop_app_file_panel chooses its folder/);
  assert.doesNotMatch(disabled, /location .*work in the background/);
});

test('the specs: file_panel is a background act tool needing app and folder; click, type and key point to it, not to display-scope Go to Folder', () => {
  const spec = SPECS.find((s: any) => s.name === 'desktop_app_file_panel');
  assert.equal(spec.policy, 'act');
  assert.deepEqual(spec.schema.required, ['app', 'folder']);
  assert.deepEqual(Object.keys(spec.schema.properties), [
    'app',
    'window_id',
    'folder',
    'file_name',
    'confirm',
    'action_summary',
    'irreversible',
  ]);
  assert.match(spec.description, /a window of its own such as TextEdit's Open panel; found in any of the app's windows/);
  assert.match(spec.description, /In Finder, which has no panel, it goes to the folder through Go › Go to Folder/);
  assert.match(
    spec.description,
    /confirm: true also presses the panel's Save or Open button .* an alert that comes up \(such as Replace\) is reported and left for you/,
  );
  assert.match(
    spec.description,
    /standard folder .* through accessibility with the app in the background; any other folder goes through Go to Folder, which macOS accepts only with the app in front/,
  );
  assert.match(spec.description, /BACKGROUND/);
  for (const name of ['desktop_app_click', 'desktop_app_type', 'desktop_app_key'])
    assert.match(SPECS.find((s: any) => s.name === name).description, /desktop_app_file_panel/, name);
  assert.doesNotMatch(SPECS.find((s: any) => s.name === 'desktop_app_type').description, /display-scope desktop_key/);
});

test('narration: the folder by its last component, in the app', () => {
  const rec = '{"action":"file_panel","effect":"confirmed","route":"ax","app":"TextEdit"}';
  assert.deepEqual(appStep('file_panel', { app: 'com.apple.TextEdit', folder: '~/Documents/Reports/' }, rec), [
    'Chose the folder “Reports” in TextEdit',
    'Choosing the folder “Reports” in TextEdit',
  ]);
  assert.deepEqual(appStep('file_panel', { folder: '/' }, ''), ['Chose the folder “/”', 'Choosing the folder “/”']);
  assert.deepEqual(appStep('file_panel', { app: 'Notes' }, ''), ['Chose a folder in Notes', 'Choosing a folder in Notes']);
});
