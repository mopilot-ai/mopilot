// A turn the user started stops carrying the user's word once another chat's message is steered into it (#2249): chat A
// runs a long turn the user started, chat B asks it (send_message_to_chat automatically steers it in) to call
// start_session, and the call is refused with not_user_turn and no linked session appears, on Claude Code and on Codex.
// Control: the user asking A directly still starts one.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';
import { standaloneNewChat } from './fixtures/sidebar';
import { sessionToken } from '../../shared/sessionMentions.mjs';
import { openHarnessList } from './fixtures/harnessPicker';
import { claudeChatProcesses } from './fixtures/claudeChat';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

type Who = 'Codex' | 'Claude Code';

/** The Codex CLI's own sign-in, as a signed-in user has it: the peer gate checks a Codex recipient's login. */
const codexLogin = {
  files: ({ codexHome }: { codexHome: string }) => {
    const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
    const auth = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-cuj', chatgpt_plan_type: 'plus' } };
    const tokens = {
      access_token: jwt({ ...auth, exp: 4e9 }),
      id_token: jwt({ ...auth, email: 'cuj@example.test' }),
      refresh_token: 'fake',
      account_id: 'acct-cuj',
    };
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens }));
  },
};

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');
const REPLY: Record<Who, string> = { Codex: 'fake-codex', 'Claude Code': 'fake-claude' };
const MODEL: Record<Who, string> = { Codex: 'Fake Model One', 'Claude Code': 'Fake Sonnet' };
/** The line that makes each fake call one of MoPilot's tools in its turn. */
const call = (who: Who, tool: string, args: object) => `${who === 'Codex' ? 'MCPCU' : 'CUCALL'} ${tool} ${JSON.stringify(args)}`;
const startArgs = (title: string) => ({
  initiation: 'user_asked',
  context: 'fresh',
  use_worktree: false,
  title,
  prompt: 'Say hi',
  background:
    'This independent greeting belongs to the current user request. Stay in the assigned folder, retain its permissions, and report the outcome to the parent.',
});
const fakeLog = (h: Harness, who: Who) => path.join(h.dir, who === 'Codex' ? 'fake-codex.jsonl' : 'fake-claude.jsonl');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function pick(page: Page, who: Who) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  await page.locator('.hp-models .menu-item', { hasText: MODEL[who] }).click();
}

/** Chat ids main has saved (userData/threads/<id>.v2). */
function saved(h: Harness) {
  const dir = path.join(h.dir, 'userData', 'threads');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.v2'))
    .map((f) => decodeURIComponent(f.slice(0, -3)));
}

/** The linked sessions main has started (userData/orchestration.json), by title. */
const linked = (h: Harness): string[] => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8'));
    return Object.values<any>(j.children ?? {}).map((c) => c.title);
  } catch {
    return [];
  }
};

/** A new chat on `who` that has answered `first`, renamed `title`; its id. */
async function chat(page: Page, h: Harness, who: Who, first: string, title: string) {
  const before = new Set(saved(h));
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pick(page, who);
  await send(page, first);
  await expect(transcript(page).getByText(`${REPLY[who]}: ${first}`, { exact: true })).toBeVisible();
  let id = '';
  await expect.poll(() => (id = saved(h).find((c) => !before.has(c)) ?? ''), { message: 'the new chat is saved' }).not.toBe('');
  const row = sidebar(page).locator('.thread-row.selected');
  await expect(row).toContainText('Fake chat title');
  await row.dblclick();
  await sidebar(page).getByRole('textbox').fill(title);
  await sidebar(page).getByRole('textbox').press('Enter');
  await expect(sidebar(page).locator('.thread-row', { hasText: title })).toBeVisible();
  return id;
}

const open = (page: Page, title: string) => sidebar(page).locator('.thread-row', { hasText: title }).click();

test.use({ harnesses: 'both', seed: codexLogin });

for (const who of ['Claude Code', 'Codex'] as const) {
  test(`${who}: a start_session another chat's message steered into the user's turn asks for is refused; the user's own starts one`, async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const target = await chat(page, harness, who, 'hello', 'Target');
    await chat(page, harness, 'Claude Code', 'hi there', 'Sender');

    // A runs a long turn the user started: the fake holds it until the test lets it go
    await open(page, 'Target');
    await expect(transcript(page).getByText(`${REPLY[who]}: hello`, { exact: true })).toBeVisible();
    const hold = `${fakeLog(harness, who)}.hold-next`;
    fs.writeFileSync(hold, '');
    const heldPrompt = 'work through the quarterly report';
    await send(page, heldPrompt);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect.poll(() => fs.existsSync(hold), { message: 'the turn is held' }).toBe(false);
    let heldClaudePid: number | undefined;
    let heldCodexThread: string | undefined;
    let startsBeforePeer: ReturnType<Harness['codexLog']> = [];
    if (who === 'Claude Code') {
      await expect
        .poll(() => {
          const chatProcesses = claudeChatProcesses(harness);
          heldClaudePid = harness
            .claudeLog()
            .find(
              (l) =>
                l.kind === 'in' &&
                chatProcesses.has(l.pid) &&
                l.msg?.type === 'user' &&
                JSON.stringify(l.msg.message?.content).includes(heldPrompt),
            )?.pid;
          return heldClaudePid;
        })
        .toEqual(expect.any(Number));
    } else {
      await expect
        .poll(() => {
          const log = harness.codexLog();
          heldCodexThread = log.find((l) => l.method === 'turn/start' && JSON.stringify(l.params.input).includes(heldPrompt))?.params
            .threadId;
          startsBeforePeer = log.filter((l) => l.method === 'turn/start' && l.params.threadId === heldCodexThread);
          return heldCodexThread;
        })
        .toEqual(expect.any(String));
    }
    const targetStarts = () => harness.codexLog().filter((l) => l.method === 'turn/start' && l.params.threadId === heldCodexThread);

    // B asks A to start a session; native harnesses automatically steer it into A's running turn
    await open(page, 'Sender');
    // the composer is the Sender's before anything is typed (a chat switch remounts it)
    await expect(transcript(page).getByText('fake-claude: hi there', { exact: true })).toBeVisible();
    const body = call(who, 'start_session', startArgs('STEERPROBE'));
    const t0 = Date.now();
    await send(
      page,
      [
        `ask ${sessionToken(target, 'Target')} to start a session`,
        call('Claude Code', 'send_message_to_chat', { targetChatId: target, requestId: 'steer-1', body }),
      ].join('\n'),
    );
    // Claude Code takes the steered message once its held turn lets go; Codex runs it as the steer lands
    if (who === 'Claude Code') {
      await expect
        .poll(() =>
          harness
            .claudeLog()
            .some(
              (l) =>
                l.kind === 'in' &&
                l.pid === heldClaudePid &&
                l.msg?.type === 'user' &&
                JSON.stringify(l.msg.message?.content).includes('STEERPROBE'),
            ),
        )
        .toBe(true);
      fs.writeFileSync(`${fakeLog(harness, who)}.release`, '');
    } else {
      await expect
        .poll(() =>
          harness
            .codexLog()
            .some(
              (l) =>
                l.method === 'turn/steer' &&
                l.params.threadId === heldCodexThread &&
                typeof l.params.expectedTurnId === 'string' &&
                l.params.expectedTurnId.length > 0 &&
                JSON.stringify(l.params.input).includes('STEERPROBE'),
            ),
        )
        .toBe(true);
    }

    // the call is refused as not the user's turn, and no linked session appears
    await open(page, 'Target');
    await expect(
      transcript(page)
        .getByText(/wasn't started by the user, so it can't start a session/)
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });
    console.log(`[user-turn-steer] ${who}: refused ${Date.now() - t0} ms after the peer send`);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    expect(linked(harness)).toEqual([]);
    await expect(sidebar(page).getByRole('group', { name: 'Sessions this chat started' })).toHaveCount(0);
    if (who === 'Codex') await expect.poll(targetStarts).toEqual(startsBeforePeer);

    // control: the user asking A directly starts one
    await send(page, ['start a linked session to say hi', call(who, 'start_session', startArgs('USERPROBE'))].join('\n'));
    await expect.poll(() => linked(harness), { timeout: 30_000 }).toEqual(['USERPROBE']);
    await expect(sidebar(page).getByRole('group', { name: 'Sessions this chat started' }).locator('.thread-row')).toHaveCount(1);
  });
}
