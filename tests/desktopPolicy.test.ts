// electron/capabilities/contract/desktopPolicy.cjs: the pure policy behind the desktop_* tools (tiers by app kind,
// apps never granted, broad-reach warnings, what each action needs, key names, screenshot sizing and the
// pixel <-> point mapping, typing chunks and the action record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../electron/capabilities/contract/desktopPolicy.cjs');

test('desktop policy retains shared keyboard and screenshot helper identities', () => {
  for (const module of ['desktopKeys', 'desktopScreenshots']) {
    const helpers = require(`../electron/capabilities/contract/${module}.cjs`);
    for (const [name, value] of Object.entries(helpers)) assert.equal(P[name], value, name);
  }
});

test('tiers: browsers are view only, terminals and IDEs click and scroll, everything else full control', () => {
  assert.deepEqual(P.TIERS, ['read', 'click', 'full']);
  assert.equal(P.tierOf('com.apple.Safari'), 'read');
  assert.equal(P.tierOf('com.google.Chrome.canary'), 'read', 'a wildcard covers the vendor family');
  assert.equal(P.tierOf('COM.GOOGLE.CHROME'), 'read', 'bundle ids match case-insensitively');
  assert.equal(P.tierOf('com.apple.Terminal'), 'click');
  assert.equal(P.tierOf('com.microsoft.VSCode'), 'click');
  assert.equal(P.tierOf('com.jetbrains.intellij'), 'click');
  assert.equal(P.tierOf('com.apple.Notes'), 'full');
  assert.equal(P.tierOf(''), 'full');
  assert.ok(P.tierRank('read') < P.tierRank('click') && P.tierRank('click') < P.tierRank('full'));
  assert.equal(P.tierRank('nope'), -1);
  assert.deepEqual(P.TIER_LABEL, { read: 'View only', click: 'Click and scroll', full: 'Full control' });
});

test('bundle patterns: a trailing .* matches the stem and anything under it, nothing else', () => {
  assert.equal(P.matches('com.example.*', 'com.example'), true);
  assert.equal(P.matches('com.example.*', 'com.example.app'), true);
  assert.equal(P.matches('com.example.*', 'com.examples'), false);
  assert.equal(P.matches('com.example.app', 'com.example.app.helper'), false);
  assert.equal(P.matches('com.example.app', null), false);
  assert.equal(P.anyMatch(P.HOST_BUNDLES, 'ai.mopilot.code'), true);
  assert.equal(P.anyMatch(P.HOST_BUNDLES, 'ai.mopilot.code.computer-use'), true);
  assert.equal(P.anyMatch(P.HOST_BUNDLES, 'com.github.Electron'), true, 'a development build runs as Electron');
  // by name too, without the helper's lookup (#1362): the app, its helpers, the Electron a development build runs as
  for (const n of [
    'MoPilot',
    ' mopilot.app ',
    'MoPilot Computer Use',
    'MoPilot Helper (Renderer)',
    'MoPilot Codex',
    'MoPilot Code',
    'MoPilot Code.app',
    'Electron',
    'electron.app',
  ])
    assert.equal(P.isHostName(n), true, n);
  for (const n of ['MoPilotCode', 'MoPilotx', 'Electron Fiddle', '', null, undefined, 42]) assert.equal(P.isHostName(n), false, String(n));
  assert.equal(P.anyMatch(P.HOST_BUNDLES, 'com.apple.Notes'), false);
});

test('sentinel warnings: terminals, Finder, System Settings, password managers and script runners', () => {
  assert.match(P.warningOf('com.apple.Terminal'), /run any command/);
  assert.match(P.warningOf('dev.warp.Warp-Stable'), /run any command/);
  assert.match(P.warningOf('com.apple.finder'), /delete any of your files/);
  assert.match(P.warningOf('com.apple.systempreferences'), /security and privacy/);
  assert.match(P.warningOf('com.1password.1password'), /passwords/);
  assert.match(P.warningOf('com.apple.shortcuts'), /scripts and automations/);
  assert.equal(P.warningOf('com.apple.Notes'), null);
});

test('needs: looking needs read, plain clicks and scrolling click, the rest full; modifiers make a click full', () => {
  assert.equal(P.needOf('screenshot'), 'read');
  assert.equal(P.needOf('wait'), null);
  assert.equal(P.needOf('left_click'), 'click');
  assert.equal(P.needOf('left_click', { text: 'cmd' }), 'full');
  assert.equal(P.needOf('double_click', { text: 'shift' }), 'full');
  assert.equal(P.needOf('triple_click', { text: '  ' }), 'click', 'blank modifiers are none');
  assert.equal(P.needOf('scroll', { text: 'cmd' }), 'click', 'only clicks take modifiers');
  assert.equal(P.needOf('right_click'), 'full');
  assert.equal(P.needOf('type'), 'full');
  assert.equal(P.needOf('bogus'), undefined);
  assert.equal(P.INPUT.has('screenshot'), false);
  assert.equal(P.INPUT.has('key'), true);
  assert.equal(P.POINTER.has('key'), false);
  assert.equal(P.POINTER.has('left_click_drag'), true);
});

test('inherited object names are unknown desktop actions', () => {
  for (const action of Object.getOwnPropertyNames(Object.prototype)) assert.equal(P.needOf(action), undefined, action);
});

test('inherited object names stay literal when normalizing desktop key combinations', () => {
  for (const key of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(P.normalizeCombo(key), key.toLowerCase(), key);
    assert.equal(P.normalizeCombo(`ctrl+${key}`), `ctrl+${key.toLowerCase()}`, key);
  }
});

test('key names: aliases normalize, several combinations split on spaces', () => {
  assert.equal(P.normalizeCombo('ctrl+Page_Down'), 'ctrl+pagedown');
  assert.equal(P.normalizeCombo('super+c'), 'cmd+c');
  assert.equal(P.normalizeCombo('Command + Option + Esc'), 'cmd+alt+escape');
  assert.equal(P.normalizeCombo('page-up'), 'pageup', 'dashes read as underscores');
  assert.equal(P.normalizeCombo('BackSpace'), 'delete');
  assert.equal(P.normalizeCombo('Del'), 'forwarddelete');
  assert.equal(P.normalizeCombo('cmd++'), 'cmd');
  assert.deepEqual(P.keySequence(' ctrl+a  Delete '), ['ctrl+a', 'delete']);
  assert.deepEqual(P.keySequence(''), []);
  assert.deepEqual(P.keySequence(undefined), []);
});

test('system combinations act on the whole Mac, in any modifier order; others do not', () => {
  assert.equal(P.isSystemCombo('cmd+q'), true);
  assert.equal(P.isSystemCombo('shift+cmd+q'), true);
  assert.equal(P.isSystemCombo('cmd+space'), true);
  assert.equal(P.isSystemCombo('alt+cmd+escape'), true);
  assert.equal(P.isSystemCombo('cmd+c'), false);
  assert.equal(P.isSystemCombo('q'), false);
  assert.equal(P.isSystemCombo('a+q'), false, 'only modifiers before the key');
  assert.equal(P.hasEscape('cmd+alt+escape'), true);
  assert.equal(P.hasEscape('escape'), true);
  assert.equal(P.hasEscape('return'), false);
});

test('screenshot size: long edge <= 1568 and <= 1.15 MP, never upscaled', () => {
  assert.equal(P.MAX_LONG_EDGE, 1568);
  assert.equal(P.MAX_PIXELS, 1_150_000);
  // the same numbers the Swift helper's captureSize gives (DesktopCoreTests)
  assert.deepEqual(P.screenshotSize(1512, 982, 2), { width: 1331, height: 864 });
  assert.deepEqual(P.screenshotSize(400, 3000, 1), { width: 209, height: 1568 });
  assert.deepEqual(P.screenshotSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(P.screenshotSize(800, 600, 0.5), { width: 800, height: 600 }, 'a scale below 1 is not a downscale');
  assert.deepEqual(P.screenshotSize(0, -1, 0), { width: 1, height: 1 });
  for (const [w, h, s] of [
    [1512, 982, 2],
    [3840, 2160, 1],
    [1024, 1366, 2],
  ]) {
    const r = P.screenshotSize(w, h, s);
    assert.ok(Math.max(r.width, r.height) <= 1568, `${w}x${h}@${s}`);
    assert.ok(r.width * r.height <= 1_150_000 * 1.005, `${w}x${h}@${s}`);
  }
});

test('coordinates: screenshot pixels and global points map through the screenshot frame and back', () => {
  const g = { x: 1440, y: -200, ppp: 0.5 };
  assert.deepEqual(P.toPoints(g, { x: 100, y: 50 }), { x: 1640, y: -100 });
  assert.deepEqual(P.toPixels(g, { x: 1640, y: -100 }), { x: 100, y: 50 });
  assert.deepEqual(P.toPixels(g, P.toPoints(g, { x: 333, y: 7 })), { x: 333, y: 7 });
});

test('typing goes in chunks of 50 characters, by code point', () => {
  const text = 'a'.repeat(120);
  assert.deepEqual(
    P.chunkText(text).map((c: string) => c.length),
    [50, 50, 20],
  );
  const emoji = '😀'.repeat(51);
  const chunks = P.chunkText(emoji);
  assert.equal(chunks.length, 2);
  assert.equal(Array.from(chunks[0]).length, 50, 'a surrogate pair is never split');
  assert.deepEqual(P.chunkText(''), []);
  assert.deepEqual(P.chunkText('abc', 2), ['ab', 'c']);
});

test('action record: effect and route, extras without empty values', () => {
  assert.deepEqual(P.actionRecord('left_click', 'confirmed', 'ax', { element: 3, app: undefined, reason: null, note: '' }), {
    action: 'left_click',
    effect: 'confirmed',
    route: 'ax',
    element: 3,
  });
  assert.deepEqual(P.actionRecord('key', 'refused', 'global'), { action: 'key', effect: 'refused', route: 'global' });
});

test('high-resolution vision: Claude Opus 4.7 and later, Sonnet 5 and later, Fable and Mythos; aliases name the current model', () => {
  for (const m of [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-4.7',
    'claude-sonnet-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-mythos-5',
    'opus',
    'Opus[1m]',
    'opusplan',
    'sonnet',
    'fable',
    'us.anthropic.claude-opus-4-7-v1:0',
    'anthropic.claude-opus-5-5',
    'mopilot/claude-opus-5',
  ]) {
    assert.equal(P.highResModel(m), true, m);
  }
  for (const m of [
    'claude-opus-4-6',
    'claude-opus-4-1',
    'claude-opus-4-20250514',
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-haiku-5-5',
    'haiku',
    'claude-3-5-sonnet-20241022',
    'gpt-5',
    '',
    null,
    undefined,
  ]) {
    assert.equal(P.highResModel(m), false, String(m));
  }
});

test('screenshot limits: by the model, times a scale between 0.1 and 1', () => {
  assert.deepEqual(P.screenshotLimits(null), { maxSide: 1568, maxPixels: 1_150_000, zoomSide: 2000, highRes: false });
  assert.deepEqual(P.screenshotLimits('claude-opus-5-5'), { maxSide: 2000, maxPixels: 3_750_000, zoomSide: 2000, highRes: true });
  assert.deepEqual(P.screenshotLimits('claude-opus-5-5', 0.5), { maxSide: 1000, maxPixels: 937_500, zoomSide: 1000, highRes: true });
  assert.equal(P.screenshotLimits('x', 0.01).maxSide, 157, 'at least a tenth');
  assert.equal(P.screenshotLimits('x', 7).maxSide, 1568, "never above the model's limit");
  assert.equal(P.screenshotLimits('x', NaN).maxSide, 1568);
  assert.equal(P.screenshotLimits('x', '0.5').maxSide, 1568, 'not a number: the default');
  // within the model's own limits, as the Swift helper's captureSize sizes it
  const r = P.screenshotSize(3024, 1964, 2, P.HIGH_RES_LONG_EDGE, P.HIGH_RES_PIXELS);
  assert.ok(Math.max(r.width, r.height) <= 2000 && r.width * r.height <= 3_750_000 * 1.005);
  // the coordinate frame never exceeds what the Claude Code harness shows the model (it downsizes images to 2000 px), or the model's coordinates stop matching its image (#3920)
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'sonnet', 'claude-fable-5-1']) {
    assert.ok(P.screenshotLimits(model).maxSide <= 2000, model);
    assert.ok(P.screenshotLimits(model).zoomSide <= 2000, model);
  }
});

test('typing routes: accessibility then keys; long or multi-line text pasted first; keys only when substitutions are wanted', () => {
  assert.deepEqual(P.typingRoutes('hi'), ['ax', 'keys']);
  assert.deepEqual(P.typingRoutes('hi', { clipboard: true }), ['ax', 'keys']);
  assert.deepEqual(P.typingRoutes('a\nb', { clipboard: true }), ['paste', 'ax', 'keys']);
  assert.deepEqual(P.typingRoutes('a\rb', { clipboard: true }), ['paste', 'ax', 'keys']);
  assert.deepEqual(P.typingRoutes('x'.repeat(P.PASTE_FROM), { clipboard: true }), ['paste', 'ax', 'keys']);
  assert.deepEqual(P.typingRoutes('x'.repeat(P.PASTE_FROM - 1), { clipboard: true }), ['ax', 'keys']);
  assert.deepEqual(P.typingRoutes('a\nb'), ['ax', 'keys'], 'no clipboard: no paste');
  assert.deepEqual(P.typingRoutes('hi', { substitutions: true }), ['keys']);
  assert.deepEqual(P.typingRoutes('a\nb', { substitutions: true, clipboard: true }), ['paste', 'keys']);
  assert.deepEqual(P.typingRoutes(undefined), ['ax', 'keys']);
});

test('typing check: the field must read as the text replacing its selection; unknown selections need the text and a change', () => {
  const at = (value: string, location: number, length = 0, extra = {}) => ({ value, selection: { location, length }, ...extra });
  assert.equal(P.expectedValue(at('Hello world', 6, 5), 'there'), 'Hello there');
  assert.equal(P.expectedValue(at('ab', 1), '😀'), 'a😀b', 'UTF-16 offsets');
  assert.equal(P.expectedValue(null, 'x'), null);
  assert.equal(P.expectedValue({ value: 1 }, 'x'), null);
  assert.equal(P.expectedValue(at('ab', 0, 0, { truncated: true }), 'x'), null);
  assert.equal(P.expectedValue({ value: 'ab' }, 'x'), null);
  assert.equal(P.expectedValue({ value: 'ab', selection: { location: 0.5, length: 0 } }, 'x'), null);
  assert.equal(P.expectedValue({ value: 'ab', selection: { location: 0, length: 'x' } }, 'x'), null);
  assert.equal(P.expectedValue(at('ab', -1), 'x'), null);
  assert.equal(P.expectedValue(at('ab', 0, -1), 'x'), null);
  assert.equal(P.expectedValue(at('ab', 2, 1), 'x'), null, 'beyond the value');
  assert.equal(P.typingEffect(at('Hi ', 3), { value: 'Hi there' }, 'there'), 'confirmed');
  assert.equal(P.typingEffect(at('Hi ', 3), { value: 'Hi There' }, 'there'), 'mismatch');
  assert.equal(
    P.typingEffect({ value: 'Hi ' }, { value: 'Hi there!' }, 'there'),
    'confirmed',
    'no selection: the text is in it and it changed',
  );
  assert.equal(P.typingEffect({ value: 'there' }, { value: 'there' }, 'there'), 'mismatch', 'unchanged');
  assert.equal(P.typingEffect({ value: 'Hi ' }, { value: 'Hi' }, 'there'), 'mismatch');
  assert.equal(P.typingEffect(at('a', 1), null, 'b'), 'unverifiable');
  assert.equal(P.typingEffect(at('a', 1), { value: 2 }, 'b'), 'unverifiable');
  assert.equal(P.typingEffect(at('a', 1), { value: 'ab', truncated: true }, 'b'), 'unverifiable');
  assert.equal(P.typingEffect(null, { value: 'ab' }, 'b'), 'unverifiable');
  assert.equal(P.typingEffect({ value: null }, { value: 'ab' }, 'b'), 'unverifiable');
  assert.equal(P.typingEffect(at('a', 1, 0, { truncated: true }), { value: 'ab' }, 'b'), 'unverifiable');
});

test('needs: holding the left button needs full control; letting go is a click; keys may name their app', () => {
  assert.equal(P.needOf('left_mouse_down'), 'full');
  assert.equal(P.needOf('left_mouse_up'), 'click');
  assert.ok(P.INPUT.has('left_mouse_down') && P.INPUT.has('left_mouse_up'));
  assert.ok(P.POINTER.has('left_mouse_down'));
  assert.equal(P.POINTER.has('left_mouse_up'), false);
  assert.deepEqual([...P.KEYBOARD], ['type', 'key', 'hold_key']);
});

test('coordinate frame: no high-resolution alias gets a frame larger than the 2000 px image the Claude Code harness passes on (#3920)', () => {
  for (const model of [
    'opus',
    'opusplan',
    'sonnet',
    'fable',
    'mythos',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'us.anthropic.claude-opus-4-8-v1:0',
  ]) {
    const l = P.screenshotLimits(model);
    assert.ok(l.highRes, model);
    assert.ok(l.maxSide <= 2000 && l.zoomSide <= 2000, `${model}: ${l.maxSide}/${l.zoomSide}`);
  }
});
