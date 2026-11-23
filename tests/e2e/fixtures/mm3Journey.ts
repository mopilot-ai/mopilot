// The Mac app's journey of the Remote Run acceptance matrix (design/remote-run/plan.md "The journey each cell passes") on one backend, with the timings the owner's "smooth" is judged by: start and stream a reply, a tool call, an approval answered, Stop, quit and reopen with the history there and the chat usable, a second chat and switching between the two. Used by mm3-journey.spec.ts (This Mac, This Mac · keeps running) and mm3-ssh-journey.spec.ts (a real Host over real ssh).
import type { Page } from '@playwright/test';
import { expect, type Harness } from './app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
/** The chats in Recents, newest first (a chat in a project is listed there too, by design). */
const rows = (page: Page) => page.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]');

export async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  // (the composer's own button: a message waiting in the queue has a Send of its own)
  await page.locator('button.send-btn[aria-label="Send"]').click();
}

/** How long `action` takes until `done` holds, in milliseconds. */
async function took(action: () => Promise<unknown>, done: () => Promise<unknown>) {
  const from = Date.now();
  await action();
  await done();
  return Date.now() - from;
}

export interface Backend {
  name: string;
  /** Ready the backend. */
  setup(h: Harness): Promise<void>;
  /** A new chat on the backend, its first message sent. */
  start(h: Harness, message: string, another: boolean): Promise<void>;
  cleanup?(h: Harness): Promise<void>;
}

/** Run the journey on `backend`; the timings print as one `MM3-TIMING {json}` line. */
export async function runJourney(harness: Harness, backend: Backend) {
  const times: Record<string, number> = {};
  let page = harness.page;
  await backend.setup(harness);

  // 1. start a chat and stream a reply
  times.firstTokenMs = await took(
    () => backend.start(harness, 'hello journey', false),
    () => expect(transcript(page).getByText('fake-acp: hello journey', { exact: true })).toBeVisible({ timeout: 90_000 }),
  );
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });

  // 2. a tool call runs and its result shows
  await send(page, 'TOOL now');
  await expect(transcript(page).getByText('fake-acp: TOOL now', { exact: true })).toBeVisible({ timeout: 60_000 });
  // the call and its result show in the thread (the fake's execute call: `echo tool-ran`)
  // (the turn's steps are folded under "Worked for …": opened to read the call)
  await transcript(page)
    .getByText(/^Worked for/)
    .first()
    .click();
  await expect(transcript(page)).toContainText(/Ran\s*echo tool-ran/, { timeout: 30_000 });

  // 3. an approval card is answered (Allow)
  await send(page, 'PERMIT this');
  const card = page.locator('.approval-card');
  await expect(card).toBeVisible({ timeout: 60_000 });
  times.approvalRoundTripMs = await took(
    () => page.keyboard.press('1'),
    () => expect(transcript(page).getByText('fake-acp: PERMIT this', { exact: true })).toBeVisible({ timeout: 60_000 }),
  );
  await expect(card).toHaveCount(0);

  // 5. Stop ends a running turn
  await send(page, 'SLOW work');
  await expect(stop(page)).toBeVisible({ timeout: 60_000 });
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });

  // 6. quit and open again: the chat is listed with its history, and it still takes a message
  await harness.relaunch();
  page = harness.page;
  times.chatOpenMs = await took(
    () => rows(page).first().click(),
    () => expect(transcript(page).getByText('fake-acp: hello journey', { exact: true })).toBeVisible({ timeout: 60_000 }),
  );
  await expect(transcript(page).getByText('fake-acp: PERMIT this', { exact: true })).toBeVisible();
  await send(page, 'after the return');
  await expect(transcript(page).getByText('fake-acp: after the return', { exact: true })).toBeVisible({ timeout: 60_000 });

  // a second chat, and switching between the two: each keeps its own words
  await backend.start(harness, 'second chat words', true);
  await expect(transcript(page).getByText('fake-acp: second chat words', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(rows(page)).toHaveCount(2);
  times.chatSwitchMs = await took(
    () => rows(page).nth(1).click(),
    () => expect(transcript(page).getByText('fake-acp: after the return', { exact: true })).toBeVisible({ timeout: 30_000 }),
  );
  await expect(transcript(page).getByText('fake-acp: second chat words')).toHaveCount(0);

  console.log(`MM3-TIMING ${JSON.stringify({ backend: backend.name, ...times })}`);
  await backend.cleanup?.(harness);
}
