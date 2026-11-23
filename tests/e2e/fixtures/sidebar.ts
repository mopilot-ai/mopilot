// The primary standalone New chat row, distinct from Recents and project actions.
import type { Locator, Page } from '@playwright/test';

// a row with role button, not a <button>: it holds the Quick chat button
export const STANDALONE_NEW_CHAT_SELECTOR = '.sidebar-scroll > .sidebar-section > [role="button"][aria-label="New chat"]';
export const standaloneNewChat = (page: Page) => page.getByRole('complementary').locator(STANDALONE_NEW_CHAT_SELECTOR);

/** Sidebar organization commands live in the row's More options menu, as in Claude Desktop. */
export async function chooseSidebarChatAction(page: Page, row: Locator, label: string, options?: Parameters<Locator['click']>[0]) {
  await row.getByRole('button', { name: 'More options', exact: true }).click(options);
  await page.getByRole('menuitem', { name: label, exact: true }).click(options);
}

export const archiveSidebarChat = (page: Page, row: Locator, options?: Parameters<Locator['click']>[0]) =>
  chooseSidebarChatAction(page, row, 'Archive', options);
