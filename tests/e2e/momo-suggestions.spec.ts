// MoMo's suggestions in the Tasks panel's Up next (A7), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1) with `momo.tasksPanel` and `momo.suggestions` on: MoMo's chat calls momo_suggest (CUCALL) and the suggestion waits in Up next under "From your sources" with its source line, and nothing is sent until the user presses; Why? shows the reason and the first step; Add moves it to "Added by you"; Start sends its first step into MoMo's chat as the user's own message and the suggestion leaves Up next; Hide removes another.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { goToMomoView, momoChat, momoChatSession, openMomo, settingsGroup } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { tasksPanel: true, suggestions: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

const REPLY = {
  title: 'Reply to Sam about the lease',
  why: 'Sam asked on Monday and the lease ends Friday.',
  source: 'Mail: Sam, Lease renewal',
  step: 'Draft a reply to Sam about the lease',
  from: 'mail',
  ref: 'thread-lease',
  kind: 'reply',
  state: 'm1',
  cost: 'person',
  confidence: 'high',
};
const OFFSITE = {
  title: 'Plan Thursday’s offsite',
  why: 'The offsite is on your calendar and nothing is booked.',
  source: 'Calendar: Offsite, Thu 10:00',
  step: 'List what is still open for the offsite',
  from: 'calendar',
  ref: 'event-offsite',
  kind: 'prepare',
  state: 't1',
};

/** MoMo's chat calls momo_suggest with one suggestion and settles. */
async function suggest(page: Page, send: (text: string) => Promise<void>, s: object) {
  const chat = momoChat(page);
  await send(`CUCALL momo_suggest ${JSON.stringify(s)}`);
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
}

test('a suggestion waits in Up next with its source; Add keeps it, Start sends its first step into MoMo’s chat, Hide removes another', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openMomo(page);
  const { chat, send } = await momoChatSession(page);
  await expect(chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });
  await suggest(page, send, REPLY);
  await suggest(page, send, OFFSITE);

  await goToMomoView(page, 'Tasks');
  const tabs = page.getByRole('tablist', { name: 'Tasks' });
  await tabs.getByRole('tab', { name: /^Up next/ }).click();
  const reply = page.locator('[data-suggestion]').filter({ hasText: REPLY.title });
  const offsite = page.locator('[data-suggestion]').filter({ hasText: OFFSITE.title });
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(offsite).toBeVisible();
  const from = settingsGroup(page, 'From your sources');
  await expect(from.locator('[data-suggestion]')).toHaveCount(2);
  await expect(reply).toContainText(REPLY.source);
  await expect(reply.getByRole('button')).toHaveText(['Start', 'Add', 'Hide', 'Why?']);
  // showing them sent nothing: MoMo's chat has no Start message
  await page.screenshot({ path: test.info().outputPath('momo-suggestions-up-next.png') });

  // Why? answers "why did you tell me this?"
  await reply.getByRole('button', { name: `Why ${REPLY.title}`, exact: true }).click();
  await expect(page.locator('[data-suggestion-why]')).toContainText(REPLY.why);
  await expect(page.locator('[data-suggestion-why]')).toContainText(`First step: ${REPLY.step}`);
  await expect(page.locator('[data-suggestion-why]')).toContainText('Ranked on:');

  // Add keeps it as the user's own task, with Start and Hide
  await reply.getByRole('button', { name: `Add ${REPLY.title}`, exact: true }).click();
  const added = settingsGroup(page, 'Added by you');
  await expect(added.locator('[data-suggestion]').filter({ hasText: REPLY.title })).toBeVisible();
  await expect(from.locator('[data-suggestion]')).toHaveCount(1);
  await expect(reply.getByRole('button', { name: /^Add / })).toHaveCount(0);

  // Hide removes the other for good
  await offsite.getByRole('button', { name: `Hide ${OFFSITE.title}`, exact: true }).click();
  await expect(offsite).toHaveCount(0, { timeout: 15_000 });

  // Start is the user's press: the first step goes into MoMo's chat as their message and the suggestion leaves Up next
  await reply.getByRole('button', { name: `Start ${REPLY.title}`, exact: true }).click();
  await expect(momoChat(page)).toBeVisible({ timeout: 15_000 });
  await expect(momoChat(page).getByText(`First step: ${REPLY.step}`).first()).toBeVisible({ timeout: 30_000 });
  await goToMomoView(page, 'Tasks');
  await tabs.getByRole('tab', { name: /^Up next/ }).click();
  await expect(page.locator('[data-suggestion]')).toHaveCount(0);
  await expect(page.getByText('Nothing queued. Suggestions from your sources show here.')).toBeVisible();
});
