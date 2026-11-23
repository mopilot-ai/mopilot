// Open completed tool work for an E2E prompt whose text is unique in the transcript, without touching other turns.
import type { Page } from '@playwright/test';

/** The caller has observed this unique prompt's reply; repeated prompt text requires a separately captured turn identity. */
export async function openCompletedTurnWork(page: Page, message: string) {
  const turn = page
    .getByRole('main')
    .locator('.turn')
    .filter({ has: page.getByText(message, { exact: true }) });
  // Resolve the turn strictly before finding its header: two matching turns must not select the only completed one.
  await turn.waitFor({ state: 'visible' });
  const worked = turn.getByRole('button', { name: /^Worked for/ });
  // Claude's reply can be visible while it still runs. Wait for this turn's completed header, not an older turn's.
  await worked.waitFor({ state: 'visible' });
  if (!/\bopen\b/.test((await worked.getAttribute('class')) ?? '')) await worked.click();
  return turn;
}
