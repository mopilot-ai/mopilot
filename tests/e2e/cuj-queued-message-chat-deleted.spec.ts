// A message a chat sent to a session that is busy waits in that session's queue. When the user archives and then deletes that
// session, the message never runs: it must be recorded in the linked-session journal as removed (reason "archived", kept after the chat is deleted) so its sender
// learns of it from list_sessions (#3200). The fake Claude keeps the worker's turn running while it is archived and deleted.
import { test, expect, type Harness } from './fixtures/app';
import {
  childRow,
  claudeProject,
  holdOnSwitch,
  journal as journalOf,
  backToParent,
  send,
  sidebar,
  startStandbyChild,
} from './fixtures/linkedFamily';
import { archiveSidebarChat } from './fixtures/sidebar';
import { settingsEntry } from './fixtures/settings';

const journal = journalOf;
const messages = (h: Harness): [string, any][] => Object.entries<any>(journal(h).deliveries ?? {}).filter(([, d]) => d.kind === 'message');

test.use({ harnesses: 'both' });

test('a message queued for a session the user is archived and then deleted stays recorded as removed for its sender', async ({
  page,
  harness,
}, testInfo) => {
  await claudeProject(page, harness, 'queued-delete-project');

  // the worker runs a long turn with a harness switch pending (it cannot take a steer), then its parent messages it: the message queues
  await startStandbyChild(page, harness, 'Queued worker', 'Stand by', 'worker');
  await childRow(page).click();
  await holdOnSwitch(page);
  await backToParent(page);
  await send(page, `CUCALL send_message ${JSON.stringify({ to: 'worker', message: 'Please also check the schema' })}`);
  await expect.poll(() => messages(harness).length, { timeout: 60_000 }).toBe(1);
  const [id, delivery] = messages(harness)[0];
  expect(delivery.removedAt).toBeUndefined();

  // archive the working session and delete it for good: the queued message never runs
  page.on('dialog', (d) => d.accept());
  const row = sidebar(page).locator('.thread-row.linked-child', { hasText: 'Started by the agent' }).first();
  await row.hover();
  await archiveSidebarChat(page, row);
  // archiving drops what waited for it: the sender is told at once
  await expect.poll(() => journal(harness).deliveries?.[id]?.removedReason, { timeout: 30_000 }).toBe('archived');
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Archived chats' }).click();
  const doomed = page.locator('.settings-row', { hasText: 'Fake chat title' });
  await doomed.getByRole('button').nth(1).click();
  await expect(doomed).toHaveCount(0);

  // and deleting the chat for good does not make the sender lose that record
  await expect.poll(() => journal(harness).children?.[delivery.chatId], { timeout: 30_000 }).toBeUndefined();
  expect(journal(harness).deliveries[id].removedReason).toBe('archived');
  expect(typeof journal(harness).deliveries[id].removedAt).toBe('number');
  expect(journal(harness).children?.[delivery.chatId]).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('queued-message-chat-deleted.png') });
});
