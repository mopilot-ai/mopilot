// Control matrix, computer use (docs/control-plane/matrix.md, group Q): input an agent posts is never a person.
// The user's idle time is what the helper's input guard saw of a person, not the HID idle time every posted event
// resets (the helper's per-process clicks, Codex's computer use), so the brief foreground runs after a background
// click; and Esc-to-stop stops a turn only for a person's Escape, never for one the helper or Codex's computer use
// sent. The decisions are HelperCore's (`swift test`, TakeoverClickTests.swift); these cases hold the helper's
// wiring to them and main's Esc-to-stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readComputerHelperSources } from './support/native-helper-sources.ts';
import { createRequire } from 'node:module';
import { scriptedHelper } from './helpers/scriptedHelper.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const require = createRequire(import.meta.url);
const { ControlIndicator, escapeStops, ESCAPE_ASK_MS } = require('../electron/capabilities/controlIndicator.cjs');
const { ComputerHelper } = require('../electron/capabilities/computer.cjs');

const ROOT = new URL('../', import.meta.url);
const read = (p: string) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const HELPER = 'native/helper/Sources/';
const swiftTests = read('native/helper/Tests/HelperCoreTests/TakeoverClickTests.swift');
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));

/** A globalShortcut that holds the Escape handler, so a test can press it. */
function shortcutRig() {
  const shortcuts = new Map<string, Function>();
  const globalShortcut = {
    register: (accel: string, fn: Function) => (shortcuts.set(accel, fn), true),
    unregister: (accel: string) => shortcuts.delete(accel),
  };
  return { electron: { globalShortcut }, press: () => shortcuts.get('Escape')?.() };
}

test("CM-Q17: the user's idle time is what the input guard saw of a person since it was installed, so a background click (a per-process post) never reads as the user at the computer", () => {
  const guard = read(`${HELPER}ComputerUseHelper/InputGuard.swift`);
  // the guard's reading passes how long it has watched, and the own-post clock every route stamps
  assert.match(
    guard,
    /userIdleSeconds\(hidIdle: hidIdle, sinceOwnPost: OwnPostClock\.shared\.sinceLastPost,\s*sinceUserInput: lastUserAt\.map \{ now - \$0 \}, sinceTapInstalled: installedAt\.map \{ now - \$0 \},\s*sinceOtherInput: lastOtherAt\.map \{ now - \$0 \}\)/,
  );
  // installing the tap starts the watch; removing it ends it
  assert.match(guard, /let ok = lifecycle\.install\(\)\n\s*stampInstalled\(ok\)/);
  assert.match(guard, /lifecycle\.uninstall\(\)\n\s*stampInstalled\(false\)/);
  // what the tap lets through is a person's or another process's post; a dropped foreign post is the latter
  assert.match(guard, /stampInput\(person: origin == \.physical && isUserPresence\(pointer\), at: now\)/);
  assert.match(guard, /aimed at MoPilot"\)\n\s*stampInput\(person: false, at: now\)\n\s*return nil/);
  const core = read(`${HELPER}HelperCore/Takeover.swift`);
  // only a HID event a post explains is replaced by the guard's record; any other is a person's
  assert.match(core, /\.filter \{ hidIdle \+ 0\.05 >= \$0 \}\n\s*guard let post = posts\.min\(\) else \{ return hidIdle \}/);
  assert.match(core, /if let watched = sinceTapInstalled \{ return max\(hidIdle, min\(sinceUserInput \?\? watched, watched\)\) \}/);
  assert.match(swiftTests, /func testUserIdleIsWhatTheGuardSawWhileItWatches\(\)/);
  // the brief foreground's start and restore, and input.idle, all read it
  const sources = readComputerHelperSources();
  assert.equal([...sources.matchAll(/guardTap\.userIdle\(hidIdle:/g)].length, 3);
});

test('CM-Q18: every event the helper posts, at the HID tap or to an app process, is stamped as its own on the way out', () => {
  const all = readComputerHelperSources();
  // one place sets the marker, and it stamps the clock too
  assert.equal([...all.matchAll(/eventSourceUserData, value: ownEventMarker/g)].length, 1);
  assert.match(
    all,
    /func markOwnPost\(_ e: CGEvent\) \{\n\s*e\.setIntegerValueField\(\.eventSourceUserData, value: ownEventMarker\)\n\s*OwnPostClock\.shared\.note\(escapeDown: isEscapeDown\(/,
  );
  // every posting route goes through it right before it posts
  const posts = [...all.matchAll(/\n(\s*)e\.(post\(tap: \.cghidEventTap\)|postToPid\(pid\))/g)];
  assert.equal(posts.length, 2, 'the two routes: the HID tap and per process');
  for (const m of posts) {
    const fn = all.slice(all.lastIndexOf('func ', m.index), m.index);
    assert.match(fn, /markOwnPost\(e\)/, `${m[2]} is stamped`);
  }
  assert.doesNotMatch(all, /CGEventPost|PostKeyboardEvent/, 'no other posting route');
  assert.match(swiftTests, /func testOwnPostClockStampsEveryPostAndEscapes\(\)/);
});

test("CM-Q19: Esc-to-stop stops a turn for a person's Escape only: the helper's own and Codex's computer use's are ignored; an unknown, failed or slow answer stops", async () => {
  for (const [answer, stops] of [
    ['person', true],
    ['unknown', true],
    ['agent', false],
  ] as const) {
    const r = shortcutRig();
    const stopped: string[] = [];
    const ind = new ControlIndicator({ electron: r.electron, onEscape: (c: string) => stopped.push(c), escapeSender: async () => answer });
    ind.sync('c1');
    r.press();
    // control moved on while the answer came: the chat that held it when Esc came is the one stopped
    ind.sync('c2');
    await settle();
    assert.deepEqual(stopped, stops ? ['c1'] : [], answer);
    ind.dispose();
  }
  // a failed answer, or one later than the wait, is unknown: the Escape stops
  assert.equal(
    await escapeStops(async () => {
      throw new Error('helper gone');
    }),
    true,
  );
  assert.equal(await escapeStops(() => new Promise(() => {}), 5), true);
  assert.equal(await escapeStops(null), true);
  assert.equal(await escapeStops(async () => 'agent'), false);
  assert.equal(ESCAPE_ASK_MS, 300);
  // no chat holds control when Esc comes: nothing to ask or stop
  const r = shortcutRig();
  let asked = 0;
  const ind = new ControlIndicator({
    electron: r.electron,
    onEscape: () => assert.fail('no stop'),
    escapeSender: async () => (asked++, 'person'),
  });
  ind.sync('c1');
  ind.chatId = null;
  r.press();
  await settle();
  assert.equal(asked, 0);
  ind.dispose();
  // main asks the helper; the helper answers from its guard's record and its own posts
  // (computerUse.cjs builds the indicator with its helper; indicatorWithPill wires the helper's answer in, #1579)
  assert.match(read('electron/capabilities/computerUse.cjs'), /const indicator = indicatorWithPill\(helper, \{/);
  assert.match(read('electron/capabilities/controlPill.cjs'), /escapeSender: \(\) => helper\.escapeSender\(\)/);
  const helperSwift = read(`${HELPER}ComputerUseHelper/Helper.swift`);
  assert.match(helperSwift, /case "input\.escape":[\s\S]*?reply\(\.success\(\["sender": guardTap\.escapeSender\(\)\.rawValue\]\)\)/);
  const guard = read(`${HELPER}ComputerUseHelper/InputGuard.swift`);
  // every Escape key-down the tap sees is recorded as a person's or not, before anything may drop it
  const at = guard.indexOf('stampEscape(person: isPersonEscape(origin: origin, sourceIsAssistive: assistive), at: now)');
  assert.ok(at > 0 && at < guard.indexOf('if mayDropForeignEvent('));
  assert.match(
    guard,
    /if kind == \.escape \{\n\s*let assistive = origin == \.synthetic && sourcePid > 0 && isAppleAssistive\(pid_t\(sourcePid\)\)/,
  );
  assert.match(guard, /sinceOwnEscape: OwnPostClock\.shared\.sinceEscape/);
  assert.match(swiftTests, /func testEscapeSenderCountsOnlyAPersonsKey\(\)/);
});

test('CM-Q19: the helper client asks a running helper who sent Escape, and never launches one for it', async () => {
  let n = 0;
  const fake = await scriptedHelper((method) => {
    if (method !== 'input.escape') return { result: { ok: true } };
    n++;
    if (n === 2) return { error: { code: -32601, message: 'unknown method input.escape' } };
    // the helper exits while it answers: not relaunched, so nobody saw that Escape
    if (n === 3) return { drop: true };
    return { result: { sender: 'agent' } };
  });
  const helper = new ComputerHelper({ connectTo: fake.socket });
  try {
    assert.equal(await helper.escapeSender(), 'unknown');
    assert.equal(fake.connections(), 0, 'not launched');
    await helper.start();
    assert.equal(await helper.escapeSender(), 'agent');
    // an older helper's error goes to the caller (escapeStops: unknown, so the Escape stops)
    await assert.rejects(helper.escapeSender(), /unknown method/);
    assert.equal(await helper.escapeSender(), 'unknown');
    assert.equal(fake.connections(), 1, 'not relaunched');
    assert.deepEqual(
      fake.log.map((l) => l.method),
      ['hello', 'input.escape', 'input.escape', 'input.escape'],
    );
  } finally {
    helper.stop();
    await fake.close();
    fake.cleanup();
  }
});

test('native helper source guards discover extracted and nested Swift modules without a filename list', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-guard-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Original.swift'), 'original');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not source');
  assert.equal(readComputerHelperSources(dir), 'original');
  fs.mkdirSync(path.join(dir, 'input'));
  fs.writeFileSync(path.join(dir, 'input', 'Extracted.swift'), 'extracted');
  assert.equal(readComputerHelperSources(dir), 'original\nextracted');
});
