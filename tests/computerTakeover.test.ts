// The computer_* tools while the user has taken over the desktop (#1902, #1905): input waits for "Done, continue", an action
// the helper's guard cut short says the user took over, and an Allow on the chat's card hands the desktop back first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { make, ctx } from './support/computer-tools-kit.ts';
import { waitFor } from './support/waitFor.ts';

/** Waits (a few event-loop turns at a time) until `f()` holds. */
async function until(f: () => boolean) {
  await waitFor(f, 'the condition');
  assert.ok(f(), 'the condition never held');
}

test('a take-over during the action: the bar shows it, the call waits for Done, continue, then says the user took over (#1905)', async () => {
  const keys: string[] = [];
  let fail: any = { reason: 'paused', message: 'paused by the user (takeover); resume first' };
  const { by, activity, cu } = make({
    helper: {
      key: async (k: string) => {
        if (fail) {
          const e = fail;
          fail = null;
          throw e;
        }
        keys.push(k);
      },
    },
  });
  const cut = by.computer_key({ key: 'a' }, ctx);
  await until(() => cu.takeover.is('c'));
  assert.deepEqual(activity.at(-1), ['c', { app: 'B', state: 'takeover' }]);
  // input that starts during the take-over waits for the hand back, then runs on what is there
  const next = by.computer_key({ key: 'b' }, ctx);
  await until(() => cu.takeover.waiters.size === 2);
  assert.deepEqual(keys, []);
  assert.equal(await cu.resume('c'), true);
  assert.deepEqual(activity.at(-1), ['c', { app: 'B', state: 'active' }]);
  await assert.rejects(
    cut,
    (e: any) =>
      e.code === 'changed' && /^The user took over the mouse and keyboard and handed it back\. Nothing more was done/.test(e.message),
  );
  await next;
  assert.deepEqual(keys, ['b']);
  // the guard's own notice came before the action's failure: the take-over is not begun again
  const n = activity.length;
  fail = { reason: 'aborted', message: 'aborted by the user before the click' };
  const notice = cu.helper.key;
  cu.helper.key = async (k: string) => {
    cu.paused('takeover');
    return notice(k);
  };
  const again = by.computer_key({ key: 'c' }, ctx);
  await until(() => cu.takeover.waiters.size === 1);
  await cu.resume('c');
  await assert.rejects(again, (e: any) => e.code === 'changed');
  assert.equal(activity.length, n + 2, 'the notice and the hand back');
});

test('a take-over: Esc, another chat holding, Stop, the turn ending and the cap end it as they should', async () => {
  const paused = { reason: 'paused', message: 'paused by the user (takeover); resume first' };
  // Esc paused the helper: the call fails at once, as paused
  const esc = make({
    helper: {
      key: async () => {
        throw { reason: 'paused', message: 'paused by the user (escape); resume first' };
      },
    },
  });
  await assert.rejects(esc.by.computer_key({ key: 'a' }, ctx), (e: any) => e.code === 'paused');
  assert.equal(esc.cu.takeover.is('c'), false);
  // the desktop went to another chat before the failure came back: nothing to show or wait for
  const other = make({
    helper: {
      key: async () => {
        other.cu.controlling = 'other';
        throw paused;
      },
    },
  });
  await assert.rejects(other.by.computer_key({ key: 'a' }, ctx), (e: any) => e.code === 'paused');
  assert.equal(
    other.activity.some((a: any) => a[1]?.state === 'takeover'),
    false,
  );
  // Stop, the turn's end (release) and an aborted call end the wait
  for (const how of ['stop', 'release', 'abort'] as const) {
    const r = make({
      helper: {
        key: async () => {
          throw paused;
        },
      },
    });
    const ac = new AbortController();
    const waiting = r.by.computer_key({ key: 'a' }, { chatId: 'c', signal: ac.signal });
    await until(() => r.cu.takeover.waiters.size === 1);
    if (how === 'stop') await r.cu.stop('c');
    else if (how === 'release') await r.cu.release('c');
    else ac.abort();
    await assert.rejects(waiting, (e: any) => /Stopped/.test(e.message), how);
    assert.equal(r.cu.takeover.waiters.size, 0, how);
  }
  // nobody hands it back: busy, with how to continue
  const cap = make({
    takeoverWaitMs: 5,
    helper: {
      key: async () => {
        throw paused;
      },
    },
  });
  await assert.rejects(
    cap.by.computer_key({ key: 'a' }, ctx),
    (e: any) => e.code === 'busy' && /hasn't handed them back\. Ask them to click "Done, continue"/.test(e.message),
  );
});

test("an Allow on the chat's card while the user has taken over hands the desktop back first (#1902)", async () => {
  const { by, cu, calls, asked } = make({ answer: { decision: 'allow', scope: 'once', level: 'full' }, grants: [] });
  cu.controlling = 'c';
  cu.paused('takeover');
  await by.computer_click({ x: 2, y: 2 }, ctx);
  assert.equal(asked.length, 1);
  const names = calls.map((c) => c[0]);
  assert.ok(names.indexOf('resume') >= 0 && names.indexOf('resume') < names.indexOf('click'), names.join());
  assert.equal(cu.takeover.is('c'), false);
  // an action that can't be undone: the confirm card's Allow does it too
  const r = make();
  r.cu.controlling = 'c';
  r.cu.paused('takeover');
  await r.by.computer_key({ key: 'cmd+delete' }, ctx);
  assert.equal(r.asked.at(-1)?.[1], 'computerConfirm');
  assert.equal(r.calls.filter((c) => c[0] === 'resume').length, 1);
  // not taken over: nothing to hand back
  await r.by.computer_key({ key: 'cmd+delete' }, ctx);
  assert.equal(r.calls.filter((c) => c[0] === 'resume').length, 1);
});

test('the helper exiting while input waits on a take-over: the wait ends with the helper stopped', async () => {
  const { cu } = make();
  cu.helperExited(); // nobody holds the desktop: nothing to end
  cu.controlling = 'c';
  cu.paused('takeover');
  const waiting = cu.takeover.wait('c', null);
  cu.helperExited();
  await assert.rejects(waiting, (e: any) => e.code === 'unavailable' && /helper stopped/.test(e.message));
  assert.deepEqual([cu.controlling, cu.takeover.is('c')], [null, false]);
});

test('while taken over, the strip keeps Done, continue: moving to another app, a screen read and the glow leave it (#1896)', async () => {
  const { by, cu, calls, activity } = make();
  cu.controlling = 'c';
  cu.app = 'Other';
  cu.paused('takeover');
  const n = activity.length;
  const waiting = by.computer_key({ key: 'a' }, ctx);
  await until(() => cu.takeover.waiters.size === 1);
  // no glow while the user has the screen
  assert.equal(calls.filter((c) => c[0] === 'glowStart').length, 0);
  // a text read (OCR) while taken over does not swap the strip
  assert.equal(await cu.reading('c', { name: 'B' }, { text: true }, async () => 'read'), 'read');
  // taking the desktop for another app does not swap it either
  await cu.control('c', { name: 'B' });
  assert.equal(activity.length, n);
  await cu.resume('c');
  await waiting;
  assert.equal(calls.filter((c) => c[0] === 'glowStart').length, 1);
});
