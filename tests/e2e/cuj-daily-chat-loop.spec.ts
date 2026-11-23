// CUJ daily-chat-loop on both harnesses: send a message with an attached image, queue a follow-up while a
// turn runs and send it with "Steer", Stop, edit the last message and send it again, see how full the context is,
// read one "Thought for" row per stretch of thinking and a hook only when it fails, wrap up with a box only for a
// question with answers, compact the context. On Claude Code also: 1M models named so, and a running step said once.
// (Sending, streaming and Stop on their own are also in cuj-codex and cuj-claude.)
// e2e-covers: src/components/composer/ContextRing.tsx src/components/composer/ComposerPlanLimits.tsx
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatMessages } from './fixtures/claudeChat';
import { runningCommandName } from './fixtures/commandStep';
import { openCompletedTurnWork } from './fixtures/turnWork';
import { CONTEXT, HOOK_FAILURE, THOUGHTS } from './fixtures/fake-turn-details.mjs';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const queued = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: text });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

// a 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function fill(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
}
async function send(page: Page, text: string) {
  await fill(page, text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** Attach an image through the + menu, the way a user picks a file. */
async function attachImage(page: Page, h: Harness) {
  const file = path.join(h.dir, 'sketch.png');
  fs.writeFileSync(file, PNG);
  await h.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any;
  }, file);
  await page.getByRole('button', { name: 'Add files and more' }).click();
  await page.locator('.add-panel').getByText('Files and folders', { exact: true }).click();
  await expect(page.locator('.attachment.image')).toHaveCount(1);
}
/**
 * The SLOW turn has started, not just been sent: its reply streamed and it is not in the queue. Stop alone also shows
 * while main still holds the previous turn's end (it snapshots the turn's changes first, seconds on a cold runner), and
 * a follow-up sent then is queued behind the SLOW message and steers into the turn that already ended.
 */
async function slowTurnRunning(page: Page, fake: 'fake-codex' | 'fake-claude') {
  await expect(transcript(page).getByText(`${fake}: take it SLOW`, { exact: true })).toBeVisible();
  await expect(queued(page, 'take it SLOW')).toHaveCount(0);
  await expect(stop(page)).toBeVisible();
}
const release = (h: Harness) => fs.writeFileSync(path.join(h.dir, 'fake-codex.jsonl.release'), '');

/** The user messages the fake Codex got for chat turns (title helpers left out): text and image parts. */
function codexInputs(h: Harness) {
  return h
    .codexLog()
    .filter((e) => e.method === 'turn/start' && !/as a short chat title/.test(e.params.input?.[0]?.text ?? ''))
    .map((e) => (e.params.input as any[]).map((i) => i.type));
}
const claudeUsers = (h: Harness) => claudeChatMessages(h).map((m) => m.message.content);
const textOf = (c: any) => (typeof c === 'string' ? c : c.map((b: any) => b.text ?? '').join(''));

type Who = 'Codex' | 'Claude Code';
const FAKE = { Codex: 'fake-codex', 'Claude Code': 'fake-claude' } as const;
const reply = (page: Page, who: Who, text: string) => transcript(page).getByText(`${FAKE[who]}: ${text}`, { exact: true });
/** A message of several lines (the fakes' tool-call lines), sent as typed. */
async function sendLines(page: Page, lines: string[]) {
  await composer(page).fill(lines.join('\n'));
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** The line that makes the fake call one of MoPilot's tools in its turn. */
const toolLine = (who: Who, tool: string, args: object) => `${who === 'Codex' ? 'MCPCU' : 'CUCALL'} ${tool} ${JSON.stringify(args)}`;

/** The composer's ring: reported usage, a compact quick view, then context and chat details on demand. */
async function contextUse(page: Page, who: Who) {
  const ring = page.locator('.context-ring');
  // The ring can offer plan usage before the fake Codex reports any context.
  if (who === 'Codex') await expect(page.locator('.context-ring[aria-label^="Context:"]')).toHaveCount(0);
  await send(page, 'CTXUSE how full is the context');
  await expect(reply(page, who, 'CTXUSE how full is the context')).toBeVisible();
  const { used, window } = who === 'Codex' ? CONTEXT.codex : CONTEXT.claude;
  const pct = Math.round((used / window) * 100);
  // the one context number format: thousands to one decimal, a trailing .0 dropped
  const k = (n: number) => `${Number((n / 1000).toFixed(1))}k`;
  await expect(ring).toHaveAccessibleName(new RegExp(`^Context: ${pct}% used, ${k(used)} of ${k(window)} tokens`));
  await ring.hover();
  const tip = page.locator('.context-tip');
  await expect(tip).toContainText(`${pct}% used · ${k(used)} / ${k(window)}`);
  // The quick view leaves composition and actions behind View context.
  await ring.click();
  const panel = page.locator('.ctx-popover');
  await expect(panel.locator('.ctx-summary-value')).toHaveText(`${pct}% used`);
  await expect(panel.getByRole('meter', { name: 'Context used' })).toHaveAttribute(
    'aria-valuetext',
    `${pct}% used, ${k(used)} of ${k(window)} tokens`,
  );
  await expect(panel.getByRole('meter', { name: 'Context used' })).toHaveAttribute('data-level', pct >= 80 ? 'warn' : 'ok');
  await expect(panel.locator('.ctx-legend, .ctx-compact')).toHaveCount(0);
  await panel.getByRole('button', { name: 'View context' }).click();
  await expect(panel).toHaveCount(0);
  const context = page.locator('.dialog', { has: page.getByText('Context', { exact: true }) });
  await expect(context.locator('.ctx-card-big')).toHaveText(`${pct}%`);
  await context.getByRole('button', { name: 'Chat details' }).click();
  const status = page.locator('.dialog', { has: page.getByText('Status', { exact: true }) });
  await expect(status.locator('.status-row', { hasText: 'Context' })).toContainText(`${pct}% used · ${k(used)} / ${k(window)} tokens`);
  await status.getByRole('button', { name: 'Close' }).click();
}

/** Two thoughts back to back read as one row with their time summed; a hook shows only when it failed. */
async function thoughtsAndHooks(page: Page, who: Who) {
  await send(page, 'THINKTWICE then answer');
  await expect(reply(page, who, 'THINKTWICE then answer')).toBeVisible();
  const thought = await openCompletedTurnWork(page, 'THINKTWICE then answer');
  // each took 0.4 s: alone neither reads "Thought for", together they do, in one row
  await expect(thought.getByRole('button', { name: /^Thought/ })).toHaveCount(1);
  const row = thought.getByRole('button', { name: /^Thought for [12]s$/ });
  await row.click();
  await expect(thought.getByText(THOUGHTS[0])).toBeVisible();
  await expect(thought.getByText(THOUGHTS[1])).toBeVisible();

  // a SessionStart hook that passed (it printed a runtime warning) and a Stop hook that failed after the reply
  await send(page, 'HOOKOK HOOKFAIL then answer');
  // the reply stays the turn's answer, not folded away behind the failure that came after it
  await expect(reply(page, who, 'HOOKOK HOOKFAIL then answer')).toBeVisible();
  const completed = transcript(page)
    .locator('.turn')
    .filter({ has: page.getByText('HOOKOK HOOKFAIL then answer', { exact: true }) });
  await completed.waitFor({ state: 'visible' });
  // Reply actions appear only after completion; this turn has no tool work that needs a disclosure.
  await expect(completed.locator('.message-actions')).toHaveCount(1);
  await expect(completed.locator('.worked-for')).toHaveCount(0);
  await expect(completed.getByText(HOOK_FAILURE, { exact: true })).toBeVisible();
  await expect(transcript(page).getByText(/SessionStart|MODULE_TYPELESS_PACKAGE_JSON/)).toHaveCount(0);
  await expect(reply(page, who, 'HOOKOK HOOKFAIL then answer')).toBeVisible();
}

/** wrap_up draws its box only for a question with answers, and its result tells the agent what to write next. */
async function wrapUp(page: Page, who: Who) {
  const box = page.getByRole('region', { name: 'Where this stands' });
  await sendLines(page, ['recap only', toolLine(who, 'wrap_up', { recap: 'The docs are updated.' })]);
  await expect(transcript(page).getByText(/\[cu: .*The app draws no box for this call/)).toBeVisible();
  await expect(box).toHaveCount(0);
  await sendLines(page, ['a question alone', toolLine(who, 'wrap_up', { recap: 'The docs are updated.', ask: 'Publish them?' })]);
  await expect(transcript(page).getByText(/\[cu: .*A question with no answers to click draws no box/)).toBeVisible();
  await expect(box).toHaveCount(0);
  const actions = [{ label: 'Publish' }, { label: 'Not now' }];
  await sendLines(page, ['a question to click', toolLine(who, 'wrap_up', { recap: 'The docs are ready.', ask: 'Publish them?', actions })]);
  await expect(transcript(page).getByText(/\[cu: .*The box ends your turn: write no text after this call/)).toBeVisible();
  await expect(box.locator('.wrap-up-recap')).toHaveText('The docs are ready.');
  await expect(box.locator('.wrap-up-question')).toHaveText('Publish them?');
  await expect(box.getByRole('button')).toHaveText(['Publish', 'Not now']);
  // an answer goes as the user's own reply
  await box.getByRole('button', { name: 'Not now' }).click();
  await expect(reply(page, who, 'Not now')).toBeVisible();
}

test.use({ harnesses: 'both', env: { FAKE_CLAUDE_1M: '1' } });

test('daily-chat-loop on Codex: image attached, a follow-up queued and sent with Steer, edit and resend, compact', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await attachImage(page, harness);
  await send(page, 'what is in this sketch');
  await expect(transcript(page).getByText('fake-codex: what is in this sketch', { exact: true })).toBeVisible();
  await expect(page.locator('.attachment.image')).toHaveCount(0);
  expect(codexInputs(harness)[0]).toEqual(expect.arrayContaining(['text', 'localImage']));

  // a turn that keeps running: a message sent now is queued, then goes out when asked
  await send(page, 'take it SLOW');
  await slowTurnRunning(page, 'fake-codex');
  await send(page, 'also check the docs');
  await expect(queued(page, 'also check the docs')).toBeVisible();
  await queued(page, 'also check the docs').getByRole('button', { name: 'Steer' }).click();
  await expect(transcript(page).getByText('fake-codex: also check the docs', { exact: true })).toBeVisible();
  await expect(queued(page, 'also check the docs')).toHaveCount(0);
  await expect(stop(page)).toHaveCount(0);
  // the fake ends the turn right behind the steer's answer, in one write: the message shows once, and only as a steer
  await expect(transcript(page).getByText('also check the docs', { exact: true })).toHaveCount(1);
  const steered = (e: any) => (e.params?.input ?? []).some((i: any) => i.text === 'also check the docs');
  expect(harness.codexLog().filter((e) => e.method === 'turn/steer' && steered(e))).toHaveLength(1);
  expect(harness.codexLog().filter((e) => e.method === 'turn/start' && steered(e))).toHaveLength(0);

  // edit the last message: the chat goes back to before it, the text returns to the composer, and a new send replaces it
  await send(page, 'update the docs');
  await expect(transcript(page).getByText('fake-codex: update the docs', { exact: true })).toBeVisible();
  const last = transcript(page).getByText('update the docs', { exact: true });
  await last.hover();
  await transcript(page).getByRole('button', { name: 'Edit message' }).last().click();
  await expect(composer(page)).toHaveText('update the docs');
  await expect(transcript(page).getByText('fake-codex: update the docs', { exact: true })).toHaveCount(0);
  expect(harness.codexLog().filter((e) => e.method === 'thread/revert')).toHaveLength(1);
  await send(page, 'check the changelog instead');
  await expect(transcript(page).getByText('fake-codex: check the changelog instead', { exact: true })).toBeVisible();

  // nothing to read before the first reply of a chat; now its context, its thinking, its hooks and its wrap-up
  await contextUse(page, 'Codex');
  await thoughtsAndHooks(page, 'Codex');
  await wrapUp(page, 'Codex');

  // compact the context
  await fill(page, '/compact');
  await page.keyboard.press('Enter');
  await expect(transcript(page).getByText('Context compacted', { exact: true })).toBeVisible();
  expect(
    harness.codexLog().filter((e) => e.method === 'thread/compact/start' && e.params.threadId !== '00000000-0000-0000-0000-000000000000'),
  ).toHaveLength(1);
  release(harness);
});

test('daily-chat-loop on Claude Code: image attached, a follow-up queued and taken back, Stop, edit and resend, compact', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  // A draft has no context reading yet.
  await expect(page.locator('.context-ring[aria-label^="Context:"]')).toHaveCount(0);
  // a 1M-context model carries 1M after its name, as Claude's own menu shows it
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  // the plain model and its 1M variant, each once; this chat runs on the 1M one
  await expect(page.locator('.hp-models .menu-item', { hasText: 'Fake Haiku' })).toHaveCount(2);
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Haiku 1M' }).click();
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake Haiku 1M');
  await attachImage(page, harness);
  await send(page, 'what is in this sketch');
  await expect(transcript(page).getByText('fake-claude: what is in this sketch', { exact: true })).toBeVisible();
  await expect(page.locator('.attachment.image')).toHaveCount(0);
  // the image went with the message as an image block
  expect(claudeUsers(harness)[0].map((b: any) => b.type)).toEqual(expect.arrayContaining(['image', 'text']));

  // a turn that keeps running: a follow-up is queued, shown in the composer and can be taken back
  await send(page, 'take it SLOW');
  await slowTurnRunning(page, 'fake-claude');
  await send(page, 'also check the docs');
  await expect(queued(page, 'also check the docs')).toBeVisible();
  await queued(page, 'also check the docs').getByRole('button', { name: 'Remove from queue' }).click();
  await expect(queued(page, 'also check the docs')).toHaveCount(0);
  // Stop ends the turn and nothing was sent on the side
  await stop(page).click();
  await expect(stop(page)).toHaveCount(0);
  expect(claudeUsers(harness).map(textOf)).not.toContain('also check the docs');

  // edit the last message: files and conversation go back to its checkpoint
  page.on('dialog', (d) => d.accept());
  await send(page, 'update the docs');
  await expect(transcript(page).getByText('fake-claude: update the docs', { exact: true })).toBeVisible();
  const last = transcript(page).getByText('update the docs', { exact: true });
  await last.hover();
  const edit = transcript(page).getByRole('button', { name: 'Edit message' }).last();
  await expect(edit).toBeEnabled();
  await edit.click();
  await expect(composer(page)).toHaveText('update the docs');
  await expect(transcript(page).getByText('fake-claude: update the docs', { exact: true })).toHaveCount(0);
  expect(harness.claudeLog().filter((e: any) => e.kind === 'rewind')).not.toHaveLength(0);
  await send(page, 'check the changelog instead');
  await expect(transcript(page).getByText('fake-claude: check the changelog instead', { exact: true })).toBeVisible();

  await contextUse(page, 'Claude Code');
  await thoughtsAndHooks(page, 'Claude Code');
  await wrapUp(page, 'Claude Code');

  // a running command: its row in the transcript names it, and nothing else says it again
  await send(page, 'RUNCMDSTREAM run the suite');
  await page
    .locator('.approval-card')
    .getByRole('button', { name: /Allow once/ })
    .click();
  await expect(transcript(page).locator('button.claude-activity.expandable .claude-activity-label')).toHaveText(
    runningCommandName('npm test'),
  );
  // said once: no status line under the transcript repeats the step's words
  await expect(page.locator('.claude-activity-label').filter({ hasText: 'npm test' })).toHaveCount(1);
  await expect(page.locator('div.claude-activity[role="status"]').filter({ hasText: 'npm test' })).toHaveCount(0);
  harness.releaseClaudeCommand();
  await expect(transcript(page).getByText(/fake-claude: RUNCMDSTREAM run the suite \[command: ran\]/)).toBeVisible();

  // /compact is Claude's own command: it goes to the CLI as typed
  await send(page, '/compact');
  await expect.poll(() => claudeUsers(harness).map(textOf)).toContain('/compact');
});
