// External writes (WP5-19, A15): while another app runs a turn on an open chat (its rollout or jsonl
// is all Sage sees), the Composer is greyed out with "This chat is running in another app"; when the
// other app finishes, the chat catches up and can be written again.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const sidebar = (page: Page) => page.getByRole('complementary');
const transcript = (page: Page) => page.getByRole('main');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
// the editable composer keeps its accessible name and shows why it is locked as its placeholder
const locked = (page: Page) => composer(page).and(page.locator('[data-placeholder="This chat is running in another app"]'));

test.describe('Codex', () => {
  test.use({ seed: { codexThreads: [{ id: 'busy-thread', name: 'Busy elsewhere', turns: ['older', 'still going'], elsewhere: true }] } });

  test('external-writes: a Codex chat another client is running greys the Composer until it finishes', async ({ page, harness }) => {
    await sidebar(page).getByText('Busy elsewhere', { exact: true }).click();
    await expect(locked(page)).toBeVisible();
    await expect(locked(page)).toBeDisabled();
    // nothing to send while it is locked: Send, where the chat shows one in place of a voice conversation, is disabled
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();

    // the other client finishes and writes its rollout
    fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.finish-busy-thread'), '');
    const rollout = path.join(harness.dir, 'home', '.codex', 'sessions', 'rollout-busy-thread.jsonl');
    fs.appendFileSync(rollout, '{"done":true}\n');
    await expect(transcript(page).getByText('other app: still going', { exact: true })).toBeVisible();
    await expect(composer(page)).toBeEnabled();
    await expect(locked(page)).toHaveCount(0);
  });
});

test.describe('Claude', () => {
  test.use({
    harnesses: 'both',
    seed: {
      claudeSessions: [
        {
          id: 'aaaaaaaa-1111-4222-8333-444444444444',
          cwd: 'proj',
          title: 'Claude elsewhere',
          turns: ['hello', 'keep working'],
          running: true,
        },
      ],
    },
  });

  test('external-writes: a Claude chat whose transcript is mid-turn greys the Composer until the reply lands', async ({
    page,
    harness,
  }) => {
    // the chat is listed under its folder and again in Recents
    await sidebar(page).getByText('Claude elsewhere', { exact: true }).first().click();
    await expect(locked(page)).toBeVisible();

    // the other app writes its reply
    const dir = path.join(harness.dir, 'home', '.claude', 'projects');
    const file = fs
      .readdirSync(dir)
      .map((d) => path.join(dir, d, 'aaaaaaaa-1111-4222-8333-444444444444.jsonl'))
      .find((f) => fs.existsSync(f))!;
    const reply = {
      type: 'assistant',
      uuid: 'r1',
      sessionId: 'aaaaaaaa-1111-4222-8333-444444444444',
      timestamp: new Date().toISOString(),
      message: {
        id: 'msg_r1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'other app: done' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    };
    fs.appendFileSync(file, JSON.stringify(reply) + '\n');
    await expect(composer(page)).toBeEnabled();
    await expect(locked(page)).toHaveCount(0);
  });
});
