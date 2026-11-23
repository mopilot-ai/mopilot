// MoMo's home surfaces in the real app on the home lane's scripted home (shared/momoHomeFake.mjs, served by main in a dev run: MOPILOT_MOMO_DEV=1, unpackaged), switched between its scenarios through the dev bridge call. Every state is drawn from what the home answers: first run, the Runs-on pill and a move (progress, Cancel, failure, Stay), asleep (a message waits, Wake), out of date, signed out, moved away, a lost connection (Check again), and a move the home refuses, which must show its cause and change nothing. Tasks, Notes, Rules and approval cards need the other lanes' data; here only their empty and refused states are real.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoRow, momoSetupDone } from './fixtures/momo';

test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({
  harnesses: 'claude',
  env: { MOPILOT_MOMO_DEV: '1' },
  seed: { files: (d) => codexCliLogin(d), ...momoSetupDone },
});

// a dev run keeps today's pages unless the switch asks for the home main serves. The window is already open when a test starts, so an init script would only
// apply to the next page load: the switch is set on this page and the window reloads, before MoMo is opened (the seam is chosen once per page)
test.beforeEach(async ({ page }) => {
  await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible();
  await page.evaluate(() => localStorage.setItem('momo.homeUi', 'ipc'));
  await page.reload();
});

const views = (page: Page) => page.getByRole('navigation', { name: 'MoMo views' });
const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });

/** Opens MoMo on the scripted home's scenario; the home answers, the page draws it. */
async function open(page: Page, scenario: string, tab?: 'Tasks' | 'Notes' | 'Rules') {
  // what MoMo's page shows whichever state the home is in: its tabs, the first-run choice, or where MoMo went
  const shown = views(page)
    .or(page.getByRole('heading', { name: 'Where should MoMo live?' }))
    .or(page.getByRole('heading', { name: /^MoMo moved to / }));
  if (!(await shown.first().isVisible())) {
    await expect(page.getByRole('textbox', { name: 'Message', exact: true }).first()).toBeVisible();
    await momoRow(page).click();
  }
  await expect(shown.first()).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate((n) => (window as any).native.momoHome.devScenario(n), scenario)).toBe(true);
  if (tab) await views(page).getByRole('button', { name: tab, exact: true }).click();
}

test('first run: where MoMo lives is picked and the home answers with its page', async ({ page }) => {
  await open(page, 'first-run');
  await expect(page.getByRole('heading', { name: 'Where should MoMo live?' })).toBeVisible();
  await expect(page.getByText('Everything MoMo knows stays on that machine, encrypted.')).toBeVisible();
  await page.getByRole('radio', { name: /Studio/ }).click();
  await button(page, 'Continue with Studio').click();
  await expect(button(page, 'Runs on Studio')).toBeVisible();
  await expect(views(page)).toBeVisible();
});

test('the Runs-on pill lists the machines; a move shows its steps and can be cancelled before the switch', async ({ page }) => {
  await open(page, 'running');
  await button(page, 'Runs on Studio').click();
  const where = page.getByRole('dialog', { name: 'Where MoMo runs' });
  await expect(where.getByText('MoMo is here')).toBeVisible();
  await expect(where.getByText('Moving takes about a minute. Notes, rules, tasks and sign-ins move with it.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(where).toHaveCount(0);
  await open(page, 'moving');
  await expect(page.getByRole('heading', { name: 'Moving MoMo to Mac mini' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Move progress' })).toContainText('Sealed');
  await button(page, 'Cancel').click();
  await expect(button(page, 'Runs on Studio')).toBeVisible();
});

test('a move the home could not finish says its cause and offers Retry and Stay', async ({ page }) => {
  await open(page, 'move-failed');
  await button(page, 'Runs on Studio').click();
  await page
    .getByRole('dialog', { name: 'Where MoMo runs' })
    .getByRole('listitem')
    .filter({ hasText: 'Mac mini' })
    .getByRole('button')
    .click();
  await expect(page.getByRole('heading', { name: 'Move didn’t finish' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Mac mini stopped answering.')).toBeVisible();
  await button(page, 'Stay on Studio').click();
  await expect(button(page, 'Runs on Studio')).toBeVisible();
});

test('asleep: the page says so, a message waits, and Wake brings the home back', async ({ page }) => {
  await open(page, 'asleep');
  await expect(page.getByText('Nothing is being checked. Your messages wait here.')).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message MoMo' });
  await expect(composer).toHaveAttribute('placeholder', /sends when Studio is back/);
  await composer.fill('Call Dana');
  await button(page, 'Send').click();
  await expect(page.getByText('Waiting for Studio')).toBeVisible();
  await button(page, /^Wake /).click();
  await expect(button(page, 'Runs on Studio')).toBeVisible();
});

test('out of date and signed out: the real cause with the one tap that fixes it', async ({ page }) => {
  await open(page, 'needs-update');
  await expect(page.getByRole('heading', { name: /is out of date$/ })).toBeVisible();
  await button(page, /^Update /).click();
  await expect(page.getByRole('heading', { name: /is out of date$/ })).toHaveCount(0);
  await open(page, 'needs-sign-in');
  await expect(page.getByRole('heading', { name: /signed out on|isn’t installed on/ })).toBeVisible();
  await expect(page.getByText('MoMo can’t think until')).toBeVisible();
});

test('a machine that is no longer home says where MoMo went, and a lost connection can be checked again', async ({ page }) => {
  await open(page, 'moved-away');
  await expect(page.getByText(/^MoMo moved to Studio at /)).toBeVisible();
  await open(page, 'lost-connection');
  await expect(page.getByText('Not sure', { exact: true })).toBeVisible();
  await expect(page.getByText('MoMo never sends the same message twice on its own.')).toBeVisible();
  await button(page, 'Check again').click();
  await expect(page.getByText('Not sure', { exact: true })).toHaveCount(0);
});

test('Tasks, Notes and Rules show their empty states, and a rule the home cannot take is refused in its words and not added', async ({
  page,
}) => {
  await open(page, 'running', 'Tasks');
  await expect(page.getByRole('heading', { name: 'Nothing running.' })).toBeVisible();
  await views(page).getByRole('button', { name: 'Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nothing here yet.' })).toBeVisible();
  await views(page).getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No rules yet.' })).toBeVisible();
  await button(page, 'Add a rule').first().click();
  const form = page.getByRole('form', { name: 'Add a rule' });
  await form.getByRole('textbox').fill('Bills → ask first');
  await form.getByRole('button', { name: 'Save' }).click();
  // the home does not serve this yet: the page says so, keeps the form and shows no rule it was not told about
  await expect(form.getByText('MoMo can’t do that yet.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No rules yet.' })).toBeVisible();
});

/** Plays a populated view on the scripted home's own (the dev bridge call): its view with these chat rows, and nothing else changed. */
async function showChat(page: Page, rows: unknown[]) {
  expect(
    await page.evaluate(async (chat) => {
      const home = (window as any).native.momoHome;
      await home.devSetView(null);
      const answer = await home.view();
      return home.devSetView({ ...answer.view, chat });
    }, rows),
  ).toBe(true);
}

const card = (id: string, o: Record<string, unknown> = {}) => ({
  kind: 'approval',
  id: `row-${id}`,
  at: Date.now(),
  approval: {
    id,
    action: 'send-email',
    title: 'Send this email?',
    recipients: [{ name: 'Dana Lee', address: 'dana.lee@acme.example', outsideCompany: true }],
    subject: 'Re: Acme renewal',
    attachments: [],
    body: 'Hi Dana, yes, the price holds.',
    fields: [],
    expiresAt: null,
    status: 'pending',
    answeredElsewhere: null,
    failure: null,
    canAskAgain: false,
    ...o,
  },
});

test('an approval card: Send the home cannot take is refused in its words and stays pending; an expired and an answered-elsewhere card say so', async ({
  page,
}) => {
  await open(page, 'running');
  await showChat(page, [
    card('c1'),
    card('c2', { expiresAt: Date.now() - 1000 }),
    card('c3', { answeredElsewhere: { device: 'iPhone', at: Date.now(), outcome: 'approved' } }),
  ]);
  const pending = page.getByTestId('momo-card-c1');
  await expect(pending).toContainText('dana.lee@acme.example');
  await pending.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(pending).toContainText('MoMo can’t do that yet.');
  await expect(pending).toHaveAttribute('data-status', 'pending');
  await expect(page.getByTestId('momo-card-c2')).toHaveAttribute('data-status', 'expired');
  await expect(page.getByTestId('momo-card-c2')).toContainText('Nobody answered in 30 minutes.');
  await expect(page.getByTestId('momo-card-c3')).toContainText('Answered on your iPhone at');
});

test('a message the home never got can be sent again, and the home answers without a refusal', async ({ page }) => {
  await open(page, 'running');
  await showChat(page, [{ kind: 'user', id: 'turn-lost-1', at: Date.now(), text: 'Attach the quote.', delivery: 'never-got-it' }]);
  const row = page.getByTestId('momo-row-turn-lost-1');
  await expect(row).toContainText('never got it');
  await row.getByRole('button', { name: 'Send now' }).click();
  await expect(row.getByRole('alert')).toHaveCount(0);
});

test('a move that could not finish after the switch offers Run MoMo here again; the home takes MoMo back', async ({ page }) => {
  await open(page, 'move-stuck');
  await button(page, 'Runs on Studio').click();
  await page
    .getByRole('dialog', { name: 'Where MoMo runs' })
    .getByRole('listitem')
    .filter({ hasText: 'Mac mini' })
    .getByRole('button')
    .click();
  await expect(page.getByRole('heading', { name: 'Move didn’t finish' })).toBeVisible({ timeout: 20_000 });
  await button(page, 'Run MoMo here again').click();
  const sheet = page.getByRole('alertdialog');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button').first().click();
  await expect(button(page, 'Runs on Studio')).toBeVisible({ timeout: 20_000 });
  // the home keeps the move on screen until it is acknowledged, now saying MoMo runs on its old machine again and no longer offering the way back
  await expect(page.getByText('MoMo runs on its old machine again.')).toBeVisible();
  await expect(button(page, 'Run MoMo here again')).toHaveCount(0);
  await button(page, 'Stay on Studio').click();
  await expect(page.getByRole('heading', { name: 'Move didn’t finish' })).toHaveCount(0);
});
