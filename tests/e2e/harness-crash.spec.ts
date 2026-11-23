// A harness that quits mid-turn (A23): the Codex app-server exits while a turn waits on an approval.
// The chat shows why, the card goes away, the queued message stays (and isn't sent by itself), and
// main brings the app-server back after a backoff. Then Codex staying down (its chats from disk, Retry, Restart,
// Continue in Claude Code) and a default copy that keeps quitting (fixtures/fake-codex-down.mjs quits it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { test, expect, FAKE_CODEX, type Dirs, type Harness } from './fixtures/app';
import { claudeChatMessages } from './fixtures/claudeChat';
import { openSettingsSection, settingsEntry } from './fixtures/settings';
import { standaloneNewChat } from './fixtures/sidebar';
import { openHarnessList } from './fixtures/harnessPicker';
import { nodeCommand } from './fixtures/nodeCommand';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
// queued messages are listed above the composer
const queued = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: text });
const card = (page: Page) => page.getByText('Allow Codex to run this command?');
const CRASHED = 'Codex quit while working. Pending approvals were cancelled · Your queued messages are kept';

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}
/** Tell the fake's CRASH turn to go on: 'ask' sends the approval request, 'crash' exits. */
const signal = (h: Harness, what: 'ask' | 'crash') => fs.writeFileSync(path.join(h.dir, `fake-codex.jsonl.${what}`), '');
const turnStarts = (h: Harness) =>
  h.codexLog().filter((e) => e.method === 'turn/start' && !/short chat title/.test(e.params.input?.[0]?.text ?? ''));

test('harness-crash: Codex quits mid-turn; the card goes, the queue stays, and Codex comes back after a backoff', async ({
  page,
  harness,
}) => {
  await expect(home(page)).toBeVisible();
  await send(page, 'please CRASH');
  await expect(transcript(page).getByText('working on it')).toBeVisible();
  await send(page, 'kept for later');
  await expect(queued(page, 'kept for later')).toBeVisible();
  signal(harness, 'ask');
  await expect(card(page)).toBeVisible();
  const threadId = turnStarts(harness)[0].params.threadId as string;

  signal(harness, 'crash');
  await expect(transcript(page).getByText(CRASHED)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(queued(page, 'kept for later')).toBeVisible();
  const s = await page.evaluate((id) => (window as any).native.session.snapshot(id), threadId);
  expect(s).toMatchObject({ turn: 'crashed', crashed: CRASHED, approvals: [], activeTurn: null });
  expect(s.queue.map((q: any) => q.text)).toEqual(['kept for later']);

  // main starts the app-server again after the first wait, not at once; the chat stays on screen
  await expect(page.getByText('Codex quit. Restarting it…')).toBeVisible();
  const inits = () => harness.codexLog().filter((e) => e.method === 'initialize');
  await expect.poll(() => inits().length, { timeout: 15_000 }).toBe(2);
  const crashedAt = harness.codexLog().find((e) => e.method === 'fake/crash')!.at;
  expect(inits()[1].at - crashedAt).toBeGreaterThanOrEqual(900);
  await expect(page.getByText('Codex quit. Restarting it…')).toHaveCount(0);
  // the crashed turn still says why, and isn't taken for another app's
  await expect(transcript(page).getByText(CRASHED)).toBeVisible();
  await expect(page.getByText('Another Codex app is working on this chat.')).toHaveCount(0);

  // the queued message was kept, not sent by itself; sending it now runs on the restarted Codex
  await page.waitForTimeout(500);
  expect(turnStarts(harness)).toHaveLength(1);
  await queued(page, 'kept for later').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: kept for later', { exact: true })).toBeVisible();
  await expect(queued(page, 'kept for later')).toHaveCount(0);
  expect(turnStarts(harness).map((e) => e.params.threadId)).toEqual([threadId, threadId]);
});

// Codex stays down (#2056, #2039): the app-server quits and every start after it quits too, so main gives up restarting
// it. A chat shows its history from Codex's rollout file, read-only, with Restart Codex and Continue in Claude Code; a
// chat with no rollout says why, with Retry, which restarts Codex; once Codex runs again each chat reads from it and
// carries on. Claude Code is signed in too: with no harness left to run a chat, the app goes back to its first-run page.
const fakeLog = (h: Harness) => path.join(h.dir, 'fake-codex.jsonl');
/** The running app-server quits, and every start after it quits as it starts (fixtures/fake-codex-down.mjs). */
function bringCodexDown(h: Harness) {
  fs.writeFileSync(`${fakeLog(h)}.down`, '');
  fs.writeFileSync(`${fakeLog(h)}.quit`, '');
}
const letCodexStart = (h: Harness) => fs.rmSync(`${fakeLog(h)}.down`, { force: true });
const starts = (h: Harness) => h.codexLog().filter((e) => e.method === 'fake/start');
/** The rollout file Codex wrote for a thread, under $CODEX_HOME/sessions, or null. */
function rolloutOf(h: Harness, threadId: string): string | null {
  const root = path.join(h.dir, 'home', '.codex', 'sessions');
  if (!fs.existsSync(root)) return null;
  const file = (fs.readdirSync(root, { recursive: true }) as string[]).find((f) => f.endsWith(`-${threadId}.jsonl`));
  return file ? path.join(root, file) : null;
}
const replyOf = (page: Page, text: string) => transcript(page).getByText(`fake-codex: ${text}`, { exact: true });
const downNotice = (page: Page) => page.locator('.elsewhere-notice');
const gaveUp = (page: Page) => page.locator('.acct-banner', { hasText: 'keeps quitting' });

async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await page.keyboard.press('Escape');
}
/** A new Codex chat with these messages, each answered; its thread id, once Codex has written its rollout. */
async function codexChat(page: Page, h: Harness, ...messages: string[]): Promise<string> {
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Codex', 'Fake Model One');
  for (const m of messages) {
    await send(page, m);
    await expect(replyOf(page, m)).toBeVisible();
  }
  const id = turnStarts(h).at(-1)!.params.threadId as string;
  await expect.poll(() => rolloutOf(h, id)).not.toBeNull();
  return id;
}
/** Opens the sidebar chat that shows `shown` (every chat has the fake's title). */
async function openChat(page: Page, shown: () => Locator) {
  const rows = page.getByRole('complementary').locator('.thread-row');
  await expect(rows.first()).toBeVisible();
  for (let i = 0; i < (await rows.count()); i++) {
    await rows.nth(i).click();
    const hit = await shown()
      .first()
      .waitFor({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (hit) return;
  }
  throw new Error('no chat shows what was asked for');
}
/** Codex goes down and main gives up restarting it (after 1 s, 4 s and 15 s, A23), naming the copy the fixture pins. */
async function codexGivesUp(page: Page, h: Harness) {
  bringCodexDown(h);
  await expect(page.getByText(/Codex quit\. Restarting it/)).toBeVisible();
  await expect(gaveUp(page)).toContainText("keeps quitting, so MoPilot stopped restarting it. It's the copy you picked.", {
    timeout: 45_000,
  });
  // the copy the fixture pins: fake-codex.mjs, or on Windows the launcher that runs it (fixtures/app.ts fakeBin)
  await expect(gaveUp(page)).toContainText(path.basename(h.env.CODEX_BIN));
  await expect(gaveUp(page).getByRole('button', { name: 'Restart Codex' })).toBeVisible();
}

/**
 * The GitHub runner's screen (1024×768, a 1024×682 window) on every machine: with the side panels open the chat column
 * is about 440px wide, where the gave-up banner once went a letter a line and left the transcript no height (#2119,
 * #2120). Its content size.
 */
const runnerWindow = (h: Harness) =>
  h.app.evaluate(({ BrowserWindow }) => {
    const sizes: number[][] = [];
    for (const w of BrowserWindow.getAllWindows())
      if (w.webContents.getURL().startsWith('file:')) {
        w.setContentSize(1024, 682);
        sizes.push(w.getContentSize());
      }
    return sizes;
  });

test.describe('Codex stays down', () => {
  test.use({ harnesses: 'both', env: { FAKE_CODEX_ROLLOUTS: '1' } });
  test.beforeEach(async ({ harness }) => {
    // the window may not have loaded its page yet, so it is not a file: window until it has
    await expect.poll(() => runnerWindow(harness)).toEqual([[1024, expect.any(Number)]]);
  });

  /**
   * Chat A (two turns, its rollout on disk) and chat B (one turn, its rollout removed), then Codex goes down and main
   * gives up; chat B is on screen.
   */
  async function twoChatsThenDown(page: Page, harness: Harness) {
    await expect(home(page)).toBeVisible();
    const a = await codexChat(page, harness, 'first question', 'second question');
    await expect(replyOf(page, 'first question')).toBeVisible();
    const b = await codexChat(page, harness, 'other chat');
    // chat B has no history on disk: its read can only fail while Codex is down
    fs.rmSync(rolloutOf(harness, b)!);
    // chat A's rollout holds both of its turns
    const rollout = fs.readFileSync(rolloutOf(harness, a)!, 'utf8');
    expect(rollout).toContain('"message":"first question"');
    expect(rollout).toContain('"message":"fake-codex: second question"');
    await codexGivesUp(page, harness);
    return { a, b };
  }
  const readError = (page: Page) => transcript(page).locator('.error-banner');
  const retry = (page: Page) => readError(page).getByRole('button', { name: 'Retry', exact: true });
  const scrollToTop = (page: Page) =>
    page
      .getByRole('region', { name: 'Primary pane' })
      .locator('.thread-scroll')
      .first()
      .evaluate((el) => el.scrollTo({ top: 0 }));

  test('harness-crash: a chat shows its history from disk; a chat without it says why; Restart Codex brings both back from Codex', async ({
    page,
    harness,
  }) => {
    test.setTimeout(180_000);
    const { a, b } = await twoChatsThenDown(page, harness);
    // the chat on screen keeps what it showed, and can't send: the notice stands in for the composer
    await expect(replyOf(page, 'other chat')).toBeVisible();
    await expect(downNotice(page)).toContainText("Codex isn't running, so this chat can't send.");
    await expect(composer(page)).toHaveCount(0);

    // chat A is read from its rollout file, read-only, with the ways forward
    await openChat(page, () => replyOf(page, 'second question'));
    await expect(transcript(page).getByText('second question', { exact: true })).toBeVisible();
    // main reads both turns from the rollout, and the chat holds both (and both are drawn, the test below, #2119)
    const fromDisk = await page.evaluate((id) => (window as any).native.codex.rolloutHistory(id, { hint: null, limit: 30 }), a);
    expect(fromDisk.turns.map((t: any) => t.items.map((i: any) => i.text ?? i.content[0].text))).toEqual([
      ['first question', 'fake-codex: first question'],
      ['second question', 'fake-codex: second question'],
    ]);
    await expect(page.getByRole('region', { name: 'Primary pane' }).locator('[data-turn-slot]')).toHaveCount(2);
    await expect(downNotice(page)).toContainText("Codex isn't running, so this chat can't send.");
    await expect(downNotice(page)).toContainText('Its messages are read from disk until it runs again.');
    await expect(downNotice(page).getByRole('button', { name: 'Restart Codex' })).toBeVisible();
    await expect(downNotice(page).getByRole('button', { name: 'Continue in Claude Code' })).toBeVisible();
    await expect(composer(page)).toHaveCount(0);

    // chat B's read fails with nothing on disk to stand in: it says why, with Retry and what to do about the copy
    await openChat(page, () => retry(page));
    await expect(readError(page).getByRole('button', { name: 'Use another Codex' })).toBeVisible();
    await expect(downNotice(page)).not.toContainText('read from disk');

    // Codex can start again: the notice's Restart Codex brings it back, and Codex's read takes the error away (#2039)
    letCodexStart(harness);
    await downNotice(page).getByRole('button', { name: 'Restart Codex' }).click();
    await expect(readError(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(replyOf(page, 'other chat')).toBeVisible();
    await expect(gaveUp(page)).toHaveCount(0);
    await expect(downNotice(page)).toHaveCount(0);
    await expect(composer(page)).toBeEnabled();

    // chat A is read from Codex again, both turns drawn, and carries on in the same thread
    await openChat(page, () => replyOf(page, 'second question'));
    await expect(downNotice(page)).toHaveCount(0);
    await scrollToTop(page);
    await expect(replyOf(page, 'first question')).toBeVisible();
    await send(page, 'third question');
    await expect(replyOf(page, 'third question')).toBeVisible();
    expect(turnStarts(harness).map((e) => [e.params.threadId, e.params.input[0].text])).toEqual([
      [a, 'first question'],
      [a, 'second question'],
      [b, 'other chat'],
      [a, 'third question'],
    ]);
  });

  // a chat read from disk draws every turn it holds, the first too once scrolled to the top: the transcript keeps its
  // height between the gave-up banner and the down notice (#2119)
  test('harness-crash: a chat read from disk draws every turn it holds (#2119)', async ({ page, harness }) => {
    test.setTimeout(180_000);
    await twoChatsThenDown(page, harness);
    await openChat(page, () => replyOf(page, 'second question'));
    await expect(downNotice(page)).toContainText('Its messages are read from disk until it runs again.');
    await scrollToTop(page);
    await expect(replyOf(page, 'first question')).toBeVisible();
    await expect(transcript(page).getByText('first question', { exact: true })).toBeVisible();
  });

  // with Codex down, the chat's own Retry (its read error) is clear of the down notice and the gave-up banner, which
  // wraps its actions in the runner's narrow window rather than push the transcript out of the pane (#2120)
  test("harness-crash: a chat's Retry restarts a Codex that is down, and once Codex can start, brings the chat back (#2120)", async ({
    page,
    harness,
  }) => {
    test.setTimeout(180_000);
    await twoChatsThenDown(page, harness);
    // chat B on screen keeps what it showed; opened again, its read fails with nothing on disk, with Retry
    await openChat(page, () => replyOf(page, 'second question'));
    await openChat(page, () => retry(page));
    await expect(retry(page)).toBeVisible();
    // Retry restarts Codex, which still quits: the chat names the copy, and keeps Retry
    const before = starts(harness).length;
    await retry(page).click();
    await expect.poll(() => starts(harness).length).toBeGreaterThan(before);
    await expect(readError(page)).toContainText(/keeps quitting\. It's the copy you picked, so MoPilot keeps using it\./);
    await expect(retry(page)).toBeVisible();
    // Codex can start again: Retry brings it back, and Codex's read of the chat takes the error away
    letCodexStart(harness);
    await retry(page).click();
    await expect(readError(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(replyOf(page, 'other chat')).toBeVisible();
    await expect(gaveUp(page)).toHaveCount(0);
    await expect(downNotice(page)).toHaveCount(0);
    await expect(composer(page)).toBeEnabled();
  });

  test('harness-crash: with Codex down, Continue in Claude Code carries the conversation, and Restart Codex brings its chats back', async ({
    page,
    harness,
  }) => {
    test.setTimeout(180_000);
    await expect(home(page)).toBeVisible();
    await codexChat(page, harness, 'plan the release');
    const c = await codexChat(page, harness, 'write the notes');

    await codexGivesUp(page, harness);
    // the plan chat, read from disk, goes on in Claude Code
    await openChat(page, () => replyOf(page, 'plan the release'));
    await expect(downNotice(page)).toContainText('Its messages are read from disk until it runs again.');
    await downNotice(page).getByRole('button', { name: 'Continue in Claude Code' }).click();
    // nothing at risk: the switch goes ahead at once; the chip's Options shows the sheet
    await expect(page.getByText('Next message continues on')).toBeVisible();
    await page.locator('.switch-chip').getByRole('button', { name: 'Options', exact: true }).click();
    await expect(page.getByRole('heading', { name: /Continue on Claude Code · / })).toBeVisible();
    await expect(page.getByText('Applies to your next message. Your conversation and workspace carry over.')).toBeVisible();
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    // the composer is back: the next message goes to Claude Code, which is running
    await expect(downNotice(page)).toHaveCount(0);
    await send(page, 'carry on from here');
    await expect(transcript(page).getByText(/fake-claude: <sage-handoff/)).toBeVisible();
    // the handoff carries what Codex's rollout holds, though Codex can't be asked
    const msgs = claudeChatMessages(harness);
    expect(msgs).toHaveLength(1);
    const [handoff, typed] = msgs[0].message.content;
    expect(handoff.text).toMatch(/^<sage-handoff from="Codex" mode="auto">/);
    expect(handoff.text).toContain('plan the release');
    expect(handoff.text).toContain('fake-codex: plan the release');
    expect(typed).toEqual({ type: 'text', text: 'carry on from here' });
    await expect(replyOf(page, 'plan the release')).toBeVisible();

    // the notes chat is still on Codex: Restart Codex, once Codex can start, brings its composer back
    await openChat(page, () => replyOf(page, 'write the notes'));
    await expect(downNotice(page)).toContainText('Its messages are read from disk until it runs again.');
    letCodexStart(harness);
    await downNotice(page).getByRole('button', { name: 'Restart Codex' }).click();
    await expect(downNotice(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(gaveUp(page)).toHaveCount(0);
    await send(page, 'and the changelog');
    await expect(replyOf(page, 'and the changelog')).toBeVisible();
    expect(turnStarts(harness).at(-1)!.params.threadId).toBe(c);
    expect(claudeChatMessages(harness)).toHaveLength(1);
  });
});

// Codex prefers a stable install and falls back from a copy that keeps quitting (#2046). Three copies are installed:
// the fixture's (a newer prerelease, CODEX_BIN), 9.1.0 on the login shell's PATH (it quits as it starts) and 9.0.0 in
// ~/.codex/bin. With the user's pick reset, main runs the newest release, sets it aside after two failed starts, and
// moves to the next release, never the prerelease; a chat then runs on it.
const COPIES = fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-codex-copies-'));
/** A copy of the fake Codex installed in `dir` (codex, codex.exe on Windows); its path. */
const codexCopy = (dir: string, version: string, quits: boolean) =>
  nodeCommand(dir, 'codex', FAKE_CODEX, { FAKE_CODEX_VERSION: version, ...(quits ? { FAKE_CODEX_QUIT_ON_START: '1' } : {}) });
codexCopy(COPIES, '9.1.0', true);

test.describe('a default Codex copy that keeps quitting', () => {
  test.use({
    harnesses: 'both',
    shellPath: [COPIES],
    env: { FAKE_CODEX_VERSION: '9.2.0-alpha.1' },
    seed: {
      files: (d: Dirs) => {
        codexCopy(path.join(d.codexHome, 'bin'), '9.0.0', false);
      },
    },
  });

  test('harness-crash: with the pick reset, Codex runs the newest release, and moves to the next one when it keeps quitting', async ({
    page,
    harness,
  }) => {
    test.setTimeout(120_000);
    await expect(home(page)).toBeVisible();
    // the copy the fixture pins runs first
    expect(starts(harness).map((e) => e.params.version)).toEqual(['9.2.0-alpha.1']);

    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await openSettingsSection(page, 'codex');
    await page.locator('.settings-tabs').getByText('Advanced', { exact: true }).click();
    await page.getByRole('button', { name: 'Codex CLI options' }).click();
    await expect(page.getByText('3 installs found')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Reset' }).click();

    // 9.1.0 quits twice before it answers; 9.0.0 takes over, and the prerelease is not run again
    await expect(page.locator('.toast').filter({ hasText: 'kept quitting' })).toContainText(
      /Codex 9\.1\.0 .+ kept quitting, so MoPilot is using Codex 9\.0\.0 .+ instead\./,
      { timeout: 30_000 },
    );
    // (the Reset's own restart counts as a stop on purpose, so the failed starts may be counted from the one after it)
    await expect.poll(() => starts(harness).at(-1)?.params.version).toBe('9.0.0');
    const versions = starts(harness).map((e) => e.params.version);
    const failed = versions.slice(1, -1);
    expect(versions[0]).toBe('9.2.0-alpha.1');
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(failed.every((v) => v === '9.1.0')).toBe(true);
    const quits = harness.codexLog().filter((e) => e.method === 'fake/quit');
    expect(quits.map((e) => e.params.version)).toEqual(failed);
    await expect(gaveUp(page)).toHaveCount(0);
    // Settings names the copy in use (the window reloaded onto it)
    if (!(await page.locator('.settings-nav').isVisible())) {
      await page.locator('.sidebar-title').first().click();
      await settingsEntry(page).click();
    }
    await openSettingsSection(page, 'codex');
    await page.locator('.settings-tabs').getByText('Advanced', { exact: true }).click();
    const version = page.locator('.settings-row', { has: page.getByText('Version', { exact: true }) });
    await expect(version.locator('.cli-line')).toContainText('9.0.0');
    const stable = path.join(harness.dir, 'home', '.codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    await expect(version.locator('.cli-line')).toHaveAttribute('title', stable);

    // a chat runs on the copy main moved to
    await page.locator('.side-row', { hasText: 'Back to app' }).click();
    await standaloneNewChat(page).click();
    await pickModel(page, 'Codex', 'Fake Model One');
    await send(page, 'on the stable copy');
    await expect(replyOf(page, 'on the stable copy')).toBeVisible();
    expect(starts(harness).at(-1)!.params.version).toBe('9.0.0');
  });
});
