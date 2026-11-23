// A chat link in a message (src/components/markdown/ChatLink.tsx) shows a long title in full, wrapped, instead of cutting it at 280px.
import { test, expect } from './fixtures/app';

const TITLE = 'Host 2.1 standalone Node Host process packaging with login, update and Linux sage-mcp support';

test('a chat pill in a reply wraps a long title and shows all of it', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`see [${TITLE}](mopilot:chat/ghost) now`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const pill = page.locator('.assistant-message button.md-chat-link');
  await expect(pill).toHaveText(TITLE);
  const m = await pill.evaluate((el) => {
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight);
    const box = el.getBoundingClientRect();
    return {
      width: box.width,
      lines: Math.round(box.height / line),
      clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1,
      ellipsis: cs.textOverflow === 'ellipsis',
      parentWidth: el.parentElement!.getBoundingClientRect().width,
    };
  });
  expect(m.clipped).toBe(false);
  expect(m.ellipsis).toBe(false);
  expect(m.width).toBeGreaterThan(280);
  expect(m.width).toBeLessThanOrEqual(m.parentWidth + 1);
});
