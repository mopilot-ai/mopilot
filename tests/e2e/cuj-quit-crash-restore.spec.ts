// CUJ quit-crash-restore: the Claude Code CLI exits mid-turn while an approval waits (Codex: harness-crash.spec.ts), and
// the app itself is killed while a turn waits on an approval with a message queued, then opened again on the same
// profile: the chat and its history are there, nothing is sent twice, and the approval was never answered. An ACP
// harness's restart is in acp.spec.ts. Queued messages and composer drafts are kept for the app's run only
// (src/lib/peerDrafts.ts, docs/composer-goal.md), so across a restart only "not sent" is asserted for them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { claudeChatProcesses } from './fixtures/claudeChat';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const queued = (page: Page, text: string) =>
  page.getByRole('list', { name: 'Queued messages' }).getByRole('listitem').filter({ hasText: text });
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
// the chat's own words, or the SDK's when it saw the process die first: once, never both (the crash patch lands before
// the CLI's own error, so the turn shows it rather than a second banner, #2847)
// (Windows ends a process with no signal: the SDK says it exited with the code process.kill gave it)
const CLAUDE_CRASHED =
  process.platform === 'win32'
    ? /^Claude Code (quit while working|process exited with code \d+)/
    : /^Claude Code (quit while working|process terminated by signal SIGKILL)/;
const TITLE = /as a short chat title/;

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/** What each harness's fake got as chat messages, in order (title helpers left out). */
const sent: Record<'codex' | 'claude', (h: Harness) => string[]> = {
  codex: (h) =>
    h
      .codexLog()
      .filter((e) => e.method === 'turn/start')
      .map((e) => e.params.input?.[0]?.text ?? '')
      .filter((t) => !TITLE.test(t) && t.trim() !== '/usage'),
  claude: (h) =>
    h
      .claudeLog()
      .filter((e) => e.kind === 'in' && e.msg?.type === 'user' && claudeChatProcesses(h).has(e.pid))
      .map((e: any) => {
        const c = e.msg.message?.content;
        return typeof c === 'string' ? c : (c ?? []).map((b: any) => b.text ?? '').join('');
      })
      .filter((t) => !TITLE.test(t) && t.trim() !== '/usage'),
};

/** Every process under `pid`, deepest first. */
function descendants(pid: number): number[] {
  let kids: number[] = [];
  try {
    kids = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    /* pgrep exits 1 when there are none */
  }
  return kids.flatMap((k) => [...descendants(k), k]);
}

/** The app dies as in a crash (no before-quit, nothing flushed); the harness processes it left go too. */
async function killHard(h: Harness) {
  const pid = h.app.process().pid!;
  const closed = new Promise<void>((r) => h.app.once('close', () => r()));
  // Windows has no pgrep, and its processes keep no group: the whole tree ends at once, as a crash would leave it
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
    await closed;
    return;
  }
  const left = descendants(pid);
  process.kill(pid, 'SIGKILL');
  await closed;
  for (const p of left) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

test.describe('the Claude Code CLI quits mid-turn', () => {
  test.use({ harnesses: 'claude' });

  test('quit-crash-restore on Claude Code: the CLI exits while an approval waits; the card goes, the queue stays and is not sent by itself', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'please RUNCMDLATER');
    await expect(stop(page)).toBeVisible();
    await send(page, 'kept for later');
    await expect(queued(page, 'kept for later')).toBeVisible();
    fs.writeFileSync(path.join(harness.dir, 'fake-claude.jsonl.ask'), '');
    const card = page.getByText('Allow Claude Code to run this command?');
    await expect(card).toBeVisible();

    // the CLI process running the turn dies (SIGKILL: no result, no goodbye)
    // the chat's own CLI: the title helper started at send also received the message's text (#3413)
    const chats = claudeChatProcesses(harness);
    const cli = harness
      .claudeLog()
      .find((e) => e.kind === 'in' && chats.has(e.pid) && JSON.stringify(e.msg).includes('please RUNCMDLATER'))!;
    process.kill(cli.pid, 'SIGKILL');
    await expect(transcript(page).getByText(CLAUDE_CRASHED)).toBeVisible();
    await expect(card).toHaveCount(0);
    await expect(stop(page)).toHaveCount(0);
    await expect(queued(page, 'kept for later')).toBeVisible();

    // the queued message waits for the user; sending it starts the CLI again on the same session
    await page.waitForTimeout(500);
    expect(sent.claude(harness)).toEqual(['please RUNCMDLATER']);
    await queued(page, 'kept for later').getByRole('button', { name: 'Send', exact: true }).click();
    await expect(transcript(page).getByText('fake-claude: kept for later', { exact: true })).toBeVisible();
    await expect(queued(page, 'kept for later')).toHaveCount(0);
    expect(sent.claude(harness)).toEqual(['please RUNCMDLATER', 'kept for later']);
    // the command the card asked for never ran
    await expect(transcript(page).getByText(/\[command: ran\]/)).toHaveCount(0);
  });
});

const CASES = [
  {
    name: 'Codex',
    harnesses: 'codex' as const,
    trigger: 'please CRASH',
    card: 'Allow Codex to run this command?',
    ask: 'fake-codex.jsonl.ask',
    reply: 'fake-codex: after restart',
    sent: sent.codex,
    // the approval request never got an answer
    answered: (h: Harness) => h.codexLog().some((e) => e.method === null && e.response?.result?.decision),
  },
  {
    name: 'Claude Code',
    harnesses: 'claude' as const,
    trigger: 'please RUNCMDLATER',
    card: 'Allow Claude Code to run this command?',
    ask: 'fake-claude.jsonl.ask',
    reply: 'fake-claude: after restart',
    sent: sent.claude,
    answered: (h: Harness) =>
      h.claudeLog().some((e) => e.kind === 'in' && e.msg?.type === 'control_response' && JSON.stringify(e.msg).includes('"behavior"')),
  },
];

for (const c of CASES) {
  test.describe(`the app is killed on ${c.name}`, () => {
    test.use({ harnesses: c.harnesses });

    test(`quit-crash-restore on ${c.name}: killed while an approval waits and a message is queued, reopened: history there, nothing sent twice`, async ({
      page,
      harness,
    }) => {
      await expect(home(page)).toBeVisible();
      await send(page, c.trigger);
      await expect(stop(page)).toBeVisible();
      await send(page, 'kept for later');
      await expect(queued(page, 'kept for later')).toBeVisible();
      fs.writeFileSync(path.join(harness.dir, c.ask), '');
      await expect(page.getByText(c.card)).toBeVisible();

      await killHard(harness);
      await harness.relaunch();
      const p = harness.page;
      await sidebar(p)
        .getByText(/^(Fake chat title|please CRASH|please RUNCMDLATER)$/)
        .first()
        .click();
      await expect(transcript(p).getByText(c.trigger, { exact: true })).toHaveCount(1);
      // the killed turn is over: no card, no Stop
      await expect(p.getByText(c.card)).toHaveCount(0);
      await expect(stop(p)).toHaveCount(0);
      // nothing ran again or went out by itself
      await p.waitForTimeout(1000);
      expect(c.sent(harness)).toEqual([c.trigger]);
      expect(c.answered(harness)).toBe(false);
      // #1744: a Claude transcript MoPilot left mid-turn reads as another app's for up to a minute after the crash
      if (c.harnesses === 'claude') return;
      await expect(composer(p)).toBeEnabled();

      await send(p, 'after restart');
      await expect(transcript(p).getByText(c.reply, { exact: true })).toBeVisible();
      expect(c.sent(harness)).toEqual([c.trigger, 'after restart']);
    });
  });
}
