// The card a MoMo chat shows when a tool needs Calendar or Reminders connected (#2999), on the fake computer-use helper's EventKit and
// fake harnesses: MoMo's chat calls momo_calendar_events or momo_reminders_list before the user connected the source; a "Connect
// Calendar?" card shows in the chat; Connect shows macOS's prompt and an Allow connects at once, the card goes and the read goes on;
// a refusal given at the prompt turns the card into a neutral next step with Open System Settings (a prompt macOS never shows asks for a restart
// instead, with no pane to open),
// which opens the exact privacy pane, and the card connects by itself when the switch goes on; a pane macOS will not open says why;
// Not now tells the model not to ask again and the same chat is not asked about that source again; a routine that reads an unconnected
// source says so under it in Settings › MoMo › Routines, with the same Connect. The real prompt and pane are checked in a VM.
import type { Locator, Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { captureExternal, openedExternal, refuseExternal } from './fixtures/externalUrls';
import { goToMomoSettings, momoChatSession, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';

// needs a Mac: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS, and MoMo reads through the macOS helper
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const NEEDS_CALENDAR = 'Turn on MoPilot under Privacy & Security › Calendars.';
const NO_PROMPT_CALENDAR =
  "macOS didn't show its Calendar prompt. Restart MoPilot and Connect again; if it still doesn't appear, update MoPilot.";
const WAITING = 'Waiting for you to turn it on…';
const CALENDAR_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars';
const REMINDERS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders';
const READ_CALENDAR = 'CUCALL momo_calendar_events {}';
const NO_EVENTS = /No events in the user's Calendar/;

const cardOf = (chat: Locator) => chat.locator('[data-kind="momoConnect"]');
const line = (card: Locator) => card.locator('p').first();

/** MoMo's Chat past setup, main's pane opener recorded instead of opening System Settings (fixtures/externalUrls.ts). */
async function openChat(page: Page, harness: Pick<Harness, 'app'>) {
  await captureExternal(harness);
  await openMomo(page);
  return momoChatSession(page);
}
const panes = openedExternal;

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      computerHelper: true,
      env: { MOPILOT_MOMO_DEV: '1' },
      seed: { ...momoSetupDone, ...momoSeed(harnesses).seed },
    });

    test('never asked: the card shows, Connect shows the prompt and Allow connects; the card goes, no pane opens, and the read goes on', async ({
      page,
      harness,
    }) => {
      harness.helper!.eventkit.onPrompt = 'granted';
      const { chat, send } = await openChat(page, harness as any);
      const card = cardOf(chat);
      await send(READ_CALENDAR);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('heading')).toHaveText('Connect Calendar?');
      await expect(line(card)).toHaveText('MoMo needs it to answer this. It only reads.');
      await card.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(card).toHaveCount(0, { timeout: 20_000 });
      await expect(chat.getByText(NO_EVENTS)).toBeVisible({ timeout: 30_000 });
      expect(await panes(harness as any)).toEqual([]);
      expect(harness.helper!.log.some((l) => l.method === 'eventkit.request' && l.params.entity === 'calendar')).toBe(true);
    });
  });
}

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude', computerHelper: true, env: { MOPILOT_MOMO_DEV: '1' }, seed: { ...momoSetupDone } });

  test('a refusal at the prompt asks for the switch; Open System Settings opens the Calendars pane and the card connects by itself', async ({
    page,
    harness,
  }) => {
    harness.helper!.eventkit.onPrompt = 'denied';
    const { chat, send } = await openChat(page, harness as any);
    const card = cardOf(chat);
    await send(READ_CALENDAR);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(line(card)).toHaveText(NEEDS_CALENDAR, { timeout: 20_000 });
    // not a failure: neutral, not red
    await expect(line(card)).toHaveAttribute('data-tone', 'needs');
    expect(await panes(harness as any)).toEqual([]);
    // macOS never asks again: Open System Settings opens the exact pane, and the card says it is waiting
    await card.getByRole('button', { name: 'Open System Settings', exact: true }).click();
    await expect.poll(() => panes(harness as any)).toEqual([CALENDAR_PANE]);
    await expect(line(card)).toHaveText(WAITING);
    await expect(card.getByRole('button', { name: 'Open again', exact: true })).toBeVisible();
    // the switch goes on in System Settings: no click here, and the read goes on
    harness.helper!.eventkit.calendar = 'granted';
    await expect(card).toHaveCount(0, { timeout: 25_000 });
    await expect(chat.getByText(NO_EVENTS)).toBeVisible({ timeout: 30_000 });
  });

  test('Open System Settings that macOS will not open says why on the card, and works again once it can', async ({ page, harness }) => {
    harness.helper!.eventkit.onPrompt = 'denied';
    const { chat, send } = await openChat(page, harness as any);
    const card = cardOf(chat);
    await send(READ_CALENDAR);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(line(card)).toHaveText(NEEDS_CALENDAR, { timeout: 20_000 });
    await card.getByRole('button', { name: 'Open System Settings', exact: true }).click();
    await expect.poll(() => panes(harness as any)).toHaveLength(1);
    // main's opener now refuses (main answers { ok: false, error }): the card says so instead of staying silent
    await refuseExternal(harness, 'Failed to open URL');
    await card.getByRole('button', { name: 'Open again', exact: true }).click();
    await expect(line(card)).toContainText('Failed to open URL');
    await expect(line(card)).toHaveAttribute('data-tone', 'error');
    await refuseExternal(harness, null);
    await card.getByRole('button', { name: 'Open again', exact: true }).click();
    await expect(line(card)).toHaveText(WAITING);
  });

  test('macOS never shows its prompt: the card says so and asks for a restart, opens no pane, and Connect tries again', async ({
    page,
    harness,
  }) => {
    harness.helper!.eventkit.onPrompt = 'notDetermined';
    const { chat, send } = await openChat(page, harness as any);
    const card = cardOf(chat);
    await send(READ_CALENDAR);
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(line(card)).toHaveText(NO_PROMPT_CALENDAR, { timeout: 20_000 });
    await expect(line(card)).toHaveAttribute('data-tone', 'error');
    // an undecided source has no switch in the privacy pane, so the card offers no way there
    await expect(card.getByRole('button', { name: 'Open System Settings', exact: true })).toHaveCount(0);
    expect(await panes(harness as any)).toEqual([]);
    await expect(card.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  });

  test('already refused before: Connect opens the Reminders pane at once, the card waits, and the read goes on when access returns', async ({
    page,
    harness,
  }) => {
    harness.helper!.eventkit.reminders = 'denied';
    const { chat, send } = await openChat(page, harness as any);
    const card = cardOf(chat);
    await send('CUCALL momo_reminders_list {}');
    await expect(card.getByRole('heading')).toHaveText('Connect Reminders?', { timeout: 30_000 });
    await card.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(line(card)).toHaveText(WAITING);
    expect(await panes(harness as any)).toEqual([REMINDERS_PANE]);
    harness.helper!.eventkit.reminders = 'granted';
    await expect(card).toHaveCount(0, { timeout: 25_000 });
    await expect(chat.getByText(/No open reminders in the user's Reminders/)).toBeVisible({ timeout: 30_000 });
  });

  test('Not now tells the model not to ask again, and the same chat gets no second card for that source', async ({ page, harness }) => {
    const { chat, send } = await openChat(page, harness as any);
    const card = cardOf(chat);
    const declined = chat.getByText(/The user chose not to connect Calendar now\. Don't ask again/);
    await send(READ_CALENDAR);
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(declined).toHaveCount(1, { timeout: 30_000 });
    // asked again inside the cooldown: no card, the same answer
    await send(READ_CALENDAR);
    await expect(declined).toHaveCount(2, { timeout: 30_000 });
    await expect(card).toHaveCount(0);
    // another source is still asked
    await send('CUCALL momo_reminders_list {}');
    await expect(card.getByRole('heading')).toHaveText('Connect Reminders?', { timeout: 30_000 });
    expect(await panes(harness as any)).toEqual([]);
  });

  test('a routine that reads an unconnected source says so after Approve in Settings › MoMo › Routines, and the same Connect clears it', async ({
    page,
    harness,
  }) => {
    test.setTimeout(180_000);
    harness.helper!.eventkit.onPrompt = 'granted';
    const { chat, send } = await openChat(page, harness as any);
    await send(
      `CUCALL momo_routine_propose ${JSON.stringify({ name: 'Day ahead', prompt: 'Tell me what is on my calendar.', time: '07:30', sources: ['calendar'] })}`,
    );
    await expect(chat.getByText(/Proposed the routine “Day ahead”/)).toBeVisible({ timeout: 30_000 });
    await goToMomoSettings(page, 'Routines');
    // a proposal and the routine it becomes are the same card; Approve ends "Needs your approval"
    const routine = page.getByRole('region', { name: 'Day ahead', exact: true });
    await expect(routine).toBeVisible({ timeout: 15_000 });
    await expect(routine.getByText('Needs your approval')).toBeVisible();
    await expect(routine).toContainText('Not connected yet. After you approve, connect it here');
    await routine.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(routine.getByText('Needs your approval')).toHaveCount(0);
    // it runs on its own, nobody there to click: the line is the way to connect
    await expect(routine).toContainText('Calendar isn’t connected. This routine can’t read it yet.');
    await routine.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(routine).not.toContainText('isn’t connected', { timeout: 20_000 });
    await expect(routine.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    expect(harness.helper!.log.some((l) => l.method === 'eventkit.request' && l.params.entity === 'calendar')).toBe(true);
  });
});
