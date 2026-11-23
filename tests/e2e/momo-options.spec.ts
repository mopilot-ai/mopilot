// MoMo's answer chips (alignment row 6, PR #4971), on a fake harness for an invited account (MOPILOT_MOMO_DEV=1) with `momo.shell` on: a reply that ends with "Options: A | B | C" shows its text without that line and the chips A, B and C under it; tapping one sends its label as the user's own message and the chips go; a later turn leaves none; with prefers-reduced-motion the chips stand still. Pictures are attached to the report. No Mac-only API: it runs on Linux and macOS.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChatSession, openMomo } from './fixtures/momo';

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { shell: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

/** Opens MoMo's chat and waits until its greeting turn is over, so the next message starts its own turn. */
async function ready(page: Parameters<typeof openMomo>[0]) {
  await openMomo(page);
  const session = await momoChatSession(page);
  await expect(session.chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 60_000 });
  await expect(session.chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  return session;
}

test('a question with an Options line shows the chips, a tap answers as the user and removes them, a later turn has none', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { chat, send } = await ready(page);
  const picture = async (name: string) => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(500);
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path });
    await test.info().attach(name, { path, contentType: 'image/png' });
  };

  await send('OPTIONSREPLY please');
  const chips = chat.locator('[data-option-chips]');
  await expect(chips).toBeVisible({ timeout: 30_000 });
  await expect(chips).toHaveAttribute('aria-label', 'Suggested answers');
  await expect(chips.getByRole('button')).toHaveText(['A', 'B', 'C']);
  // the question is the reply's text, with no Options line
  const reply = chat.locator('.assistant-message', { hasText: 'Shall I move your 3 pm?' });
  await expect(reply).toBeVisible();
  await expect(chat.getByText(/Options:/)).toHaveCount(0);
  // MoMo shows no copy / like / dislike / redo row under a question that waits for its answer
  // (the question's own turn: the greeting's turn above it keeps its action row, which is not the question's)
  // (`has` is matched inside each turn, so it takes a locator from the page, not one chained from the chat region)
  const question = chat.locator('.turn', { has: page.locator('.assistant-message', { hasText: 'Shall I move your 3 pm?' }) });
  // exactly one turn: a count of 0 below must not be a locator that matches nothing
  await expect(question).toHaveCount(1);
  await expect(question.locator('.message-actions')).toHaveCount(0);
  // the spacing is the design's: 16 pt from the bubble to the pills, pills 28 pt tall, 12 pt between them (the entry has settled first)
  await page.waitForTimeout(600);
  const [bubble, a, b] = await Promise.all([
    reply.boundingBox(),
    chips.getByRole('button').nth(0).boundingBox(),
    chips.getByRole('button').nth(1).boundingBox(),
  ]);
  expect(a!.height).toBeCloseTo(28, 0);
  expect(b!.x - (a!.x + a!.width)).toBeCloseTo(12, 0);
  expect(a!.y - (bubble!.y + bubble!.height)).toBeGreaterThanOrEqual(16);
  await chips.scrollIntoViewIfNeeded();
  await picture('options-1-chips');

  // a tap sends the label as the user's own message, and the chips go with the turn it starts
  await chips.getByRole('button', { name: 'B', exact: true }).click();
  await expect(chat.locator('.user-message').getByText('B', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(chat.locator('[data-option-chips]')).toHaveCount(0, { timeout: 30_000 });
  await expect(chat.getByText(/fake-claude: B/).first()).toBeVisible({ timeout: 30_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });
  // the question's action row is back once it is answered
  await expect(question.locator('.message-actions')).toHaveCount(1);
  await picture('options-2-answered');

  // a later turn leaves no chips
  await send('Say hello');
  await expect(chat.getByText(/fake-claude: Say hello/).first()).toBeVisible({ timeout: 30_000 });
  await expect(chat.locator('[data-option-chips]')).toHaveCount(0);
});

test('with prefers-reduced-motion the chips stand still; otherwise they enter with an animation', async ({ page }) => {
  test.setTimeout(180_000);
  const { chat, send } = await ready(page);
  await send('OPTIONSREPLY one');
  const first = chat.locator('[data-option-chips] button').first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  // animation names are the CSS module's own (hashed): any name but none is the entry
  const animation = () => first.evaluate((el) => getComputedStyle(el).animationName);
  expect(await animation()).not.toBe('none');
  await chat.locator('[data-option-chips]').getByRole('button', { name: 'A', exact: true }).click();
  await expect(chat.locator('[data-option-chips]')).toHaveCount(0, { timeout: 30_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 60_000 });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await send('OPTIONSREPLY two');
  const still = chat.locator('[data-option-chips] button').first();
  await expect(still).toBeVisible({ timeout: 30_000 });
  await expect(still).toHaveCSS('animation-name', 'none');
  await expect(still).toHaveCSS('transition-duration', '0s');
});
