// Control matrix, computer use on MoPilot's helper (docs/control-plane/matrix.md, group Q): only a person's input
// takes over (the helper's own events, their echoes, pointer reports with no motion and other processes' moves do
// not), the user's idle time leaves the helper's own input out, and a click lands in source-list rows and
// out-of-process panels. The decisions are HelperCore's (unit-tested with `swift test`, TakeoverClickTests.swift);
// these cases hold the helper's wiring to them and the desktop tools' reading of the click's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readComputerHelperSources } from './support/native-helper-sources.ts';
import { NOTES, rig } from './support/desktop-kit.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const ROOT = new URL('../', import.meta.url);
const read = (p: string) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const HELPER = 'native/helper/Sources/';
const swiftTests = read('native/helper/Tests/HelperCoreTests/TakeoverClickTests.swift');
/** The body of a Swift function: from its signature to the closing brace at the signature's own indentation. */
const body = (src: string, signature: string) => {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `${signature} is there`);
  const indent = src.slice(src.lastIndexOf('\n', at) + 1, at);
  const close = src.indexOf(`\n${indent}}\n`, at);
  assert.ok(close > at, `${signature} closes`);
  return src.slice(at, close);
};

test('CM-Q01: the helper classifies its own events by its pid as well as its marker, so a re-emitted copy of its own event is never the user', () => {
  const guard = read(`${HELPER}ComputerUseHelper/InputGuard.swift`);
  assert.match(guard, /classifyInput\([\s\S]*?sourcePid: sourcePid, selfPid: Int64\(getpid\(\)\)\)/);
  const policy = read(`${HELPER}HelperCore/Policy.swift`);
  assert.match(body(policy, 'public func classifyInput('), /selfPid > 0 && sourcePid == selfPid \{ return \.own \}/);
  assert.match(swiftTests, /func testOwnPidIsOwnWithoutTheMarker\(\)/);
});

test('CM-Q02: a pointer move takes over only when it travels: echoes of own moves, reports with no motion and other processes moves do not; clicks, scrolls and keys still do', () => {
  const guard = read(`${HELPER}ComputerUseHelper/InputGuard.swift`);
  // the tap decides through the filter, and teaches it where the helper put the pointer
  assert.match(guard, /guardDecision\(kind, origin: origin, active: isActive\(\), pointer: pointer, filter: &takeover\)/);
  assert.match(guard, /if kind == \.mouse \{ takeover\.noteOwn\(event\.location, time: now\) \}/);
  const filter = read(`${HELPER}HelperCore/Takeover.swift`);
  assert.match(body(filter, 'public mutating func isTakeover('), /case \.button, \.scroll, \.drag:\s*\/\/[^\n]*\n\s*return true/);
  for (const name of [
    'testDeliberateInputAlwaysTakesOver',
    'testZeroDeltaReportIsNotATakeover',
    'testAnotherProcessesMoveIsNotATakeover',
    'testOwnEchoIsNotATakeoverButOnlyNearAndSoon',
    'testSmallDriftIsNotATakeoverButTravelIs',
    'testGuardDecisionWithTheFilter',
  ]) {
    assert.match(swiftTests, new RegExp(`func ${name}\\(\\)`), name);
  }
  // Esc is unchanged: a physical Esc aborts and is swallowed
  assert.match(
    swiftTests,
    /guardDecision\(\.escape, origin: \.physical, active: true, pointer: nil, filter: &f\), GuardDecision\(pause: \.escape, swallow: true\)/,
  );
});

test("CM-Q03: every reading of the user's idle time leaves the helper's own input out (input.idle, the brief foreground's start and its restore)", () => {
  const sources = readComputerHelperSources();
  const raw = [...sources.matchAll(/CGEventSource\.secondsSinceLastEventType\(\.hidSystemState[^)]*\)/g)];
  assert.ok(raw.length >= 3, 'the three readings');
  for (const m of raw) {
    const before = sources.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    assert.match(before, /userIdle\(hidIdle: $/, `${m[0]} goes through guardTap.userIdle`);
  }
  assert.match(swiftTests, /func testUserIdleLeavesTheHelpersOwnInputOut\(\)/);
  // pointer noise (a VM's reports, other processes' moves) is not the user being there either
  const guard = read(`${HELPER}ComputerUseHelper/InputGuard.swift`);
  assert.match(guard, /stampInput\(person: origin == \.physical && isUserPresence\(pointer\), at: now\)/);
  assert.match(swiftTests, /func testUserPresenceLeavesPointerNoiseOut\(\)/);
});

test('CM-Q04: a click is timed as a person’s, brings its window’s app forward first, presses a pressable element in an out-of-process panel, and selects a row it left unselected', () => {
  const desktop = read(`${HELPER}ComputerUseHelper/Desktop.swift`);
  const post = body(desktop, 'func postClick(');
  assert.match(post, /usleep\(clickMoveSettleMicros\)/);
  assert.match(post, /if type == down \{ usleep\(clickHoldMicros\) \}/);
  assert.match(post, /if i > 1 \{ usleep\(clickGapMicros\) \}/);
  // the background (app-scoped) click is timed the same way
  const app = body(readComputerHelperSources(), 'func appClick(');
  assert.match(app, /usleep\(clickMoveSettleMicros\)[\s\S]*if type == down \{ usleep\(clickHoldMicros\) \}/);
  const helper = read(`${HELPER}ComputerUseHelper/Helper.swift`);
  assert.match(helper, /return try click\(at: p, button: button, count: int\(params\["count"\]\) \?\? 1, flags: flags, owner: owner\)/);
  const click = body(helper, 'private func click(');
  assert.match(click, /if let pid = plan\.activatePid \{ out\["activated"\] = activateForClick\(pid\) \}/);
  assert.match(click, /pressInsteadOfClick\(plan: plan, plain: plain, hit: info\?\.hit\), axPress\(el\)/);
  assert.match(click, /selectAfterClick\(plain: plain, hit: info\?\.hit, selectedAfter: isSelected\(row\)\)/);
  // Esc or a take-over on the way stops it before anything lands, and before the selection after it
  const checks = [...click.matchAll(/isActive/g)].map((m) => m.index ?? 0);
  assert.equal(checks.length, 2);
  assert.ok(checks[0] < click.indexOf('axPress(el)') && checks[0] > click.indexOf('activateForClick'));
  assert.ok(checks[1] > click.indexOf('postClick(') && checks[1] < click.indexOf('selectAfterClick('));
  // the hit test looks through MoPilot's overlay, as the policy check does
  const desktop2 = read(`${HELPER}ComputerUseHelper/Desktop.swift`);
  assert.match(body(desktop2, 'func elementAt('), /axHit\(at: p, owner: windowOwner\(at: p\)\)/);
  assert.match(body(desktop2, 'func targets(at p: CGPoint)'), /axHit\(at: p, owner: owner\)/);
  // the activation and the press come before the posted click; the selection after it
  assert.ok(click.indexOf('activateForClick') < click.indexOf('postClick('));
  assert.ok(click.indexOf('axPress(el)') < click.indexOf('postClick('));
  assert.ok(click.indexOf('postClick(') < click.indexOf('selectAfterClick('));
  for (const name of [
    'testActivatesARegularOwnerThatIsNotInFront',
    'testRemoteViewIsAnElementOfAnotherProcess',
    'testPressInsteadOfClickOnlyInARemoteViewOnAPressableElement',
    'testSelectAfterAClickThatDidNotSelectTheRow',
  ]) {
    assert.match(swiftTests, new RegExp(`func ${name}\\(\\)`), name);
  }
});

test('CM-Q05: desktop_left_click reports a click the helper finished through accessibility as confirmed on route ax, and an app that did not come forward', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.click = async () => ({ ok: true, route: 'global', fallback: 'select' });
  assert.deepEqual(await r.json('desktop_left_click', { coordinate: [100, 50] }), {
    action: 'left_click',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    fallback: 'select',
  });
  r.helper.click = async () => ({ ok: true, route: 'ax', fallback: 'press', activated: true });
  assert.deepEqual(await r.json('desktop_left_click', { coordinate: [100, 50] }), {
    action: 'left_click',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    fallback: 'press',
  });
  r.helper.click = async () => ({ ok: true, route: 'global', activated: false });
  assert.deepEqual(await r.json('desktop_double_click', { coordinate: [100, 50] }), {
    action: 'double_click',
    effect: 'unverifiable',
    route: 'global',
    app: 'Notes',
    activated: false,
  });
  // an older helper's answer, or none: posted, nothing to confirm it
  for (const answer of [{ ok: true }, { ok: true, fallback: 'other' }, undefined]) {
    r.helper.click = async () => answer;
    assert.deepEqual(await r.json('desktop_left_click', { coordinate: [100, 50] }), {
      action: 'left_click',
      effect: 'unverifiable',
      route: 'global',
      app: 'Notes',
    });
  }
});
