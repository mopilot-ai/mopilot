// Same-chat harness switching in the real app with fake Codex, Claude and two independent ACP agents.
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const selected = (page: Page) => page.locator('[data-sidebar-chat][aria-current="page"]');
const prompts = (h: Harness, id: string) =>
  h.acpLog(id).filter((l) => l.kind === 'in' && l.msg.method === 'session/prompt' && !JSON.stringify(l).includes('mopilot-acp-probe-'));

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

async function pick(page: Page, name: string) {
  await page.getByRole('button', { name: 'Select model' }).click();
  const nested = page.getByRole('button', { name: 'Select harness and model' });
  if (await nested.count()) await nested.click();
  await page.locator('.hp-harnesses .hp-row', { hasText: name }).click();
  // The first-tier picker chooses a model after the harness; the ACP picker chooses the harness default.
  const model = page.locator('.hp-models .menu-item').first();
  if (await model.count()) await model.click();
  // nothing in the chat is at risk: the switch goes ahead on the click, and the chip offers Options and Undo
  await expect(page.locator('.switch-chip')).toContainText(`continues on ${name}`);
}

async function idle(page: Page, chat: string, timeout = 10_000) {
  await expect.poll(() => page.evaluate((id) => window.native.session.snapshot(id), chat), { timeout }).toMatchObject({ turn: 'idle' });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}

test.use({ harnesses: 'both', acp: { opencode: { loadSession: true }, kimi: {} } });

test('Codex → OpenCode → Kimi → OpenCode → Claude → Codex keeps one chat and restores every segment after restart', async ({
  harness,
}, testInfo) => {
  test.setTimeout(120_000); // The fake Claude echo includes every nested handoff before restart verification.
  let page = harness.page;
  await send(page, 'original task');
  await expect(transcript(page).getByText('fake-codex: original task', { exact: true })).toBeVisible();
  const chat = (await selected(page).getAttribute('data-sidebar-chat'))!;
  await idle(page, chat);
  const rows = await page.locator('[data-sidebar-chat]').count();

  await pick(page, 'opencode');
  // Options shows the sheet again; closing it keeps the switch
  await page.locator('.switch-chip').getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.locator('.switch-sheet')).toContainText('stay in this chat');
  await expect(page.getByRole('button', { name: 'New chat with summary', exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('acp-switch-confirmation.png') });
  await page.locator('.switch-sheet').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.switch-chip')).toContainText('opencode');
  // Undo drops it
  await page.locator('.switch-chip').getByRole('button', { name: 'Cancel switch', exact: true }).click();
  await expect(page.locator('.switch-chip')).toHaveCount(0);
  await pick(page, 'opencode');
  await send(page, 'OpenCode first');
  await expect.poll(() => prompts(harness, 'opencode').length).toBe(1);
  await idle(page, chat);
  expect(JSON.stringify(prompts(harness, 'opencode')[0].msg.params.prompt)).toContain('original task');

  await pick(page, 'Kimi Code');
  await send(page, 'Kimi second');
  await expect.poll(() => prompts(harness, 'kimi').length).toBe(1);
  await idle(page, chat);
  await pick(page, 'opencode');
  await send(page, 'OpenCode back');
  await expect.poll(() => prompts(harness, 'opencode').length).toBe(2);
  await idle(page, chat);
  const back = prompts(harness, 'opencode')[1]
    .msg.params.prompt.map((block: { text?: string }) => block.text ?? '')
    .join('\n');
  expect(back).toContain('<sage-handoff from="Kimi Code" mode="delta">');
  expect(back).toContain('### Turn 3\nUser: Kimi second');
  // The fake echoes its input inside the assistant reply; only top-level user turns establish the delta boundary.
  expect(back.split('\nAssistant:')[0]).not.toContain('User: original task');

  await pick(page, 'Claude Code');
  await send(page, 'Claude third');
  await expect(transcript(page)).toContainText('fake-claude:');
  // The fake Claude CLI echoes the nested handoff at eight characters per 15ms, so this response exceeds ten seconds.
  await idle(page, chat, 60_000);
  await pick(page, 'Codex');
  await send(page, 'Codex fourth');
  // The fake Codex app-server streams the same nested echo at eight characters per 15ms.
  await idle(page, chat, 60_000);
  await expect(selected(page)).toHaveAttribute('data-sidebar-chat', chat);
  await expect(page.locator('[data-sidebar-chat]')).toHaveCount(rows);
  await page.getByRole('button', { name: 'Jump to message 1: original task', exact: true }).click();
  await expect(transcript(page).getByText('fake-codex: original task', { exact: true })).toBeVisible();

  await harness.relaunch();
  page = harness.page;
  await page.locator(`[data-sidebar-chat="${chat}"]`).click();
  // Long echoed handoffs virtualize offscreen turns. Read each segment through the user's message navigation.
  for (const [index, text] of [
    'original task',
    'OpenCode first',
    'Kimi second',
    'OpenCode back',
    'Claude third',
    'Codex fourth',
  ].entries()) {
    await page.getByRole('button', { name: `Jump to message ${index + 1}: ${text}`, exact: true }).click();
    await expect(transcript(page).getByText(text, { exact: true }).first()).toBeVisible();
    if (index === 0) await expect(transcript(page).getByText('fake-codex: original task', { exact: true })).toBeVisible();
  }
  await expect(page.locator('[data-sidebar-chat]')).toHaveCount(rows);
  await page.screenshot({ path: testInfo.outputPath('acp-switch-history.png') });
});
