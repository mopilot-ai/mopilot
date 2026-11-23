// CUJ support-errand across harnesses: "sign in, then chat with the store's support about my delayed order". The agent opens the
// order list on a stand-in store (tests/e2e/fixtures/errandStore.mjs), hands the sign-in to the user (the form is in another site's
// frame, so the pane says "Sign in to"), finds the delayed order after Done, continue, opens the support chat (a new window with the
// chat in a cross-origin frame), waits through the queue, states the case and pushes back on a vague answer; the advisor's offer needs
// the user's yes, so the turn ends on a question, and the chat window must still be there, in the same conversation, for the next turn.
// Messages: the first card is answered "Allow messages for this errand", so the next ordinary one goes without a card, and accepting the
// offer still asks (it commits the user). Codex's run has the chat in a popup window's cross-origin frame; Claude Code's in a new tab on
// the separate support site, as stores that send order help elsewhere do.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';
import { startErrandStore } from './fixtures/errandStore.mjs';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');
const handoffBar = (page: Page) => page.locator('.browser-agent-bar[data-state="handoff"]');
// the composer's Stop: a tab handed to the user keeps its own Stop on the pane's agent bar after the turn ends
const expectIdle = (page: Page, timeout = 60_000) =>
  expect(page.locator('.composer').getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout });

/** How a harness calls the built-in browser tools (#351): Codex the Registry's browser_*, Claude Code its mopilot_browser server. */
interface Way {
  who: 'Codex' | 'Claude Code';
  model: string;
  tool(short: string): string;
}
const CODEX: Way = { who: 'Codex', model: 'Fake Model One', tool: (s) => `browser_${s}` };
const CLAUDE: Way = { who: 'Claude Code', model: 'Fake Sonnet', tool: (s) => `mcp__mopilot_browser__${s}` };
const call = (w: Way, short: string, args: object = {}) => `CUCALL ${w.tool(short)} ${JSON.stringify(args)}`;
/** One browser_script call: `code` is the body of the script, kept on one line for the fake's CUCALL parser. */
const script = (w: Way, code: string) =>
  `CUCALL ${w.who === 'Codex' ? 'browser_script' : 'mcp__mopilot_browser__browser_script'} ${JSON.stringify({ code: code.replace(/\s*\n\s*/g, ' '), timeoutMs: 50_000 })}`;

async function newChatOn(page: Page, w: Way) {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: w.who }).click();
  await page.locator('.hp-models .menu-item', { hasText: w.model }).click();
  await page.keyboard.press('Escape');
}
async function send(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await expect(composer(page)).toContainText(lines[lines.length - 1]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** The chat: the frame of the store's /support window, or the support site's own page in its tab. */
const CHAT_FRAME = `const all = await tabs.list();
  const at = all.find((t) => t.url.includes('/support') || t.url.includes('/widget'));
  if (!at) return 'no chat window: ' + JSON.stringify(all.map((t) => t.url));
  const chat = await tabs.get(at.id);
  const frame = at.url.includes('/widget') ? chat : chat.frameLocator('iframe[title="Support chat"]');`;
/** Says `text` in the chat as a message of `kind` (browser_script's messageKind) and returns the advisor's next line once it lands. */
const SAY = (text: string, kind: 'ordinary' | 'commits' = 'ordinary') => `${CHAT_FRAME}
  const before = await frame.locator('li').count();
  await frame.getByRole('textbox', { name: 'Message' }).fill(${JSON.stringify(text)});
  await frame.getByRole('button', { name: 'Send' }).click({ messageKind: ${JSON.stringify(kind)} });
  for (let i = 0; i < 60; i++) {
    const lines = await frame.locator('li').allInnerTexts();
    if (lines.length >= before + 2 && lines[lines.length - 1].startsWith('Sam: ')) return 'ADVISOR ' + lines[lines.length - 1];
    await sleep(500);
  }
  return 'no answer yet';`;

/**
 * A message to the advisor that needs the user: the card names the site and says it can't be undone. An ordinary one offers "Allow
 * messages for this errand"; one that commits says why and offers Allow once only.
 */
async function allowSend(page: Page, w: Way, site: string, scope: 'errand' | 'once') {
  await expect(card(page)).toContainText(`Allow ${w.who} to send a message in ${site}`, { timeout: 30_000 });
  await expect(card(page)).toContainText("This can't be undone");
  if (scope === 'errand') return pickScope(card(page), /Allow messages for this errand/);
  await expect(card(page)).toContainText('Asks every time: it may accept or decline an offer.');
  await expect(card(page).getByRole('button', { name: /Allow messages for this errand/ })).toHaveCount(0);
  await pickScope(card(page), /Allow once/);
}

async function journey(page: Page, w: Way, chatMode: 'popup' | 'tab') {
  const store = await startErrandStore({ queueMs: 5000, typingMs: 1500, chatMode });
  // where the messages are sent: the store's window, or the support site's own tab
  const chatSite = chatMode === 'tab' ? store.widgets : store.store;
  try {
    await expect(home(page)).toBeVisible();
    await newChatOn(page, w);
    const storeHost = new URL(store.store).host;

    // 1. the order list needs a sign-in: the agent hands the tab to the user; the form is in another site's frame
    await send(page, [
      call(w, 'navigate', { url: `${store.store}/orders` }),
      call(w, 'request_signin', { reason: 'Sign in to see your orders' }),
    ]);
    await expect(card(page)).toContainText(`Allow ${w.who} to use ${store.store}`);
    await pickScope(card(page), /Allow in this chat/);
    await expect(handoffBar(page)).toBeVisible({ timeout: 30_000 });
    await expect(handoffBar(page)).toContainText(`Sign in to ${storeHost}`);
    await expectIdle(page);

    // 2. the user signs in (password and the two-step code, played here) and presses Done, continue: the agent reads the orders
    expect((await (await fetch(`${store.store}/__user/signin`)).json()).attempts).toBeGreaterThan(0);
    // the user presses Done once the page shows them signed in
    await expect
      .poll(async () => (await (await fetch(`${store.store}/__user/sessions`)).json()).sessions, { timeout: 15_000 })
      .toBeGreaterThan(0);
    await handoffBar(page)
      .getByRole('button', { name: /Done, continue/ })
      .click();
    await expect(handoffBar(page)).toHaveCount(0);
    await expect(transcript(page)).toContainText(`Done on ${storeHost}`);
    await expectIdle(page);
    await send(page, [call(w, 'get_page_text')]);
    await expect(transcript(page)).toContainText(store.order.id, { timeout: 30_000 });
    await expect(transcript(page)).toContainText('Delayed');
    await expectIdle(page);

    // 3. the order page's Chat with us opens a window; the chat is a cross-origin frame in it, behind a queue
    await send(page, [
      script(
        w,
        `await tab.goto(${JSON.stringify(`${store.store}/orders/${store.order.id}`)});
        await tab.getByText('Chat with us').click();
        await sleep(1500);
        ${CHAT_FRAME}
        for (let i = 0; i < 40; i++) {
          const s = await frame.getByRole('status').innerText();
          if (s.startsWith('Connected')) return 'CONNECTED ' + (await frame.locator('li').allInnerTexts()).join(' / ');
          await sleep(500);
        }
        return 'still queued';`,
      ),
    ]);
    // (the support site runs on localhost here, which needs no site card; a real one on another host asks once, before reading)
    await expect(transcript(page)).toContainText("CONNECTED Sam: Hi, I'm Sam", { timeout: 60_000 });
    await expectIdle(page);

    // 4. the case, stated with the order number and the dates; the vague answer gets one push back, which brings the real date and
    // an offer that changes the order: the turn ends on the user's question, with the chat window the agent finished in still open
    await send(page, [
      script(
        w,
        SAY(
          `Hello. My order ${store.order.id} was promised by ${store.order.promised} and is still not here. What is the new delivery date?`,
        ),
      ),
    ]);
    await allowSend(page, w, chatSite, 'errand');
    await expect(transcript(page)).toContainText('Sam: Thanks. I can see your order is on its way', { timeout: 60_000 });
    await expect(page.locator('[data-errand-strip]')).toContainText(`Messages on ${new URL(chatSite).host} allowed for this errand`);
    await expectIdle(page);
    // the push back is ordinary: no card this time
    await send(page, [script(w, SAY('That is not a date. Please give me the exact delivery date, and what you can offer for the delay.'))]);
    await expect(transcript(page)).toContainText(`expected to arrive on ${store.order.now}`, { timeout: 60_000 });
    await expect(card(page)).toHaveCount(0);
    await expect(transcript(page)).toContainText('$25 store credit');
    await expectIdle(page);

    // 5. the user answers the question in the next message; the same conversation is still there to accept in
    await send(page, ['Take the credit, keep the order', script(w, SAY('Yes, please apply the $25 credit and keep the order as it is.'))]);
    await allowSend(page, w, chatSite, 'once');
    await expect(transcript(page)).toContainText(`Your case number is ${store.caseNumber}`, { timeout: 60_000 });
    await expectIdle(page);
    const chats = await (await fetch(`${store.store}/__user/chats`)).json();
    expect(chats).toHaveLength(1);
    expect(chats[0].lines.filter((l: { who: string }) => l.who === 'you')).toHaveLength(3);
    // Revoke: the line goes, and the next message asks again
    await page.locator('[data-errand-strip]').getByRole('button', { name: 'Revoke' }).click();
    await expect(page.locator('[data-errand-strip]')).toHaveCount(0);
  } finally {
    await store.close();
  }
}

test.use({ harnesses: 'both' });
// a whole errand: sign-in, a queue and three advisor replies with typing delays
test.setTimeout(300_000);

test('support-errand on Codex: sign-in hand-off in a cross-origin frame, delayed order, support chat window kept across the consent question', async ({
  page,
}) => {
  await journey(page, CODEX, 'popup');
});

test('support-errand on Claude Code: sign-in hand-off in a cross-origin frame, delayed order, support chat window kept across the consent question', async ({
  page,
}) => {
  await journey(page, CLAUDE, 'tab');
});
