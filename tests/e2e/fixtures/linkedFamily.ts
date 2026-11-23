// Linked-session E2E steps shared by the specs of messages between sessions: a project with a Claude Code chat, a child
// that stands by, a parent held on an approval card (a turn awaiting the user cannot take a steer, so a message to it
// waits in its queue), and a message the child sends from its own chat.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, type Harness } from './app';
import { openHarnessList } from './harnessPicker';

export const BRIEF =
  'This independent linked task belongs to the user’s current request. Preserve its assigned scope and report its own result to the parent session.';
export const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
export const sidebar = (page: Page) => page.getByRole('complementary');
export const transcript = (page: Page) => page.getByRole('main');

export const journal = (h: Harness): any => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8'));
  } catch {
    return { children: {}, deliveries: {} };
  }
};
export const messages = (h: Harness): any[] => Object.values<any>(journal(h).deliveries ?? {}).filter((d) => d.kind === 'message');

export async function send(page: Page, text: string) {
  const button = page.getByRole('button', { name: 'Send', exact: true });
  // a chat that was just opened remounts its composer and drops a draft typed too early: type again until Send takes it
  await expect(async () => {
    await composer(page).fill(text);
    await expect(button).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await button.click();
}

/** A new Claude Code chat in a project folder named `name`. */
export async function claudeProject(page: Page, harness: Harness, name: string) {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  const folder = path.join(harness.dir, 'home', 'work', name);
  fs.mkdirSync(folder, { recursive: true });
  await harness.app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as any;
  }, folder);
  await sidebar(page).getByRole('button', { name: 'Add a project folder' }).click();
  await expect(page.locator('.ctxbar')).toContainText(name);
}

/** The parent starts a child that does one turn and stands by (its prompt makes no call). */
export async function startStandbyChild(page: Page, harness: Harness, title: string, prompt = 'Stand by', name?: string) {
  const start = `CUCALL start_session ${JSON.stringify({
    initiation: 'user_asked',
    context: 'fresh',
    use_worktree: false,
    ...(name ? { name } : {}),
    title,
    prompt,
    background: BRIEF,
  })}`;
  await send(page, `Start a session CUSTEPS\n${start}`);
  await expect.poll(() => Object.keys(journal(harness).children ?? {}).length, { timeout: 60_000 }).toBe(1);
}

export const childRow = (page: Page) => sidebar(page).locator('.thread-row.linked-child').first();
/** From a child's chat: back to the chat it was opened from. */
export const backToParent = (page: Page) => page.getByRole('button', { name: 'Back', exact: true }).click();

const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

/**
 * The open chat's turn has ended. A hold sent while the turn that started a child still runs is steered into that turn
 * and ends with it, so the chat is idle again and a message to it starts a turn instead of waiting in its queue (#3308).
 */
async function untilIdle(page: Page) {
  await expect(stop(page)).toHaveCount(0, { timeout: 60_000 });
}

/** The open chat's turn waits on an approval card: it cannot take a steer. */
export async function holdOnApproval(page: Page) {
  await untilIdle(page);
  await send(page, 'hold here DENYME');
  await expect(page.getByRole('textbox', { name: 'Denial note' }).first()).toBeVisible({ timeout: 30_000 });
}

/** From the child's own chat: it messages its parent. */
export async function childMessagesParent(page: Page, text: string) {
  await childRow(page).click();
  await send(page, `CUCALL send_message ${JSON.stringify({ to: 'parent', message: text })}`);
}

/** The open chat runs a turn of its own that lasts (SLOW waits for an interrupt), not one steered into the turn before. */
export async function runSlow(page: Page) {
  await untilIdle(page);
  await send(page, 'keep working SLOW');
  await expect(transcript(page).getByText('keep working SLOW', { exact: true }).first()).toBeVisible();
  await expect(stop(page)).toBeVisible();
}

/**
 * The open chat runs a long turn (SLOW waits for an interrupt) and its user switched the harness meanwhile: the switch
 * is pending, so the chat cannot take a steer and a message from another session waits in its queue tray.
 */
export async function holdOnSwitch(page: Page) {
  await runSlow(page);
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  // nothing in the chat is at risk: the pick switches at once (the sheet shows only when something is)
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Model One' }).click();
  await expect(page.getByText('Next message continues on')).toBeVisible();
}
