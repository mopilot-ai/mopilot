// MoMo's opt-in push body (A6), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1): Settings › MoMo › Proactivity has "Name my routine in phone alerts", off by default; turning it on is saved. In Electron's real main process, MoMo's real notice, notifier and push-request modules then show the rule: with the setting off a routine's notice carries no body; with it on, a notice an approved routine's run raised carries that routine's name in the sealed blob only, and a nudge (MoMo's main chat), a routine MoMo proposed and the user has not approved, and a chat that is no routine's carry none.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { goToMomoSettings, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });

const ROW = 'Name my routine in phone alerts';

test('the Settings row is off by default and turning it on is saved', async ({ page }) => {
  await openMomo(page);
  await goToMomoSettings(page, 'Brain');
  const row = page.locator('.settings-row').filter({ hasText: ROW });
  await row.scrollIntoViewIfNeeded();
  await expect(row).toContainText(
    'Only the name of a routine you approved, and only if Chat titles is on in your phone’s alerts. Off: “MoMo needs you”.',
  );
  const toggle = row.getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  // the phone has no switch for it: it is a Mac setting
  await page.screenshot({ path: test.info().outputPath('momo-push-body-row.png') });
});

test('a routine’s notice carries its name only after the opt-in; a nudge, an unapproved routine and any other chat never do', async ({
  harness,
}) => {
  const entry = path.resolve(__dirname, '../../electron/momo/pushBody.cjs');
  const out = await harness.app.evaluate(async (_electron, entry) => {
    const require = process.getBuiltinModule('module').createRequire(entry);
    const { createMomoPushBody, createRoutineOfChat } = require(entry);
    const { createMomoNotices } = require('./notices.cjs');
    const { Notifier } = require('../platform/notify.cjs');
    const { createPushRequests } = require('../platform/notifyPush.cjs');
    const tags: Record<string, any> = {
      run: { momo: 'routine', routineId: 'mine' },
      'proposed-run': { momo: 'routine', routineId: 'proposed' },
      main: { momo: 'main' },
      coding: {},
    };
    const routines: Record<string, any> = {
      mine: { name: 'Morning brief', approved: true, prompt: 'read my mail' },
      proposed: { name: 'Wire the money', approved: false },
    };
    const run = (momo: any) => {
      const reqs: any[] = [];
      const body = createMomoPushBody({
        allowed: () => true,
        momoPrefs: () => momo,
        routineIdOf: createRoutineOfChat({ meta: (id: string) => tags[id], openRun: () => null }),
        routine: (id: string) => routines[id],
      });
      const push = createPushRequests({
        pairs: () => ['p1'],
        sink: (r: any) => reqs.push(r),
        bodyOf: body.body,
        sealBody: (_pair: string, _ref: string, text: string) => `sealed:${text}`,
      });
      const notifier = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: push.onBanner });
      const notices = createMomoNotices({
        notifier,
        allowed: () => true,
        prefs: () => ({ momo: { routines: { quietHours: null } } }),
        open: () => undefined,
      });
      for (const chatId of ['run', 'main', 'proposed-run', 'coding']) notices.needsYou({ kind: 'chat', chatId });
      return reqs.map((r) => r.sealedBody ?? null);
    };
    return { off: run({}), on: run({ notify: { pushBody: true } }) };
  }, entry);
  // chats in order: the approved routine's run, MoMo's main chat (a nudge), the proposed routine's run, a coding chat
  expect(out.off).toEqual([null, null, null, null]);
  expect(out.on).toEqual(['sealed:Morning brief', null, null, null]);
});
