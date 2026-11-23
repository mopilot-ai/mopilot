// The goal's pill above the composer and the card it opens, as the specs read them (src/components/thread/GoalBar.tsx).
import { expect, type Page } from '@playwright/test';

/** The pill: the goal's progress ("12m", "3 turns") or where it stopped ("Paused"), the objective as its title. */
export const goalPill = (page: Page) => page.locator('.goal-pill');

/** The goal runs: only a running goal's pill has the running tone (its text is a time or a turn count). */
export const expectGoalRunning = (page: Page) => expect(goalPill(page)).toHaveAttribute('data-tone', 'running');

/** The card with the objective, its summary and the controls, opened from the pill when it is closed. */
export async function goalCard(page: Page) {
  const pill = goalPill(page);
  await expect(pill).toBeVisible();
  if ((await pill.getAttribute('aria-expanded')) !== 'true') await pill.click();
  return page.locator('.goal-card');
}
