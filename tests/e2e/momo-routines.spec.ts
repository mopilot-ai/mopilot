// MoMo's routines made in the app (#2285), on fake harnesses only, for an invited account (MOPILOT_MOMO_DEV=1): the starter
// routines the first run queues (#2607) wait as cards marked "Needs your approval" under Settings › MoMo › Routines once setup is done; MoMo's
// main chat proposes a routine with momo_routine_propose (the fake harness calls the tool) and is told the user approves it
// in Settings › MoMo › Routines; both wait there with when they run and what they do, Approve makes one a routine, Decline takes
// the other away, and the approved one is paused, resumed and edited (#2293). At the time chosen in its edit form the routine
// runs on the fake harness and its result reaches MoMo's Chat as a message from MoMo.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoSettings, momoChat, momoChatSession, momoNav, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const PROPOSE = {
  name: 'Files check',
  prompt: 'Tell me if anything in my Files folder changed.',
  time: '09:00',
  sources: ['files'],
};

function journey(harnesses: 'claude' | 'codex') {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    // a real Codex sign-in leaves auth.json behind, which is how the pool lists the CLI's login as "default"
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, seed: { files: (d) => codexCliLogin(d) } });

    test('a starter from setup and a routine MoMo proposes wait for approval; Approve makes one a routine, Decline takes the other away; its result comes to Chat', async ({
      page,
      harness,
    }) => {
      test.setTimeout(240_000);
      // the first run (Meet, Connect, Setting up) queues the starter routines (Week ahead, Bill reminders; the Morning briefing starter is no longer proposed: the brief is its own setting) and MoMo greets
      await openMomo(page);
      await expect(momoNav(page).getByRole('button', { name: 'Chat', exact: true })).toBeVisible();
      // the greeting is answered before the next message goes in
      await expect(
        momoChat(page)
          .getByText(new RegExp(`${harnesses === 'claude' ? 'fake-claude' : 'fake-codex'}: `))
          .first(),
      ).toBeVisible({
        timeout: 30_000,
      });

      // MoMo's main chat proposes a routine: the fake harness calls the tool, and the result says what happens next
      const { chat, send } = await momoChatSession(page);
      await send(`CUCALL momo_routine_propose ${JSON.stringify(PROPOSE)}`);
      await expect(
        chat.getByText(
          /Proposed the routine “Files check”.*waits in Settings › MoMo › Routines and runs only after the user approves it there/,
        ),
      ).toBeVisible({ timeout: 30_000 });

      // Settings › MoMo › Routines: both wait for approval, each a card with when it runs and, behind a disclosure, what it does
      await goToMomoSettings(page, 'Routines');
      const card = (name: string) => page.getByRole('region', { name, exact: true });
      const files = card('Files check');
      const starter = card('Week ahead');
      const WAITING = 'Needs your approval';
      await expect(files).toBeVisible({ timeout: 15_000 });
      await expect(files.getByText(WAITING)).toBeVisible();
      await expect(files).toContainText('Uses');
      await expect(files).toContainText('Files');
      await files.getByText('What MoMo will do').click();
      await expect(files).toContainText('Tell me if anything in my Files folder changed.');
      await expect(starter.getByText(WAITING)).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('settings-momo-routines-waiting.png') });

      // Approve: the same card is now a routine (no longer waiting), with when it runs
      await files.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect(files.getByText(WAITING)).toHaveCount(0);
      const routine = files;
      await expect(routine).toContainText('Every day at 9:00 AM');

      // Decline the starter: gone
      await starter.getByRole('button', { name: 'Decline', exact: true }).click();
      await expect(starter).toHaveCount(0);

      // Pause shows it as Paused; Resume brings its schedule back
      await routine.getByRole('button', { name: 'Pause', exact: true }).click();
      await expect(routine).toContainText('Paused');
      await page.screenshot({ path: test.info().outputPath('settings-momo-routines-paused.png') });
      await routine.getByRole('button', { name: 'Resume', exact: true }).click();
      await expect(routine).toContainText('Every day at 9:00 AM');

      // Edit: a new time and a second source, saved and shown
      await routine.getByRole('button', { name: 'Edit', exact: true }).click();
      const form = routine.getByRole('form', { name: 'Edit Files check' });
      await form.getByLabel('Time').fill('10:30');
      await form.getByRole('checkbox', { name: 'Calendar' }).check();
      await form.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(form).toHaveCount(0);
      await expect(routine).toContainText('Every day at 10:30 AM');
      await page.screenshot({ path: test.info().outputPath('settings-momo-routines-listed.png') });

      // its time a minute or two ahead: the scheduler runs it on the fake harness and its result reaches MoMo's Chat as a message from MoMo
      await page.evaluate(async () => {
        await (window as any).native.momoPrefs.set('routines.quietHours', null);
      });
      const at = new Date(Date.now() + 70_000);
      await routine.getByRole('button', { name: 'Edit', exact: true }).click();
      const again = routine.getByRole('form', { name: 'Edit Files check' });
      await again.getByLabel('Time').fill(`${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`);
      await again.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(again).toHaveCount(0);
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Period' : 'Control+Period');
      await expect(momoNav(page)).toBeVisible();
      await momoNav(page).getByRole('button', { name: 'Chat', exact: true }).click();
      // the app's scheduler has no timer under test: it checks on each nudge, on the real clock
      const result = momoChat(page).getByText(/“Files check” finished/);
      await expect
        .poll(
          async () => {
            await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(0));
            return result.count();
          },
          { timeout: 180_000, intervals: [5_000] },
        )
        .toBeGreaterThan(0);
    });
  });
}

journey('claude');
journey('codex');
