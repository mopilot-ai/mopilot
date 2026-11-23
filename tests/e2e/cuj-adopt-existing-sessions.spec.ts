// CUJ adopt-existing-sessions: a user arriving from the Codex app and from Claude Code finds the thread and the session
// they already have in the sidebar, continues each in MoPilot, and a turn the other app runs on it afterwards shows up
// (the other app only writes the Codex rollout file or the Claude Code transcript). A turn the other app is still
// running when the chat opens is external-writes.spec.ts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const sidebar = (page: Page) => page.getByRole('complementary');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const CLAUDE_ID = 'bbbbbbbb-1111-4222-8333-444444444444';

test.use({
  harnesses: 'both',
  seed: {
    codexThreads: [{ id: 'codex-old', name: 'From the Codex app', turns: ['set up the repo'], rollout: true }],
    claudeSessions: [{ id: CLAUDE_ID, cwd: 'proj', title: 'From Claude Code', turns: ['write the readme'] }],
  },
});

test('adopt-existing-sessions on Codex: the Codex app thread is listed, continues here, and a later turn from that app shows up', async ({
  page,
  harness,
}) => {
  await sidebar(page).getByText('From the Codex app', { exact: true }).first().click();
  await expect(transcript(page).getByText('fake-codex: set up the repo', { exact: true })).toBeVisible();
  await send(page, 'add tests');
  await expect(transcript(page).getByText('fake-codex: add tests', { exact: true })).toBeVisible();
  const resumed = harness.codexLog().filter((e) => e.method === 'turn/start' && e.params.threadId === 'codex-old');
  expect(resumed).toHaveLength(1);

  // the Codex app runs a turn on the same thread once MoPilot has let go of it (idle), writing its rollout file
  fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.external-codex-old'), 'fix the lint');
  const rollout = path.join(harness.dir, 'home', '.codex', 'sessions', 'rollout-codex-old.jsonl');
  await expect(async () => {
    fs.appendFileSync(rollout, '{"turn":"other app"}\n');
    await expect(transcript(page).getByText('other app: fix the lint', { exact: true })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(transcript(page).getByText('fake-codex: add tests', { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
});

test('adopt-existing-sessions on Claude Code: the session is listed, continues here, and a later turn from Claude Code shows up', async ({
  page,
  harness,
}) => {
  await sidebar(page).getByText('From Claude Code', { exact: true }).first().click();
  await expect(transcript(page).getByText('fake-claude: write the readme', { exact: true })).toBeVisible();
  await send(page, 'add a license');
  await expect(transcript(page).getByText('fake-claude: add a license', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);

  // Claude Code in a terminal runs a turn on the same session afterwards: it appends to the transcript
  const dir = path.join(harness.dir, 'home', '.claude', 'projects');
  const file = fs
    .readdirSync(dir)
    .map((d) => path.join(dir, d, `${CLAUDE_ID}.jsonl`))
    .find((f) => fs.existsSync(f))!;
  // MoPilot went on with the same session: its message is in that session's transcript
  expect(fs.readFileSync(file, 'utf8')).toContain('add a license');
  const last = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((l) => l.uuid)
    .at(-1);
  const at = Date.now();
  const line = (type: string, uuid: string, parentUuid: string, message: object, t: number) =>
    JSON.stringify({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: last.cwd,
      sessionId: CLAUDE_ID,
      version: '9.9.9',
      gitBranch: '',
      type,
      uuid,
      timestamp: new Date(t).toISOString(),
      message,
    });
  const u = randomUUID();
  const a = randomUUID();
  fs.appendFileSync(
    file,
    [
      line('user', u, last.uuid, { role: 'user', content: 'fix the lint' }, at),
      line(
        'assistant',
        a,
        u,
        {
          id: `msg_${a}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'other app: fix the lint' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        at + 1000,
      ),
    ].join('\n') + '\n',
  );
  await expect(transcript(page).getByText('other app: fix the lint', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(transcript(page).getByText('fake-claude: add a license', { exact: true })).toBeVisible();
  await expect(composer(page)).toBeEnabled();
});
