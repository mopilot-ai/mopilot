// Chats that message each other in the cross-session CUJs: a named chat on a harness, the agent's peer tool calls, and
// what main saved (its chats and the peer journal).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, type Harness } from './app';
import { standaloneNewChat } from './sidebar';
import { sessionToken } from '../../../shared/sessionMentions.mjs';
import { openHarnessList } from './harnessPicker';

export type Who = 'Codex' | 'Claude Code' | 'Kimi Code';

/**
 * The Codex CLI's own sign-in ($CODEX_HOME/auth.json), as a signed-in user has it: the peer gate checks a Codex
 * recipient's login in the account pool, which lists that file's login (the fake answers account/read without it).
 */
export const codexLogin = {
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

export const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
export const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
export const transcript = (page: Page) => page.getByRole('main');
export const sidebar = (page: Page) => page.getByRole('complementary');
export const card = (page: Page, dir: 'out' | 'in', title: string) => transcript(page).locator(`.peer-message.${dir}`, { hasText: title });
export const REPLY: Record<Who, string> = { Codex: 'fake-codex', 'Claude Code': 'fake-claude', 'Kimi Code': 'fake-acp' };
export const MODEL: Partial<Record<Who, string>> = { Codex: 'Fake Model One', 'Claude Code': 'Fake Sonnet' };

export async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

export async function pick(page: Page, who: Who) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: who }).click();
  const model = MODEL[who];
  if (model) await page.locator('.hp-models .menu-item', { hasText: model }).click();
}

/** Chat ids main has saved (userData/threads/<id>.v2), with each chat's harness segments and archive state. */
export function saved(h: Harness) {
  const dir = path.join(h.dir, 'userData', 'threads');
  // the folder is made with the first saved chat
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.v2'))
    .map((f) => {
      const v2 = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return { id: decodeURIComponent(f.slice(0, -3)), kinds: (v2.segments ?? []).map((s: any) => s.kind) as string[] };
    });
}

/** The peer journal main keeps (userData/peer-messages.json). */
export const journal = (h: Harness): any[] => {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'peer-messages.json'), 'utf8')).messages ?? [];
  } catch {
    return [];
  }
};

/** A new chat on `who` that has answered `first`, renamed `title`; its id. */
export async function chat(page: Page, h: Harness, who: Who, first: string, title: string) {
  const before = new Set(saved(h).map((c) => c.id));
  await standaloneNewChat(page).click();
  await expect(home(page)).toBeVisible();
  await pick(page, who);
  await send(page, first);
  await expect(transcript(page).getByText(`${REPLY[who]}: ${first}`, { exact: true })).toBeVisible();
  let id = '';
  await expect.poll(() => (id = saved(h).find((c) => !before.has(c.id))?.id ?? ''), { message: 'the new chat is saved' }).not.toBe('');
  // the harness's own title first (the fakes name every chat "Fake chat title", an ACP chat's agent too, #2150)
  const row = sidebar(page).locator('.thread-row.selected');
  await expect(row).toContainText('Fake chat title');
  await row.dblclick();
  await sidebar(page).getByRole('textbox').fill(title);
  await sidebar(page).getByRole('textbox').press('Enter');
  await expect(sidebar(page).locator('.thread-row', { hasText: title })).toBeVisible();
  return id;
}

/** The line that makes each fake call a host tool in its turn. */
export const call = (who: Who, tool: string, args: object) =>
  who === 'Codex' ? `MCPCU ${tool} ${JSON.stringify(args)}` : who === 'Claude Code' ? `CUCALL ${tool} ${JSON.stringify(args)}` : '';

/** "ask @title ..." (the user's request) and the agent's send_message_to_chat call. */
export const ask = (who: Who, verb: string, target: { id: string; title: string }, requestId: string, body: string) =>
  [
    `${verb} ${sessionToken(target.id, target.title)} about this`,
    call(who, 'send_message_to_chat', { targetChatId: target.id, requestId, body }),
  ].join('\n');

export const prompted = (h: Harness, body: string) =>
  h.claudeLog().some((l) => l.kind === 'in' && l.msg?.type === 'user' && JSON.stringify(l.msg.message?.content).includes(body));
