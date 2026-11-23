// MoMo's channels (A2, `momo.channels`) on a fake harness for an invited account (MOPILOT_MOMO_DEV=1), clicking every control in the real renderer: New channel asks a name only and opens the channel with MoMo's first row; the composer says "Message #name"; a message is answered in the channel and never shows in Main; switching back and forth keeps each chat; Everything lists the rows of both with a filter by channel; rename; a group with its channel moved in; archive; and Delete, which waits before it can be pressed. No Mac-only API: it runs on Linux and macOS.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChat, momoChatSession, momoReply, openMomo } from './fixtures/momo';

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_PASS_IDLE_MS: '2000' },
  seed: {
    files: (d) => codexCliLogin(d),
    uiState: { prefs: { momo: { shell: true, channels: true, routines: { proactivity: 'default', quietHours: null } } } },
  },
});

const rail = (page: Page) => page.locator('[data-momo-shell]').getByRole('navigation', { name: 'MoMo' });
const dialog = (page: Page) => page.locator('.dialog');

/** Makes a channel through the rail's New channel and waits for its chat. */
async function makeChannel(page: Page, name: string) {
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  await expect(dialog(page).getByText('A place for one topic. Your main chat stays as it is.')).toBeVisible();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: name, exact: true })).toHaveAttribute('aria-current', 'page', {
    timeout: 30_000,
  });
}

test('a channel: made by name, its first row, its own composer and chat, Main untouched, Everything with its filter', async ({ page }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  const main = await momoChatSession(page);
  // Main is the default and says so
  await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');
  await main.send('Hello from main');
  await expect(main.chat.getByText(/fake-claude: /).first()).toBeVisible({ timeout: 30_000 });

  await makeChannel(page, 'Trip');
  // MoMo's first row, with its three chips; No only records, and the row does not come back
  const first = page.locator('[data-welcome]');
  await expect(first.getByText('This channel is for one topic. Want me to suggest tasks I can do here?')).toBeVisible({ timeout: 30_000 });
  await expect(first.getByRole('button')).toHaveText(['Yes', 'No', 'Not now']);
  await page.screenshot({ path: test.info().outputPath('momo-channel-new.png') });
  // the composer is the channel's
  const composer = momoChat(page).getByRole('textbox', { name: 'Message', exact: true });
  // the empty field says whose it is
  await expect(composer).toHaveAttribute('data-placeholder', 'Message #Trip');
  await first.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(first).toHaveCount(0);
  // Yes sent a normal message, which the channel's chat answers
  await expect(momoChat(page).getByText('Suggest tasks you can do here').first()).toBeVisible({ timeout: 30_000 });
  await expect(
    momoChat(page)
      .getByText(/fake-claude: /)
      .first(),
  ).toBeVisible({ timeout: 30_000 });
  // the fixture's own send (fill the textbox, press Send) in this channel's chat
  await main.send('Plan the Lisbon trip');
  await expect(momoChat(page).getByText(momoReply('fake-claude', 'Plan the Lisbon trip')).first()).toBeVisible({ timeout: 30_000 });

  // Main is unaffected: its own chat, without the channel's messages
  await rail(page).getByRole('button', { name: 'Main', exact: true }).click();
  await expect(momoChat(page).getByText('Hello from main').first()).toBeVisible({ timeout: 30_000 });
  await expect(momoChat(page).getByText('Plan the Lisbon trip')).toHaveCount(0);
  await expect(momoChat(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('data-placeholder', 'Message MoMo');
  await rail(page).getByRole('button', { name: 'Trip', exact: true }).click();
  await expect(momoChat(page).getByText('Plan the Lisbon trip').first()).toBeVisible({ timeout: 30_000 });
  await expect(momoChat(page).getByText('Hello from main')).toHaveCount(0);
  // a duplicate name is refused in the dialog, in the Mac's words
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('trip');
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('You already have one with that name.');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  // Everything: both chats' rows by time, each with its channel's name, and a filter
  await rail(page).getByRole('button', { name: 'Everything', exact: true }).click();
  const feed = page.getByRole('region', { name: 'Everything', exact: true });
  await expect(feed.locator('[data-channel]').filter({ hasText: '#Trip' }).first()).toBeVisible({ timeout: 90_000 });
  await expect(feed.locator('[data-channel="main"]').filter({ hasText: 'Hello from main' })).toBeVisible({ timeout: 90_000 });
  await page.screenshot({ path: test.info().outputPath('momo-channels-everything.png') });
  await feed.getByLabel('Channel').selectOption({ label: '#Trip' });
  await expect(feed.locator('[data-channel="main"]')).toHaveCount(0);
  await expect(feed.locator('[data-channel]').filter({ hasText: '#Trip' }).first()).toBeVisible();
  // a row opens its channel
  await feed.locator('[data-channel]').first().click();
  await expect(rail(page).getByRole('button', { name: 'Trip', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('rename, groups, instructions, archive and delete', async ({ page }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  await momoChatSession(page);
  await makeChannel(page, 'Garden');
  const menu = (name: string) =>
    page
      .locator('[data-momo-shell]')
      .getByRole('button', { name: `More for the ${name} channel` })
      .first();
  // a plain item is a menuitem; a move into a named group is a radio item (it shows which group the channel is in)
  const pick = (label: string) =>
    page.getByRole(label.startsWith('Move to group: ') && label !== 'Move to group: No group' ? 'menuitemradio' : 'menuitem', {
      name: label,
      exact: true,
    });

  // rename keeps the chat and shows the new name everywhere
  await menu('Garden').click();
  await pick('Rename').click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Backyard');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'Backyard', exact: true })).toBeVisible();
  await expect(momoChat(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
    'data-placeholder',
    'Message #Backyard',
  );

  // instructions: its own, kept, at most 2,000 characters
  await menu('Backyard').click();
  await pick('Instructions').click();
  await dialog(page).getByRole('textbox', { name: 'Instructions' }).fill('Answer in French.');
  await expect(dialog(page).getByText('17 / 2000')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await menu('Backyard').click();
  await pick('Instructions').click();
  await expect(dialog(page).getByRole('textbox', { name: 'Instructions' })).toHaveValue('Answer in French.');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  // a group: made, empty it says where to drop, a channel moved in from its menu, then out
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New group', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Home');
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByText('Drag or move channels here')).toBeVisible();
  await menu('Backyard').click();
  await page.getByRole('menuitem', { name: 'Move to group ›', exact: true }).click();
  await pick('Move to group: Home').click();
  await expect(rail(page).getByText('Drag or move channels here')).toHaveCount(0);
  await menu('Backyard').click();
  await page.getByRole('menuitem', { name: 'Move to group ›', exact: true }).click();
  await pick('Move to group: No group').click();
  await expect(rail(page).getByText('Drag or move channels here')).toBeVisible();

  // archive: it leaves the rail and the page goes to Main
  await makeChannel(page, 'Old plans');
  await menu('Old plans').click();
  await pick('Archive').click();
  await expect(rail(page).getByRole('button', { name: 'Old plans', exact: true })).toHaveCount(0);
  await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');

  // delete: the dialog says it can't be undone, offers to archive, and Delete waits
  await menu('Backyard').click();
  await pick('Delete').click();
  await expect(dialog(page).getByText('Can’t be undone. You can archive it instead.')).toBeVisible();
  const del = dialog(page).getByRole('button', { name: 'Delete', exact: true });
  await expect(del).toBeDisabled();
  await expect(del).toBeEnabled({ timeout: 10_000 });
  await del.click();
  await expect(rail(page).getByRole('button', { name: 'Backyard', exact: true })).toHaveCount(0);
  await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('the first row’s No and Not now only record the answer: no message is sent and the row does not come back', async ({ page }) => {
  test.setTimeout(240_000);
  await openMomo(page);
  await momoChatSession(page);
  for (const [name, chip] of [
    ['Books', 'No'],
    ['Movies', 'Not now'],
  ] as const) {
    await makeChannel(page, name);
    const first = page.locator('[data-welcome]');
    await expect(first).toBeVisible({ timeout: 30_000 });
    await first.getByRole('button', { name: chip, exact: true }).click();
    await expect(first).toHaveCount(0);
    await expect(momoChat(page).getByText('Suggest tasks you can do here')).toHaveCount(0);
    // leaving and coming back does not ask again
    await rail(page).getByRole('button', { name: 'Main', exact: true }).click();
    await rail(page).getByRole('button', { name: name, exact: true }).click();
    await expect(momoChat(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute(
      'data-placeholder',
      `Message #${name}`,
    );
    await expect(page.locator('[data-welcome]')).toHaveCount(0);
  }
});

test('at most twelve channels: the thirteenth is refused in the dialog with a short message', async ({ page }) => {
  test.setTimeout(420_000);
  await openMomo(page);
  await momoChatSession(page);
  for (let i = 1; i <= 12; i++) await makeChannel(page, `Room ${i}`);
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New channel', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('One more');
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog(page).getByRole('alert')).toHaveText('That’s 12 channels. Archive one to add another.');
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(rail(page).getByRole('button', { name: 'One more', exact: true })).toHaveCount(0);
});

test.describe('flags off', () => {
  test.use({
    seed: {
      files: (d) => codexCliLogin(d),
      uiState: { prefs: { momo: { shell: true, routines: { proactivity: 'default', quietHours: null } } } },
    },
  });

  test('with momo.channels off the shell is M0b’s: Everything only, no New channel, no group, MoMo’s own composer line', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openMomo(page);
    await momoChatSession(page);
    const shell = page.locator('[data-momo-shell]');
    await expect(rail(page).getByRole('button', { name: 'Everything', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(rail(page).getByRole('button', { name: 'Main', exact: true })).toHaveCount(0);
    await expect(shell.getByRole('button', { name: 'New channel' })).toHaveCount(0);
    await expect(shell.getByRole('button', { name: 'New group' })).toHaveCount(0);
    await expect(momoChat(page).getByRole('textbox', { name: 'Message', exact: true })).toHaveAttribute('data-placeholder', 'Message MoMo');
  });
});

test('rename, move, archive and a group’s delete each say so with Undo, and Undo restores', async ({ page }) => {
  test.setTimeout(300_000);
  await openMomo(page);
  await momoChatSession(page);
  await makeChannel(page, 'Garden');
  const menu = (name: string) =>
    page
      .locator('[data-momo-shell]')
      .getByRole('button', { name: `More for the ${name} channel` })
      .first();
  const groupMenu = (name: string) => page.locator('[data-momo-shell]').getByRole('button', { name: `Group menu: ${name}` });
  const pick = (label: string) =>
    page.getByRole(label.startsWith('Move to group: ') && label !== 'Move to group: No group' ? 'menuitemradio' : 'menuitem', {
      name: label,
      exact: true,
    });
  const toast = (text: string) => page.getByText(text, { exact: true });
  // the toasts stack for a few seconds: the newest is the last one
  const undo = () => page.getByRole('button', { name: 'Undo', exact: true }).last();
  const channel = (name: string) => rail(page).getByRole('button', { name, exact: true });

  // rename: "Renamed to #Backyard", Undo brings Garden back
  await menu('Garden').click();
  await pick('Rename').click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Backyard');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(toast('Renamed to #Backyard')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-undo-rename.png') });
  await undo().click();
  await expect(toast('Renamed the channel to Garden')).toBeVisible();
  await expect(channel('Garden')).toBeVisible();

  // move: into a group and Undo out of it
  await page.locator('[data-momo-shell]').getByRole('button', { name: 'New channel or group', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New group', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Name' }).fill('Home');
  await dialog(page).getByRole('button', { name: 'Create', exact: true }).click();
  await expect(rail(page).getByText('Drag or move channels here')).toBeVisible();
  await menu('Garden').click();
  await page.getByRole('menuitem', { name: 'Move to group ›', exact: true }).click();
  await pick('Move to group: Home').click();
  await expect(toast('Moved #Garden to the Home group')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-undo-move.png') });
  await undo().click();
  await expect(toast('Moved #Garden out of its group')).toBeVisible();
  await expect(rail(page).getByText('Drag or move channels here')).toBeVisible();

  // delete group: the group goes with its channel loose, Undo brings the group and the channel in it back
  await menu('Garden').click();
  await page.getByRole('menuitem', { name: 'Move to group ›', exact: true }).click();
  await pick('Move to group: Home').click();
  await expect(rail(page).getByText('Drag or move channels here')).toHaveCount(0);
  await groupMenu('Home').click();
  await pick('Delete group').click();
  await expect(toast('Deleted the Home group')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-undo-delete-group.png') });
  await expect(groupMenu('Home')).toHaveCount(0);
  await undo().click();
  await expect(toast('Restored the Home group')).toBeVisible();
  await expect(groupMenu('Home')).toBeVisible();
  await expect(rail(page).getByText('Drag or move channels here')).toHaveCount(0);

  // archive: it leaves the rail; Undo puts it back
  await menu('Garden').click();
  await pick('Archive').click();
  await expect(toast('Archived #Garden')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('momo-undo-archive.png') });
  await expect(channel('Garden')).toHaveCount(0);
  await undo().click();
  await expect(toast('Unarchived the #Garden channel')).toBeVisible();
  await expect(channel('Garden')).toBeVisible();
  // the toast goes by itself after about 8 seconds
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0, { timeout: 15_000 });
});
