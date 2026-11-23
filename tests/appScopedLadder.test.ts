// electron/capabilities/tools/appScopedLadder.cjs and the ladder in appScopedActions.cjs: background first, a brief
// foreground retry when nothing changed, the rung remembered per app, the setting and tier gates, and off-Space or
// minimized windows handled instead of refused. The same tools serve Codex, Claude Code and ACP sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { helperFailure, rig, rejects } from './support/app-scoped-kit.ts';

const require = createRequire(import.meta.url);
const L = require('../electron/capabilities/tools/appScopedLadder.cjs');

function ladder(o: { allowed?: boolean; rungs?: Record<string, string> } = {}) {
  const rungs: Record<string, string> = { ...o.rungs };
  const remembered: any[] = [];
  return {
    rungs,
    remembered,
    on: o.allowed !== false,
    allowed() {
      return this.on;
    },
    rung: (bundleId: string, action: string) => rungs[`${bundleId.toLowerCase()}:${action}`] ?? 'background',
    remember(app: any, action: string, rung: string) {
      remembered.push([app.bundleId, action, rung]);
      rungs[`${app.bundleId.toLowerCase()}:${action}`] = rung;
      return true;
    },
  };
}

const noChange = { verify: { effect: 'no_change' } };

test('pure helpers: gates, escalation, success, window-state refusals, notes and records', () => {
  const on = { allowed: () => true };
  assert.equal(L.mayForeground(on, { tier: 'full' }, 'type'), true);
  assert.equal(L.mayForeground(on, { tier: 'click' }, 'click'), false);
  assert.equal(L.mayForeground(on, { tier: 'full' }, 'scroll'), false);
  assert.equal(L.mayForeground(on, { tier: 'full' }, 'file_panel'), true);
  assert.equal(L.mayForeground({ allowed: () => false }, { tier: 'full' }, 'key'), false);
  assert.equal(L.NO_LADDER.allowed(), false);
  assert.equal(L.NO_LADDER.rung('x', 'type'), 'background');
  assert.equal(L.NO_LADDER.remember({ bundleId: 'x' }, 'type', 'foreground'), false);
  assert.deepEqual(
    ['no_change', 'ineffective', 'confirmed', 'unverifiable'].map((effect) => L.needsEscalation({ effect })),
    [true, true, false, false],
  );
  assert.equal(L.needsEscalation(undefined), false);
  assert.deepEqual(
    ['confirmed', 'unverifiable', 'no_change'].map((effect) => L.foregroundWorked({ effect })),
    [true, true, false],
  );
  assert.equal(L.foregroundWorked(null), false);
  assert.equal(L.windowStateRefusal({ message: 'unsupported(minimized): x' }), 'minimized');
  assert.equal(L.windowStateRefusal({ message: 'unsupported(app_hidden): x' }), 'app_hidden');
  assert.equal(L.windowStateRefusal({ message: 'unsupported(off_space): x' }), 'off_space');
  assert.equal(L.windowStateRefusal({ message: 'unsupported(menu): x' }), null);
  assert.equal(L.windowStateRefusal(null), null);
  assert.equal(
    L.foregroundNote('TextEdit', 'type'),
    'TextEdit needs brief foreground for typing: it was brought to the front for this action, then the previous app and pointer were restored.',
  );
  assert.equal(
    L.foregroundNote('X', 'zap', { userTookOver: true }),
    'X needs brief foreground for zap: it was brought to the front for this action.',
  );
  assert.deepEqual(L.laddered({ effect: 'confirmed' }, 'background'), { effect: 'confirmed', rung: 'background' });
  assert.deepEqual(L.laddered({ effect: 'confirmed' }, 'foreground', { from: 'no_change', note: 'n' }), {
    effect: 'confirmed',
    rung: 'foreground',
    background_effect: 'no_change',
    ladder: 'n',
  });
  assert.match(L.laddered({}, 'foreground', { fg: { userTookOver: true } }).ladder, /^The user used the mouse/);
  assert.match(L.laddered({}, 'foreground', { note: 'n', fg: { userTookOver: true } }).ladder, /^n The user used/);
});

test('typing that changed nothing goes up to a brief foreground, which is remembered for the app and used first next time', async () => {
  const l = ladder();
  const r = rig({ apps: { ladder: l } });
  await r.shoot();
  let n = 0;
  r.helper.answers['app.setText'] = (p: any) =>
    p.foreground
      ? { ok: true, route: 'pid', effect: 'confirmed', foreground: { activated: true, restored: true, userTookOver: false } }
      : (n++, { ok: true, route: 'ax', effect: 'confirmed', ...noChange });
  const out = await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: 'hi' });
  assert.equal(out.effect, 'confirmed');
  assert.equal(out.rung, 'foreground');
  assert.equal(out.background_effect, 'no_change');
  assert.match(out.ladder, /^Notes needs brief foreground for typing/);
  const sent = r.callsOf('app.setText').map((c: any) => [!!c.params.foreground, !!c.params.typeKeys]);
  assert.deepEqual(sent, [
    [false, false],
    [true, true],
  ]);
  assert.deepEqual(l.remembered, [['com.apple.Notes', 'type', 'foreground']]);
  // next time it starts on the remembered rung: one request, in front
  r.helper.calls.length = 0;
  const again = await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: 'yo' });
  assert.equal(again.rung, 'foreground');
  assert.equal(again.background_effect, undefined);
  assert.match(again.ladder, /then the previous app and pointer were restored/);
  assert.equal(r.callsOf('app.setText').length, 1);
  assert.equal(n, 1);
});

test('a background success says so; the setting off, a weaker tier or another action never escalate', async () => {
  const l = ladder();
  const r = rig({ apps: { ladder: l } });
  await r.shoot();
  assert.equal((await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: 'a' })).rung, 'background');
  r.helper.answers['app.setText'] = () => ({ ok: true, route: 'ax', effect: 'confirmed', ...noChange });
  l.on = false;
  const off = await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: 'a' });
  assert.equal(off.effect, 'no_change');
  assert.equal(off.rung, undefined);
  assert.equal(r.callsOf('app.setText').filter((c: any) => c.params.foreground).length, 0);
  l.on = true;
  // a scroll that changed nothing stays a background result
  r.helper.answers['app.scroll'] = () => ({ ok: true, route: 'pid', ...noChange });
  assert.equal((await r.record('desktop_app_scroll', { app: 'Notes', element_index: 2, dy: 2 })).effect, 'no_change');
  assert.equal(r.callsOf('app.scroll').length, 1);
  // Terminal is granted for clicks only: no brief foreground there
  const t = rig({ apps: { ladder: ladder() } });
  t.helper.answers['app.windows'] = () => ({ app: { pid: 9 }, windows: [{ window_id: 5, title: 'T', state: 'visible', bounds: {} }] });
  await t.shoot('com.apple.Terminal');
  t.helper.answers['app.click'] = () => ({ ok: true, route: 'pid', ...noChange });
  const click = await t.record('desktop_app_click', { app: 'Terminal', coordinate: [990, 790] });
  assert.equal(click.effect, 'no_change');
  assert.equal(t.callsOf('app.click').length, 1);
});

test('a click the app ignored is retried as a real click at its point in front; a focused press keeps the press', async () => {
  const l = ladder();
  const r = rig({ apps: { ladder: l } });
  await r.shoot();
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'ax', center: { x: 1, y: 1 }, ...noChange });
  r.helper.answers['app.click'] = (p: any) => ({ ok: true, route: 'pid', ...(p.foreground ? { verify: { effect: 'confirmed' } } : {}) });
  const out = await r.record('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.deepEqual([out.effect, out.rung, out.background_effect], ['confirmed', 'foreground', 'no_change']);
  assert.deepEqual([r.last('app.click').x, r.last('app.click').y, r.last('app.click').foreground], [130, 70, true]);
  // remembered for clicks: a focused click goes straight to a press in front
  r.helper.calls.length = 0;
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'ax' });
  const f = await r.record('desktop_app_click', { app: 'Notes', target: 'focused' });
  assert.equal(f.rung, 'foreground');
  assert.equal(r.last('app.press').foreground, true);
});

test('brief foreground that is refused, or that does not help, is reported with the background result', async () => {
  const r = rig({ apps: { ladder: ladder() } });
  await r.shoot();
  r.helper.answers['app.key'] = (p: any) => {
    if (p.foreground) throw helperFailure('unsupported', 'unsupported(user_active): the user is using the mouse or keyboard');
    return { ok: true, route: 'pid', effect: 'unverifiable', ...noChange };
  };
  const busy = await r.record('desktop_app_key', { app: 'Notes', element_index: 2, combo: 'return' });
  assert.deepEqual([busy.effect, busy.rung], ['no_change', 'background']);
  assert.match(busy.ladder, /Brief foreground was not used: unsupported\(user_active\)/);
  r.helper.answers['app.key'] = (p: any) => ({
    ok: true,
    route: 'pid',
    effect: 'unverifiable',
    ...noChange,
    ...(p.foreground ? { foreground: { userTookOver: true } } : {}),
  });
  const still = await r.record('desktop_app_key', { app: 'Notes', element_index: 2, combo: 'return' });
  assert.deepEqual([still.effect, still.rung, still.background_effect], ['no_change', 'foreground', 'no_change']);
  assert.match(still.ladder, /didn't help either.*The user used the mouse or keyboard/);
});

test('a minimized or hidden window comes back to the current desktop and the action goes on, with or without the ladder', async () => {
  for (const [state, word] of [
    ['minimized', 'minimized'],
    ['app_hidden', 'hidden with its app'],
  ]) {
    const r = rig();
    await r.shoot();
    let refused = false;
    r.helper.answers['app.click'] = () => {
      if (!refused) {
        refused = true;
        throw helperFailure('unsupported', `unsupported(${state}): call app_bring_to_current_space first`);
      }
      return { ok: true, route: 'pid' };
    };
    const out = await r.record('desktop_app_click', { app: 'Notes', coordinate: [990, 790] });
    assert.equal(out.effect, 'unverifiable');
    assert.match(out.window_note, new RegExp(`was ${word}; MoPilot brought it back`));
    assert.deepEqual(
      r.helper.calls.map((c: any) => c.method),
      ['app.click', 'app.bringToCurrentSpace', 'app.click'],
    );
    assert.equal(r.last('app.bringToCurrentSpace').windowId, 5);
  }
});

test('a window on another Space takes the brief-foreground rung when allowed; otherwise the refusal stands', async () => {
  const offSpace = (p: any) => {
    if (!p.foreground) throw helperFailure('unsupported', 'unsupported(off_space): the window is on another Space');
    return { ok: true, route: 'pid', foreground: p.tookOver ? { userTookOver: true } : { userTookOver: false } };
  };
  const l = ladder();
  const r = rig({ apps: { ladder: l } });
  await r.shoot();
  r.helper.answers['app.scroll'] = offSpace;
  const out = await r.record('desktop_app_scroll', { app: 'Notes', coordinate: [990, 790], dy: 1 });
  assert.equal(out.rung, 'foreground');
  assert.match(out.ladder, /was on another Space.*then the previous app was restored\.$/);
  r.helper.answers['app.scroll'] = (p: any) => offSpace({ ...p, tookOver: true });
  const took = await r.record('desktop_app_scroll', { app: 'Notes', coordinate: [990, 790], dy: 1 });
  assert.match(took.ladder, /macOS showed its Space\)\. The user used/);
  l.on = false;
  await rejects(r.call('desktop_app_scroll', { app: 'Notes', coordinate: [990, 790], dy: 1 }), 'unsupported', /off_space/);
  // other refusals are not about the window: they stand
  r.helper.answers['app.scroll'] = () => {
    throw helperFailure('unsupported', 'unsupported(sheet): a sheet');
  };
  await rejects(r.call('desktop_app_scroll', { app: 'Notes', coordinate: [990, 790], dy: 1 }), 'unsupported', /sheet/);
});

test('a coordinate click of a brief-foreground app asks the helper for the real-pointer route if the app is in front, and a result from it ends the ladder; a press, a click without the setting and the others do not ask', async () => {
  // the helper answers a click for an app in front through its brief-foreground path (`foreground` in the result): nothing higher to try, whatever the effect
  for (const effect of ['confirmed', 'no_change']) {
    const r = rig({ apps: { ladder: ladder() } });
    await r.shoot();
    r.helper.answers['app.click'] = () => ({
      ok: true,
      route: 'hid',
      foreground: { activated: false, restored: true, userTookOver: false },
      verify: { effect },
    });
    const out = await r.record('desktop_app_click', { app: 'Notes', coordinate: [130, 70] });
    assert.equal(r.callsOf('app.click').length, 1, `${effect}: no second request`);
    assert.equal(r.last('app.click').ifFrontmost, true);
    assert.deepEqual([out.effect, out.rung], [effect, 'foreground']);
  }
  // an app not in front: the helper posts to its process and answers with no foreground; the ladder goes on as before
  const b = rig({ apps: { ladder: ladder() } });
  await b.shoot();
  b.helper.answers['app.click'] = (p: any) => ({
    ok: true,
    route: p.foreground ? 'hid' : 'pid',
    ...(p.foreground ? { verify: { effect: 'confirmed' } } : noChange),
  });
  const back = await b.record('desktop_app_click', { app: 'Notes', coordinate: [130, 70] });
  assert.deepEqual([back.effect, back.rung], ['confirmed', 'foreground']);
  assert.equal(b.callsOf('app.click').length, 2);
  // an AX press is not asked for the real pointer
  const p = rig({ apps: { ladder: ladder() } });
  await p.shoot();
  p.helper.answers['app.press'] = () => ({ ok: true, route: 'ax' });
  await p.record('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.equal(p.last('app.press').ifFrontmost, undefined);
  // without the setting there is no higher rung to ask for
  const off = rig({ apps: { ladder: ladder({ allowed: false }) } });
  await off.shoot();
  off.helper.answers['app.click'] = () => ({ ok: true, route: 'pid', ...noChange });
  await off.record('desktop_app_click', { app: 'Notes', coordinate: [130, 70] });
  assert.equal(off.last('app.click').ifFrontmost, undefined);
});

test('a coordinate click of an app in front whose real-pointer route the helper refuses (the user is at the mouse, the screen is locked) falls back to the plain background click, and a refusal of that one too still ends it', async () => {
  for (const refusal of [
    'unsupported(user_active): the user is using the mouse or keyboard; the app wasn’t brought forward',
    'refused: the locked screen',
  ]) {
    const r = rig({ apps: { ladder: ladder() } });
    await r.shoot();
    const asked: boolean[] = [];
    r.helper.answers['app.click'] = (p: any) => {
      asked.push(!!p.ifFrontmost);
      if (p.ifFrontmost) throw helperFailure(refusal.startsWith('unsupported') ? 'unsupported' : 'refused', refusal);
      return { ok: true, route: 'pid', verify: { effect: 'confirmed' } };
    };
    const out = await r.record('desktop_app_click', { app: 'Notes', coordinate: [130, 70] });
    assert.deepEqual([out.effect, out.rung], ['confirmed', 'background']);
    assert.deepEqual(asked, [true, false]);
  }
  // a refusal that is neither of those still fails the click, as it did
  const other = rig({ apps: { ladder: ladder() } });
  await other.shoot();
  other.helper.answers['app.click'] = () => {
    throw helperFailure('target_refused', 'refused: target is X');
  };
  await rejects(other.call('desktop_app_click', { app: 'Notes', coordinate: [130, 70] }), 'refused', /target is X/);
  assert.equal(other.callsOf('app.click').length, 1);
});

test('foregroundRefused: only the helper’s refusals of the brief-foreground path count; anything else, an error with no message or none at all, does not', () => {
  const { foregroundRefused } = require('../electron/capabilities/tools/appScopedApproach.cjs');
  assert.equal(foregroundRefused(new Error('unsupported(user_active): the user is using the mouse')), true);
  assert.equal(foregroundRefused(new Error('refused: the locked screen')), true);
  for (const other of [new Error('refused: target is X'), new Error('unsupported(minimized): x'), {}, undefined, null])
    assert.equal(foregroundRefused(other), false);
});
