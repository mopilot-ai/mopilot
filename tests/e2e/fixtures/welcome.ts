// The welcome page (src/components/pages/Welcome.tsx) for E2E specs: its heading, an agent's row, and connecting one.
import { expect, type Page } from '@playwright/test';

export const welcomeHeading = (page: Page) => page.getByRole('heading', { name: 'Connect your coding agents' });

/** An agent's row on the welcome page, by the name it shows. */
export const agentRow = (page: Page, name: string) =>
  page
    .getByRole('list', { name: 'Coding agents' })
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) });

/**
 * Open a row's Connect and pick a way to connect it ("Claude subscription", "ChatGPT account", "API key", "MoPilot
 * credits"): the subscription is offered alone, the others behind "Use an API key or credits".
 */
export async function connectWith(page: Page, name: string, method: string) {
  const row = agentRow(page, name);
  await row.getByRole('button', { name: 'Connect', exact: true }).click();
  await row.getByRole('button', { name: 'Use an API key or credits', exact: true }).click();
  await row.getByRole('button', { name: method, exact: true }).click();
  return row;
}

/**
 * Continue past the welcome page. On a page opened with nothing connected, the first agent connected moves it on by
 * itself a moment after its row says Connected: then the page is gone instead.
 */
export async function continueWelcome(page: Page) {
  try {
    await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: 5_000 });
  } catch {
    await expect(welcomeHeading(page)).toHaveCount(0);
  }
}
