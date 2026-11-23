import { archiveSidebarChat } from './fixtures/sidebar';
// Critical user journeys on the Claude Code harness, run in the real app against
// tests/e2e/fixtures/fake-claude.mjs (driven through the Agent SDK, as the real CLI is).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { expectGoalRunning, goalCard, goalPill } from './fixtures/goal';
import { agentRow, connectWith, welcomeHeading } from './fixtures/welcome';
import { claudeChatMessages as chatMessages, claudeChatProcesses as chatProcesses, claudeTextOf as textOf } from './fixtures/claudeChat';
import { savedDefaultHarness } from './fixtures/defaultHarness';
import { openHarnessList } from './fixtures/harnessPicker';

// this platform's path separator, as a pattern: '/' on macOS and Linux, '\\' on Windows
const SEP = path.sep.replace(/[\\]/g, '\\\\');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');
/** Idle: no Stop button, and the empty composer shows Dictate (macOS), a voice conversation, or a disabled Send. */
async function expectIdle(page: Page) {
  // exact: an interrupted turn's "Stopped after …" row is a button too
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^(Dictate|Send|Voice conversation)$/ }).first()).toBeVisible();
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** Pick a harness and model in the composer's model menu (a new chat, or a switch in an open one). */
async function pickModel(page: Page, harness: 'Codex' | 'Claude Code', model: string) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
}

/** Start a new chat on Claude from the home view and wait for the first reply. */
async function claudeChat(page: Page, first: string) {
  await expect(home(page)).toBeVisible();
  await pickModel(page, 'Claude Code', 'Fake Sonnet');
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake Sonnet');
  await send(page, first);
  await expect(transcript(page).getByText(`fake-claude: ${first}`, { exact: true })).toBeVisible();
}

/** Control requests chat sessions received, by subtype. */
function chatControls(h: Harness, subtype: string) {
  const chats = chatProcesses(h);
  return h
    .claudeLog()
    .filter((e) => e.kind === 'in' && chats.has(e.pid) && e.msg.type === 'control_request' && e.msg.request.subtype === subtype)
    .map((e) => (e as { msg: any }).msg.request);
}

test.describe('Claude only', () => {
  test.use({ harnesses: 'claude', seed: { uiState: { prefs: { defaultHarness: 'codex' } } } });

  test('first-launch-harness-detect: a signed-in Claude with no Codex opens the main view', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await expect(composer(page)).toBeVisible();
    await expect(welcomeHeading(page)).toHaveCount(0);
    // the saved default is Codex; with no Codex, new chats fall back to Claude for this run
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Fake');
    expect(harness.claudeLog().some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth status --json')).toBe(true);

    // the picker shows Codex as not installed
    await openHarnessList(page);
    await expect(page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' })).toContainText('Not installed');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // a projectless Claude chat starts in a folder the app made, and the fake replies
    await send(page, 'hello without codex');
    await expect(transcript(page).getByText('fake-claude: hello without codex', { exact: true })).toBeVisible();
    await expectIdle(page);
    expect(chatMessages(harness).map(textOf)).toEqual(['hello without codex']);
    const cwds = harness
      .claudeLog()
      .filter((e) => e.kind === 'argv' && chatProcesses(harness).has(e.pid))
      .map((e) => (e as { cwd?: string }).cwd);
    expect(cwds).toHaveLength(1);
    const projectless = path.join(harness.dir, 'home', 'Documents', 'MoPilot');
    expect(path.relative(projectless, cwds[0]!)).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}${SEP}hello-without-codex$`));
    expect(fs.statSync(cwds[0]!).isDirectory()).toBe(true);
    // the fallback was for this run only: the saved default stays Codex
    await expect(() => expect(savedDefaultHarness(harness)).toBe('codex')).toPass({ timeout: 10_000 });
  });
});

test.describe('Nothing usable', () => {
  test.use({ harnesses: 'none' });

  test('first-launch-harness-detect: no Codex and a signed-out Claude show the welcome page', async ({ page }) => {
    await expect(welcomeHeading(page)).toBeVisible();
    // a signed-out Claude Code is asked to sign in, with a Re-check beside it once it has had a while; Codex to install
    await expect(agentRow(page, 'Codex').getByRole('button', { name: 'Install' })).toBeVisible();
    const claude = await connectWith(page, 'Claude Code', 'Claude subscription');
    await expect(claude.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(claude.getByRole('button', { name: 'Re-check' })).toBeVisible({ timeout: 30_000 });
    await expect(home(page)).toHaveCount(0);
    await expect(composer(page)).toHaveCount(0);
  });
});

test.describe('Codex and Claude', () => {
  test.use({ harnesses: 'both' });

  test('first-launch-harness-detect: both harnesses show as signed in', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    const claude = page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' });
    // a usable row shows how much of the plan is left; its accounts open beside it
    await expect(claude).toBeEnabled();
    await expect(claude).toContainText(/\d+% left/);
    await claude.hover();
    await expect(page.locator('.hp-head', { hasText: /^Accounts?$/ })).toBeVisible();
    await expect(page.locator('.acct-email', { hasText: 'fake-user@example.test' })).toBeVisible();
    // the app asked the CLI for its login, then probed it through the SDK's initialize
    const log = harness.claudeLog();
    expect(log.some((e) => e.kind === 'argv' && e.argv.join(' ') === 'auth status --json')).toBe(true);
    expect(log.some((e) => e.kind === 'in' && e.msg.request?.subtype === 'initialize')).toBe(true);
  });

  test('daily-chat-loop: a Claude chat streams replies to two messages', async ({ page, harness }) => {
    await claudeChat(page, 'hello claude');
    await expectIdle(page);
    await send(page, 'and a second one');
    await expect(transcript(page).getByText('fake-claude: and a second one', { exact: true })).toBeVisible();
    await expectIdle(page);

    const msgs = chatMessages(harness);
    expect(msgs.map(textOf)).toEqual(['hello claude', 'and a second one']);
    for (const m of msgs) {
      expect(m.origin).toEqual({ kind: 'human' });
      expect(m.uuid).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(msgs.map((m) => m.uuid)).size).toBe(2);
    // nothing reached Codex but the app's own startup
    expect(harness.codexLog().filter((e) => e.method === 'turn/start')).toHaveLength(0);
  });

  test('daily-chat-loop stop: Stop interrupts a running Claude turn and the chat goes idle', async ({ page, harness }) => {
    await claudeChat(page, 'warm up');
    await send(page, 'take it SLOW');
    await expect(transcript(page).getByText('fake-claude: take it SLOW', { exact: true })).toBeVisible();
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();
    await stop.click();

    await expectIdle(page);
    await expect.poll(() => chatControls(harness, 'interrupt').length).toBe(1);
  });

  test('session defaults: a Claude chat runs on the claude_code system prompt', async ({ page, harness }) => {
    await claudeChat(page, 'which prompt');
    const chats = chatProcesses(harness);
    expect(chats.size).toBe(1);
    const [argv] = [...chats.values()];
    expect(argv).toEqual(
      expect.arrayContaining(['--include-partial-messages', '--setting-sources=user,project,local', '--permission-prompt-tool=stdio']),
    );
    // the SDK sends the preset as "no custom prompt" plus a snapshot flag; a custom (or empty) one
    // would arrive as a systemPrompt list
    const [init] = chatControls(harness, 'initialize');
    expect(init.systemPrompt).toBeUndefined();
    // the only addition is the note that names this app's tool servers, so the model never reaches for a vendor's
    expect(init.appendSystemPrompt).toMatch(/^Tool names in this app: .*mcp__mopilot_browser__\*.*do not exist here/s);
    expect(init.systemPromptSnapshot).toBe(true);
  });

  test('manage-search-archive: rename a Claude chat, then archive it', async ({ page, harness }) => {
    await claudeChat(page, 'a claude chat to rename');
    // the app's title helper gets a fixed title from the fake
    const row = sidebar(page).getByText('Fake chat title', { exact: true });
    await expect(row).toBeVisible();

    await row.dblclick();
    const input = sidebar(page).getByRole('textbox');
    await input.fill('Claude renamed by e2e');
    await input.press('Enter');
    const renamed = sidebar(page).getByText('Claude renamed by e2e', { exact: true });
    await expect(renamed).toBeVisible();
    await expect(row).toHaveCount(0);
    // the new name is written to the session's transcript, where the CLI and other apps read it
    const [argv] = [...chatProcesses(harness).values()];
    const sessionId = argv.find((a) => a.startsWith('--session-id='))!.slice('--session-id='.length);
    const projects = path.join(harness.dir, 'home', '.claude', 'projects');
    const file = fs
      .readdirSync(projects)
      .map((d) => path.join(projects, d, `${sessionId}.jsonl`))
      .find((f) => fs.existsSync(f))!;
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('"customTitle":"Claude renamed by e2e"');

    await renamed.hover();
    await archiveSidebarChat(page, sidebar(page));
    await expect(renamed).toHaveCount(0);
    await expect(home(page)).toBeVisible();
  });

  test('/goal on Claude: the CLI runs the command as typed; the goal runs its rounds to complete', async ({ page, harness }) => {
    await claudeChat(page, 'start here');
    await send(page, '/goal all tests pass');
    await expect(await goalCard(page)).toContainText('all tests pass');
    await expect(goalPill(page)).toContainText('Complete');
    // the card says how many rounds it took; the pill only that it is complete
    await expect(await goalCard(page)).toContainText(/\d+ rounds?/);
    await expect(transcript(page).getByText('Goal set: all tests pass', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText('Goal not met yet: round 2 not done yet', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText('fake-claude: done with all tests pass', { exact: true })).toBeVisible();
    await expectIdle(page);

    // the plain command, as the last block, typed by the user
    const msgs = chatMessages(harness);
    expect(msgs.map(textOf)).toEqual(['start here', '/goal all tests pass']);
    const content = msgs[1].message.content;
    expect(typeof content === 'string' ? content : content.at(-1).text).toBe('/goal all tests pass');
    expect(msgs[1].origin).toEqual({ kind: 'human' });
    // no "Goals are a Codex feature" fallback
    await expect(page.getByText(/Goals are a Codex feature/)).toHaveCount(0);
  });

  test('/goal on Claude: Pause stops the loop, clears the CLI goal, and Resume sends it again', async ({ page, harness }) => {
    await claudeChat(page, 'start here');
    await send(page, '/goal make it SLOW');
    await expect(await goalCard(page)).toContainText('make it SLOW');
    await expectGoalRunning(page);
    // the loop is running its rounds
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();

    await (await goalCard(page)).getByRole('button', { name: 'Pause' }).click();
    await expect(goalPill(page)).toContainText('Paused');
    await expect((await goalCard(page)).getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(transcript(page).getByText('Goal cleared: make it SLOW', { exact: true })).toBeVisible();
    await expectIdle(page);

    // interrupt first, then "/goal clear"; Sage's own command is not the user's
    const chats = chatProcesses(harness);
    const log = harness.claudeLog().filter((e) => e.kind === 'in' && chats.has(e.pid));
    const interrupt = log.findIndex((e) => (e as any).msg.type === 'control_request' && (e as any).msg.request.subtype === 'interrupt');
    const clear = log.findIndex((e) => (e as any).msg.type === 'user' && textOf((e as any).msg) === '/goal clear');
    expect(interrupt).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(interrupt);
    expect((log[clear] as any).msg.origin).toBeUndefined();

    await (await goalCard(page)).getByRole('button', { name: 'Resume' }).click();
    await expectGoalRunning(page);
    await expect
      .poll(() => chatMessages(harness).map(textOf))
      .toEqual(['start here', '/goal make it SLOW', '/goal clear', '/goal make it SLOW']);
    expect(chatMessages(harness)[3].origin).toBeUndefined();

    // Clear stops the loop again and forgets the goal
    await (await goalCard(page)).getByRole('button', { name: 'Clear' }).click();
    await expect(goalPill(page)).toHaveCount(0);
    await expectIdle(page);
    await expect.poll(() => chatMessages(harness).map(textOf).at(-1)).toBe('/goal clear');
  });

  test('/goal on Claude: after the CLI crashed mid-goal, Resume clears the old goal first and then sets it', async ({ page, harness }) => {
    await claudeChat(page, 'start here');
    await send(page, '/goal finish CRASH');
    // the process died after round 1: Sage holds the goal for Resume
    await expect(goalPill(page)).toContainText('Paused');
    await expect((await goalCard(page)).getByRole('button', { name: 'Resume' })).toBeVisible();

    await (await goalCard(page)).getByRole('button', { name: 'Resume' }).click();
    // the reopened session still held the goal, so it is cleared before the condition is set again
    await expect(goalPill(page)).toContainText('Complete');
    await expect(transcript(page).getByText('Goal cleared: finish CRASH', { exact: true })).toBeVisible();
    await expect
      .poll(() => chatMessages(harness).map(textOf))
      .toEqual(['start here', '/goal finish CRASH', '/goal clear', '/goal finish CRASH']);
    await expectIdle(page);
  });

  test('switch with a goal: the sheet says it pauses, and ticking Continue sets it again on the new harness', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, '/goal make it SLOW');
    await expectGoalRunning(page);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(goalPill(page)).toContainText('Paused');
    await expectIdle(page);

    await pickModel(page, 'Claude Code', 'Fake Sonnet');
    const sheet = page.locator('.switch-sheet');
    await expect(sheet).toContainText('Applies to your next message.');
    // across harnesses the goal is not carried by default
    const cont = sheet.getByRole('checkbox', { name: 'Continue the current goal' });
    await expect(cont).not.toBeChecked();
    await cont.check();
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await send(page, 'now on claude');
    await expect(transcript(page).getByText(/fake-claude: <sage-handoff/)).toBeVisible();
    // the goal follows as Claude Code's own /goal command, after the message's turn
    await expect.poll(() => chatMessages(harness).map(textOf).length).toBe(2);
    expect(chatMessages(harness).map(textOf).at(-1)).toBe('/goal make it SLOW');
  });

  test('switch-harness-handoff: a Codex chat continues on Claude with a handoff block', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'begin on codex');
    await expect(transcript(page).getByText('fake-codex: begin on codex', { exact: true })).toBeVisible();
    await expectIdle(page);

    await pickModel(page, 'Claude Code', 'Fake Sonnet');
    // nothing at risk: the pick switches at once; the chip's Options shows the sheet: when it applies, what carries
    // over, and where the conversation goes
    await expect(page.getByText('Next message continues on')).toBeVisible();
    await page.locator('.switch-chip').getByRole('button', { name: 'Options', exact: true }).click();
    const sheet = page.locator('.switch-sheet');
    await expect(sheet.getByRole('heading', { name: 'Continue on Claude Code · Fake Sonnet' })).toBeVisible();
    await expect(sheet).toContainText('Applies to your next message. Your conversation and workspace carry over.');
    await expect(sheet.locator('.ss-privacy')).toHaveText('This conversation will be sent to Anthropic.');
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await expect(page.getByText('Next message continues on')).toBeVisible();
    await send(page, 'now on claude');
    await expect(transcript(page).getByText(/fake-claude: <sage-handoff/)).toBeVisible();
    await expectIdle(page);

    const msgs = chatMessages(harness);
    expect(msgs).toHaveLength(1);
    // the handoff record is a block of its own, before what the user typed (the last block, C11)
    const [handoff, typed] = msgs[0].message.content;
    expect(handoff.text).toMatch(/^<sage-handoff from="Codex" mode="auto">/);
    expect(handoff.text).toContain('begin on codex');
    expect(handoff.text).toMatch(/<\/sage-handoff>$/);
    expect(typed).toEqual({ type: 'text', text: 'now on claude' });
    // the handoff block is Sage's text, not the user's
    expect(msgs[0].origin).toBeUndefined();
    expect(msgs[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
    // main keeps the segments in the chat's v2 file, and mirrors them to the old file for 0.2.0
    const threads = path.join(harness.dir, 'userData', 'threads');
    const kinds = () =>
      fs
        .readdirSync(threads)
        .filter((f) => f.endsWith('.v2'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(threads, f), 'utf8')).segments.map((s: any) => s.kind));
    await expect.poll(kinds).toContainEqual(['codex', 'claude']);
    expect(fs.readdirSync(threads).filter((f) => f.endsWith('.json'))).toHaveLength(1);

    // back on Codex: the conversation carries over, its session resumes with only what happened since (spans below)
    await pickModel(page, 'Codex', 'Fake Model One');
    await page.locator('.switch-chip').getByRole('button', { name: 'Options', exact: true }).click();
    await expect(page.locator('.switch-sheet')).toContainText('Your conversation and workspace carry over.');
    await page.getByRole('button', { name: 'Switch', exact: true }).click();
    await send(page, 'back on codex');
    await expect(transcript(page).getByText('Back on Codex', { exact: true })).toBeVisible();
    // main wrote the segments from the history it read itself: each turn counted once, the way back resumes the first session
    const spans = () =>
      fs
        .readdirSync(threads)
        .filter((f) => f.endsWith('.v2'))
        .map((f) =>
          JSON.parse(fs.readFileSync(path.join(threads, f), 'utf8')).segments.map((s: any) => [
            s.kind,
            s.start,
            s.count,
            s.handoff?.mode ?? null,
          ]),
        );
    await expect.poll(spans).toContainEqual([
      ['codex', 0, 1, null],
      ['claude', 1, 1, 'auto'],
      ['codex', 2, null, 'delta'],
    ]);
  });
});

test.describe('Codex starts on demand (D-66)', () => {
  test.use({ harnesses: 'both', seed: { uiState: { prefs: { harness: 'claude' } } } });

  test('with Claude Code as the default, the app-server stays down until the harness list is opened', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    // only the one-off project import has asked Codex anything: the app's own connection reads the account
    const methods = () => harness.codexLog().map((e) => (e as any).method);
    await expect.poll(methods).toContain('project/list');
    expect(methods()).not.toContain('account/read');
    await openHarnessList(page);
    // the harness list is Codex's first use
    await expect(page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' })).toBeVisible();
    await expect.poll(methods).toContain('account/read');
  });
});
