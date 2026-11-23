// MoMo's writes to Calendar and Reminders (#2139 P5), on the fake computer-use helper's EventKit and fake harnesses: a source at Read only
// never writes and shows no card; Settings › MoMo › Sources › Details › Allow changes sets Read & ask to change; the write then asks on
// the approval card with exactly the event or reminder that will be written; Allow once writes it (the helper got that item), Deny and
// a changed source write nothing; the same event asks again, Allow for this chat does not ask for that exact item twice and a different
// title asks again; Undo removes only what MoMo made. On Claude Code the tools reach MoMo's chat while its session has no built-in tools
// (`--tools ""`), through the registry, the same as on Codex.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { goToMomoSettings, goToMomoView, momoChatSession, momoSeed, momoSetupDone, openMomo } from './fixtures/momo';

// needs a Mac: the harness reaches MoPilot's tools through sage-mcp, which builds only on macOS, and MoMo writes through the macOS helper
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const EVENT = 'CUCALL momo_calendar_create_event {"title":"Dentist","start":"2026-11-12T15:00","end":"2026-11-12T16:00"}';
/** Settings replaces MoMo's navigation: Back to app returns to MoMo, and its Chat is one click away again. */
const backToChat = async (page: Page) => {
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  return momoChatSession(page);
};
const section = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });

for (const harnesses of ['claude', 'codex'] as const) {
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({
      harnesses,
      computerHelper: true,
      env: { MOPILOT_MOMO_DEV: '1' },
      seed: { ...momoSetupDone, ...momoSeed(harnesses).seed },
    });

    test('Read only never writes; Allow changes asks on a card; Allow once writes, Deny does not; Undo removes only what MoMo made', async ({
      page,
      harness,
    }) => {
      const helper = harness.helper!;
      const wrote = (method: string) => helper.log.filter((l) => l.method === method);

      // connect Calendar and Reminders from Settings: both start at Read only
      await openMomo(page);
      await goToMomoSettings(page, 'Sources');
      helper.eventkit.onPrompt = 'granted';
      for (const name of ['Calendar', 'Reminders']) {
        await section(page, name).getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(section(page, name).locator('.hp-badge.ok')).toHaveText('Connected', { timeout: 20_000 });
      }
      const { chat, send } = await backToChat(page);
      const card = chat.locator('[data-kind="momoAction"]');

      // Read only: refused with no card, nothing reaches the helper
      await send(EVENT);
      await expect(chat.getByText(/Calendar is read only for MoMo, so nothing was changed/)).toBeVisible({ timeout: 30_000 });
      await expect(card).toHaveCount(0);
      expect(wrote('calendar.create')).toHaveLength(0);

      // Allow changes in Settings: the card line says what Calendar can now do
      await goToMomoSettings(page, 'Sources');
      const cal = section(page, 'Calendar');
      await cal.getByText('Details').click();
      await cal.getByRole('button', { name: 'Allow changes', exact: true }).click();
      await expect(cal.locator('[data-status]')).toHaveText('MoMo can read your calendar and add events after you approve.');
      await backToChat(page);

      // the card names exactly what will be written; nothing is written until it is answered
      await send(EVENT);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card.getByRole('heading')).toHaveText('Allow MoMo to change Calendar?');
      await expect(card).toContainText('Dentist — 2026-11-12 15:00–16:00');
      expect(wrote('calendar.create')).toHaveLength(0);
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect(chat.getByText(/Added to Calendar\. To undo it, call momo_undo_write with id/)).toBeVisible({ timeout: 30_000 });
      expect(wrote('calendar.create')).toHaveLength(1);
      expect(wrote('calendar.create')[0].params).toMatchObject({ title: 'Dentist', allDay: false });
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Dentist']);

      // Deny writes nothing and tells the model not to retry
      await send('CUCALL momo_calendar_create_event {"title":"Gym","start":"2026-11-13T07:00"}');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Deny', exact: true }).click();
      await expect(chat.getByText(/The user declined this, so nothing was sent\. Don't retry it/)).toBeVisible({ timeout: 30_000 });
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Dentist']);

      // Allow for this chat: that exact event does not ask again, a different title does
      await send(EVENT);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Allow for this chat', exact: true }).click();
      await expect(chat.getByText(/Added to Calendar\./)).toHaveCount(2, { timeout: 30_000 });
      await send(EVENT);
      await expect(chat.getByText(/Added to Calendar\./)).toHaveCount(3, { timeout: 30_000 });
      await expect(card).toHaveCount(0);
      await send('CUCALL momo_calendar_create_event {"title":"Dentist follow-up","start":"2026-11-12T15:00","end":"2026-11-12T16:00"}');
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Deny', exact: true }).click();
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Dentist', 'Dentist', 'Dentist']);

      // Undo removes the item MoMo made (the id comes from the write's own answer) and nothing else
      const last = await chat
        .getByText(/call momo_undo_write with id/)
        .last()
        .innerText();
      const id = /with id ([\w-]+)\./.exec(last)![1];
      helper.eventkit.items.push({ id: 'ev-theirs', title: 'Lunch' });
      await send(`CUCALL momo_undo_write {"id":"${id}"}`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toContainText('Remove “Dentist”');
      await card.getByRole('button', { name: 'Allow once', exact: true }).click();
      await expect(chat.getByText('Undone.')).toBeVisible({ timeout: 30_000 });
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Dentist', 'Dentist', 'Lunch']);
      // the same write cannot be undone twice
      await send(`CUCALL momo_undo_write {"id":"${id}"}`);
      await expect(chat.getByText(/already undone/)).toBeVisible({ timeout: 30_000 });

      // the user's own Undo in the Memory tab: no card; a removed item is left alone and the row says so
      await goToMomoView(page, 'Memory');
      const rows = page.locator('[data-write]');
      await expect(rows).toHaveCount(3, { timeout: 20_000 });
      const live = rows.filter({ hasNot: page.getByText('Undone', { exact: true }) });
      await expect(live).toHaveCount(2);
      await live.first().getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(live).toHaveCount(1, { timeout: 20_000 });
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Dentist', 'Lunch']);
      // the last Dentist was removed in Calendar meanwhile: nothing is deleted, the row says why
      helper.eventkit.items.splice(0, 1);
      await live.first().getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(live.first()).toContainText("Couldn't undo: It was changed or removed since, so it was left alone.", {
        timeout: 20_000,
      });
      expect(helper.eventkit.items.map((i) => i.title)).toEqual(['Lunch']);
      await expect(card).toHaveCount(0);

      // the tools reached this chat through the registry; on Claude Code its session has no built-in tools
      if (harnesses === 'claude') {
        const starts = (harness.claudeLog() as any[]).filter(
          (e) => e.kind === 'argv' && /[\\/]momo(?:[\\/]|$)/.test(e.cwd) && e.argv.some((a: string) => /^--(session-id|resume)=/.test(a)),
        );
        expect(starts.length).toBeGreaterThan(0);
        for (const e of starts) expect(e.argv).toContain('--tools=');
      }
    });
  });
}
