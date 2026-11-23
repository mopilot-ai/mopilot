// Two coding chats in one folder on a harness that shares MCP servers per folder (the fake agent installed as opencode,
// #2311, #2302): each chat holds a process of its own, and the second chat's model asking for the first chat's
// MoPilot tool server is refused by the app with no approval card.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function newOpencodeChat(page: Page) {
  await page.getByRole('button', { name: 'New chat' }).first().click();
  const picker = page.getByRole('button', { name: 'Select model' });
  await expect(picker).toBeVisible();
  // a new chat starts on the harness the last one used
  if (!/opencode/i.test((await picker.textContent()) ?? '')) {
    await picker.click();
    await page.getByRole('button', { name: 'Select harness and model' }).click();
    await page.locator('.hp-harnesses .hp-row', { hasText: 'opencode' }).click();
  }
}

test.describe('ACP tool servers are per chat', () => {
  test.use({ harnesses: 'codex', acp: { opencode: {} } });

  test('a second chat on the same harness gets its own process and cannot call the first chat’s tool server', async ({ harness }) => {
    const page = harness.page;
    const log = () => harness.acpLog('opencode').filter((l) => !JSON.stringify(l).includes('mopilot-acp-probe-'));
    const sessions = () => log().filter((l) => l.kind === 'in' && l.msg.method === 'session/new');
    const starts = () => log().filter((l) => l.kind === 'argv').length;

    await newOpencodeChat(page);
    await send(page, 'hello one');
    await expect(page.getByRole('main').getByText('fake-acp: hello one', { exact: true })).toBeVisible({ timeout: 30_000 });
    const first = sessions()[0].msg.params.mcpServers[0].name;
    expect(first).toMatch(/^sage_[0-9a-f]{12}$/);
    const before = starts();

    await newOpencodeChat(page);
    await send(page, 'hello two');
    await expect(page.getByRole('main').getByText('fake-acp: hello two', { exact: true })).toBeVisible({ timeout: 30_000 });
    expect(starts()).toBeGreaterThan(before); // its own process, not the first chat's
    // each chat's session/new carried only a MoPilot server of its own
    const named = sessions()
      .map((l) => (l.msg.params.mcpServers as { name: string }[]).map((m) => m.name))
      .filter((n) => n.length > 0); // the title helper's sessions carry none
    expect(named.length).toBe(2);
    expect(named[1].filter((n) => n === first)).toEqual([]);

    // the second chat reaches for the first chat's server: refused, no card
    await send(page, `FOREIGNPERMIT ${first}`);
    await expect(page.getByRole('main').getByText(/\[foreign-permit: reject\]/)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.approval-card')).toHaveCount(0);
  });
});
