// MoMo on an ACP brain is confined by MoPilot itself (#2278, #2302), on fake harnesses only: the fake ACP agent,
// installed as opencode, is MoMo's brain. In MoMo's chat it asks the client to read a file (fs/read_text_file), to run a
// command (terminal/create) and for a native permission: MoMo refuses each, with no approval card, and its process was
// told the client has no files or terminal. A coding chat on the same fake agent still gets all three. (opencode's own
// in-process tools are off by its isolation config, checked in UT and against the real CLI, not here.)
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoChat, openMomo } from './fixtures/momo';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const MODE = {
  id: 'mode',
  name: 'Mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'Build' },
    { value: 'momo', name: 'MoMo' },
  ],
};
const SECRET = 'papaya-secret';
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.describe('MoMo on an ACP brain', () => {
  test.use({
    harnesses: 'codex',
    env: { MOPILOT_MOMO_DEV: '1' },
    acp: { opencode: { configOptions: [MODE] } },
    seed: {
      uiState: { prefs: { momo: { brain: { main: { harness: 'acp:opencode' } } } } },
      files: ({ home }) => {
        fs.writeFileSync(path.join(home, 'secret.txt'), SECRET);
        // a provider of its own (free models alone can't run MoMo, #2357)
        fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
        fs.writeFileSync(
          path.join(home, '.local', 'share', 'opencode', 'auth.json'),
          JSON.stringify({ anthropic: { type: 'api', key: 'test' } }),
        );
      },
    },
  });

  test('MoMo refuses the agent’s file read, command and native permission; a coding chat on it gets them', async ({ page, harness }) => {
    const secret = path.join(harness.dir, 'home', 'secret.txt');
    const ask = `FSREAD ${secret} TERM hello PERMIT this`;
    const log = () => harness.acpLog('opencode').filter((l) => !JSON.stringify(l).includes('mopilot-acp-probe-'));

    // MoMo's main chat, on the fake opencode
    await expect(composer(page)).toBeVisible();
    await openMomo(page);
    const chat = momoChat(page);
    await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(ask);
    await chat.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(chat.getByText(/\[read: error MoMo's chats don't read or write files or run commands here\]/)).toBeVisible({
      timeout: 30_000,
    });
    await expect(chat.getByText(/\[term error: MoMo's chats don't read or write files or run commands here\]/)).toBeVisible();
    await expect(chat.getByText(SECRET)).toHaveCount(0);
    await expect(page.locator('.approval-card')).toHaveCount(0);
    // the permission was refused by the app (reject), and the process was told there are no files or terminal
    const refused = log().find((l) => l.kind === 'in' && !l.msg.method && l.msg.result?.outcome);
    expect(refused.msg.result.outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
    const inits = log().filter((l) => l.kind === 'in' && l.msg.method === 'initialize');
    const caps = inits.map((l) => l.msg.params.clientCapabilities);
    expect(caps).toContainEqual(expect.objectContaining({ fs: { readTextFile: false, writeTextFile: false }, terminal: false }));
    // MoMo's session is on MoMo's mode
    expect(log().some((l) => l.kind === 'in' && l.msg.method === 'session/set_config_option' && l.msg.params.value === 'momo')).toBe(true);

    // a coding chat on the same fake agent: the read, the command and an approval card
    await page.getByRole('button', { name: 'Back to chats' }).click();
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(composer(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'opencode' }).click();
    await composer(page).fill(ask);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('.approval-card');
    await expect(card).toContainText('opencode wants to: Fake action', { timeout: 30_000 });
    await page.keyboard.press('1');
    const main = page.getByRole('main');
    await expect(main.getByText(new RegExp(`\\[read: ${SECRET}\\]`))).toBeVisible();
    await expect(main.getByText(/\[term: hello exit 0\]/)).toBeVisible();
    const later = log()
      .filter((l) => l.kind === 'in' && l.msg.method === 'initialize')
      .map((l) => l.msg.params.clientCapabilities);
    expect(later).toContainEqual(expect.objectContaining({ fs: { readTextFile: true, writeTextFile: true }, terminal: true }));
  });
});
