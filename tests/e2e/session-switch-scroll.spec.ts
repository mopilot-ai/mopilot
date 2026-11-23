// Session switches open at the newest content through cached and newly loaded history on every harness.
import { test, expect, type Harness } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

test.skip(process.platform !== 'darwin', 'the ACP admission probe needs sage-mcp on macOS');

const body = (label: string, lines: number) =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i}: a conversation with enough history to scroll.`).join('\n\n');
const CLAUDE = '40404040-1111-4222-8333-444444444444';

test.use({
  harnesses: 'both',
  acp: { kimi: { resume: true } },
  seed: {
    uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } },
    codexThreads: [{ id: 'scroll-codex', name: 'Scroll Codex', turns: Array.from({ length: 18 }, (_, i) => body(`Codex turn ${i}`, 10)) }],
    claudeSessions: [
      { id: CLAUDE, title: 'Scroll Claude', cwd: 'scroll-claude', turns: Array.from({ length: 6 }, (_, i) => body(`Claude turn ${i}`, 4)) },
    ],
  },
});

async function newAcpChat(page: Harness['page']) {
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  const prompt = body('ACP conversation', 24);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText(`fake-acp: ${prompt}`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  return (await page.locator('.thread-view').getAttribute('data-thread-id'))!;
}

test('switching between different-length conversations always opens their end, then lets the reader scroll up', async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 682 });
  const acp = await newAcpChat(page);
  const sidebar = page.getByRole('complementary');
  const codex = await sidebar.getByRole('button', { name: 'Scroll Codex', exact: true }).first().getAttribute('data-sidebar-chat');
  const claude = await sidebar.getByRole('button', { name: 'Scroll Claude', exact: true }).first().getAttribute('data-sidebar-chat');
  expect(codex).toBeTruthy();
  expect(claude).toBeTruthy();

  // The first visits hydrate history; the rest reuse it, including a chat the reader left scrolled up.
  for (const id of [codex, claude, acp, codex, acp, claude, codex, claude]) {
    await sidebar
      .locator(`[data-sidebar-chat=${JSON.stringify(id)}]`)
      .first()
      .click();
    const chat = page.getByRole('main').locator('.thread-view');
    await expect(chat).toHaveAttribute('data-thread-id', id!);
    const scroll = chat.locator('.thread-scroll');
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(500);
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
    await expect(chat.locator('.scroll-bottom')).toHaveCount(0);
    await scroll.hover();
    await page.mouse.wheel(0, -600);
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeGreaterThan(100);
    await expect(chat.locator('.scroll-bottom')).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('session-switch-reader-position.png') });
});
