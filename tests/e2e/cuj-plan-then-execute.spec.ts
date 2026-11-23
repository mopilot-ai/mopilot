// CUJ plan-then-execute on both harnesses: turn Plan on, send the requirement (Codex asks a command approval while
// it reads), get one plan card, carry it out (a file edit asks too), see the turn's changes in the Changes panel, and
// edit the first message to go back to before the plan. Claude Code's plan is approved on the ExitPlanMode card.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

// this platform's path separator, as a pattern: '/' on macOS and Linux, '\\' on Windows
const SEP = path.sep.replace(/[\\]/g, '\\\\');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const planChip = (page: Page) => page.locator('.plan-chip');
const card = (page: Page) => page.locator('.approval-card');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}
const turnStarts = (h: Harness) =>
  h
    .codexLog()
    .filter(
      (e) => e.method === 'turn/start' && !/^Summarize the request below as a short chat title/.test(e.params.input?.[0]?.text ?? ''),
    );

test.use({ harnesses: 'both' });

test('plan-then-execute on Codex: approval while planning, one plan card, Implement, file approval, Changes panel, edit the last message', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await composer(page).fill('/plan');
  await page.keyboard.press('Enter');
  await expect(planChip(page)).toBeVisible();
  await send(page, 'APPROVECMD EDITFILE add a hello file');
  // the model reads something and asks first (the card stands in for the composer); the number key allows it
  await expect(card(page)).toContainText('Allow Codex to run this command?');
  await page.keyboard.press('1');
  // the plan, once, and Plan stays on after it
  const plan = page.locator('.plan-card');
  await expect(plan).toHaveCount(1);
  await expect(plan).toContainText('Change it for: APPROVECMD EDITFILE add a hello file');
  await expect(planChip(page)).toBeVisible();
  expect(turnStarts(harness)[0].params.collaborationMode.mode).toBe('plan');

  // Implement this plan: back to default mode, and the edit it makes asks
  await plan.getByRole('button', { name: 'Implement this plan' }).click();
  await expect(card(page)).toContainText('Allow Codex to edit');
  expect(turnStarts(harness)[1].params.collaborationMode.mode).toBe('default');
  await expect(planChip(page)).toHaveCount(0);
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).getByText(/fake-codex: Implement the plan\..*\[edit: written\]/)).toBeVisible();

  // the turn's changes in the Changes panel
  const edited = transcript(page).locator('.edited-card');
  await expect(edited).toContainText('Edited 1 file');
  await expect(edited).toContainText('hello.txt');
  await edited.getByRole('button', { name: 'View changes', exact: true }).click();
  const pane = page.locator('.changes-pane');
  await expect(pane.locator('.cp-scope')).toContainText('Last Turn');
  await expect(pane.locator('.cp-file-head', { hasText: 'hello.txt' })).toBeVisible();

  // edit the last message ("Implement the plan."): the chat goes back to before it, the plan card stays to run again
  const last = transcript(page).getByText('Implement the plan.', { exact: true });
  await last.hover();
  await transcript(page).getByRole('button', { name: 'Edit message' }).last().click();
  await expect(composer(page)).toHaveText('Implement the plan.');
  await expect(transcript(page).locator('.edited-card')).toHaveCount(0);
  await expect(page.locator('.plan-card')).toHaveCount(1);
  const revert = harness.codexLog().filter((e) => e.method === 'thread/revert');
  expect(revert).toHaveLength(1);
  expect(revert[0].params.beforeTurnId).toEqual(expect.any(String));
});

test('plan-then-execute on Claude Code: Plan on, the plan on one card, Approve plan, the edit asks, Changes panel, edit the message', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await send(page, 'warm up');
  await expect(transcript(page).getByText('fake-claude: warm up', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
  await expect(planChip(page)).toBeVisible();
  await send(page, 'PLAN EDITFILE add a hello file');

  // the plan arrives on one card, with its file by name (the folder is app data, #1933), and the approval only asks
  const approve = page.getByRole('button', { name: 'Approve plan' });
  await expect(approve).toBeVisible();
  const plan = transcript(page).locator('.plan-card');
  await expect(plan).toHaveCount(1);
  await expect(plan).toContainText('Look at the request: PLAN EDITFILE add a hello file');
  await expect(plan.locator('.plan-card-path')).toHaveText('fake-plan.md');
  await expect(plan.locator('.plan-card-path')).toHaveAttribute('title', new RegExp(`plans${SEP}fake-plan\\.md$`));
  await expect(card(page)).not.toContainText('plans/');
  await approve.click();
  // the plan runs in that turn: the chip goes off by itself, and the edit asks like any other
  await expect(planChip(page)).toHaveCount(0);
  await expect(card(page)).toContainText('Allow Claude Code to edit');
  await card(page)
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(
    transcript(page).getByText(/fake-claude: PLAN EDITFILE add a hello file \[plan approved, now .*\] \[edit: written\]/),
  ).toBeVisible();
  const answer = harness.claudeLog().find((e: any) => e.kind === 'plan') as any;
  expect(answer.response.behavior).toBe('allow');
  expect(answer.response.updatedPermissions).toEqual([expect.objectContaining({ type: 'setMode', destination: 'session' })]);

  // the turn's changes
  const edited = transcript(page).locator('.edited-card');
  await expect(edited).toContainText('Edited 1 file');
  await expect(edited).toContainText('hello.txt');
  await edited.getByRole('button', { name: 'View changes', exact: true }).click();
  await expect(page.locator('.changes-pane .cp-file-head', { hasText: 'hello.txt' })).toBeVisible();

  // edit the message: files and conversation are rewound to before it
  page.on('dialog', (d) => d.accept());
  const msg = transcript(page).getByText('PLAN EDITFILE add a hello file', { exact: true });
  await msg.hover();
  const edit = transcript(page).getByRole('button', { name: 'Edit message' }).last();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(composer(page)).toHaveText('PLAN EDITFILE add a hello file');
  await expect(page.locator('.plan-card')).toHaveCount(0);
  const rewinds = harness.claudeLog().filter((e: any) => e.kind === 'rewind') as any[];
  expect(rewinds.map((r) => r.dryRun)).toEqual([true, false]);
});
