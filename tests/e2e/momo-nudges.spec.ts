// MoMo's proactive nudges (#2139 P4), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1): the user tells MoMo a
// promise with a date; once the chat goes quiet MoMo's memory pass (a data-only background chat the fake answers) keeps it
// as an open loop quoting the user's own words, shown in Memory › Open loops; the scheduler's hourly nudge check (moved on
// by the test) finds it due, the fake's decline check keeps it, and the nudge lands in MoMo's chat as MoMo's card, never as
// the user's message: Why shows the user's words, the day and the trigger; Snooze snoozes the loop, which the Memory tab
// then says; Remind me on the nudge sends MoMo an ordinary message. Screenshots of the loop, the card with its why, and the snoozed loop are saved.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChatSession, openMomo, settingsGroup } from './fixtures/momo';

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000', MOPILOT_SCHEDULER_TEST: '1' },
  // nudges at any hour of the run: no quiet hours, the high quota
  seed: { files: (d) => codexCliLogin(d), uiState: { prefs: { momo: { routines: { proactivity: 'high', quietHours: null } } } } },
});

test('a promise the user made becomes an open loop, and its nudge lands in MoMo’s chat with why, Snooze and the loop snoozed', async ({
  page,
  harness,
}) => {
  test.setTimeout(240_000);
  // on a failure, what main noted and what the fake Claude was sent for MoMo's background chats (in the run's stdout)
  const mainOut: string[] = [];
  harness.app.process().stdout?.on('data', (d) => mainOut.push(String(d)));
  harness.app.process().stderr?.on('data', (d) => mainOut.push(String(d)));
  const explain = () => {
    const sent = harness
      .claudeLog()
      .filter((l) => l.kind === 'in')
      .map((l) => JSON.stringify(l.msg))
      .filter((t) => /Read what the user|You decide whether|NOECHO/.test(t));
    console.log(`[momo-nudges] fake Claude was sent:\n${sent.map((t) => t.slice(0, 1500)).join('\n---\n')}`);
    console.log(
      `[momo-nudges] main said:\n${mainOut
        .join('')
        .split('\n')
        .filter((l) => /ignored|momo|memory|pass|loop|nudge/i.test(l))
        .slice(-80)
        .join('\n')}`,
    );
  };
  test.info().annotations.push({ type: 'diagnostics', description: 'printed on failure' });
  try {
    await journey();
  } catch (error) {
    explain();
    throw error;
  }

  async function journey() {
    await openMomo(page);
    const { chat, send } = await momoChatSession(page);
    await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });

    // the fake says "Noted." instead of echoing, so the words are in the user's message alone
    await send("NOECHO I'll call the landlord by Wednesday");
    await expect(chat.getByText('Noted.', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });

    // the memory pass runs once the chat is quiet: the loop shows in Memory › Open loops with the user's words
    await goToMomoView(page, 'Memory');
    // the pass ran: it saved the fact (the fake keeps the line as one), then the loop
    await expect(settingsGroup(page, 'Facts').getByText("I'll call the landlord by Wednesday", { exact: true })).toBeVisible({
      timeout: 90_000,
    });
    const loops = settingsGroup(page, 'Open loops');
    const loop = loops.locator('.momo-fact[data-loop]').filter({ hasText: 'call the landlord by Wednesday' });
    await expect(loop).toBeVisible({ timeout: 15_000 });
    await expect(loop.locator('.momo-loop-quote')).toContainText("“I'll call the landlord by Wednesday” · said");
    await expect(loop.locator('.momo-chip').first()).toContainText('Due ');
    await loop.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('momo-open-loop.png') });

    // the hourly nudge check, its clock moved on: the nudge lands in MoMo's chat as MoMo's card
    await goToMomoView(page, 'Chat');
    const card = chat.locator('.momo-nudge');
    await expect
      .poll(
        async () => {
          await harness.app.evaluate(() => (globalThis as any).__schedulerAdvance(3_600_000));
          return card.count();
        },
        { timeout: 120_000, intervals: [3_000] },
      )
      .toBeGreaterThan(0);
    await expect(card).toContainText('Reminder: call the landlord by Wednesday');
    // MoMo's, never the user's: no user message carries the reminder
    await expect(chat.locator('.user-message, [data-role="user"]').filter({ hasText: 'Reminder:' })).toHaveCount(0);

    await card.getByRole('button', { name: 'Why', exact: true }).click();
    const why = card.locator('.momo-nudge-why');
    await expect(why).toContainText('call the landlord by Wednesday');
    await expect(why).toContainText("“I'll call the landlord by Wednesday” · said");
    await expect(why).toContainText(/^.*due \w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    await page.screenshot({ path: test.info().outputPath('momo-nudge-why.png') });

    // Remind me writes nothing itself: it sends an ordinary message to MoMo's chat, which MoMo then acts on through the approval card
    await card.getByRole('button', { name: 'Remind me', exact: true }).click();
    await expect(chat.getByText(/Remind me about “[^”]*landlord[^”]*”/).first()).toBeVisible({ timeout: 30_000 });

    await card.getByRole('button', { name: 'Snooze', exact: true }).click();
    await expect(card.locator('.momo-nudge-actions')).toHaveText(/^Snoozed to \d{4}-\d{2}-\d{2}$/);

    // the Memory tab says it is snoozed
    await goToMomoView(page, 'Memory');
    await expect(loop.locator('.momo-chip').filter({ hasText: /^Snoozed to / })).toBeVisible();
    await expect(loop.locator('.momo-chip').filter({ hasText: 'Nudged 1×' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('momo-loop-snoozed.png') });
  }
});
