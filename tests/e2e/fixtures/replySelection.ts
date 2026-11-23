// Select one completed reply in the main transcript without racing its turn's final render.
import type { Page } from '@playwright/test';

/** Use text unique to an assistant reply. A copy attached to a later user message does not count. */
export async function selectCompletedReply(page: Page, text: string) {
  const turn = page
    .getByRole('main')
    .locator('.main-content .turn')
    .filter({ has: page.locator('.assistant-message').getByText(text, { exact: true }) });
  // Resolve ownership before checking completion: another turn's actions must never satisfy this wait.
  await turn.waitFor({ state: 'visible' });
  // TurnView renders this shared response action only after !running && final, including replies without tool work.
  await turn.getByRole('button', { name: 'Fork chat from here', exact: true }).waitFor({ state: 'visible' });
  const reply = turn.locator('.assistant-message').getByText(text, { exact: true });
  // Visibility does not mean the reply intersects the transcript viewport. The toolbar needs an on-screen line.
  await reply.scrollIntoViewIfNeeded();
  // Scrolling may rerender a windowed turn: resolve the locator again instead of retaining its old DOM node.
  await reply.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}
