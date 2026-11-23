// A long chat scrolled to its top while the page is busy never shows a blank where history is: each turn the window has
// not rendered yet draws its prompt and the start of its reply.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const TURNS = 30;
const SESSION = '30303030-1111-4222-8333-444444444444';
const long = 'A reply that runs on for a good while, so each turn is taller than the screen. '.repeat(24);

test.use({
  harnesses: 'claude',
  seed: {
    files: ({ home, claudeHome }) => {
      const cwd = path.join(home, 'long-chat');
      const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(folder, { recursive: true });
      const at = new Date().toISOString();
      const base = { sessionId: SESSION, cwd, isSidechain: false, timestamp: at };
      const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const records: object[] = [{ type: 'custom-title', sessionId: SESSION, customTitle: 'Long chat' }];
      for (let i = 0; i < TURNS; i++) {
        records.push({
          ...base,
          type: 'user',
          uuid: id(2 * i + 1),
          parentUuid: i ? id(2 * i) : null,
          message: { role: 'user', content: `Question ${i}` },
        });
        records.push({
          ...base,
          type: 'assistant',
          uuid: id(2 * i + 2),
          parentUuid: id(2 * i + 1),
          message: {
            id: `msg-${i}`,
            role: 'assistant',
            content: [{ type: 'text', text: `Answer ${i}. ${long}` }],
            stop_reason: 'end_turn',
          },
        });
      }
      fs.writeFileSync(path.join(folder, `${SESSION}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    },
  },
});

test('scrolling a long chat to its top on a busy page shows words, never a blank, where turns are not rendered yet', async ({ page }) => {
  await page.getByRole('complementary').getByRole('button', { name: 'Long chat', exact: true }).first().click();
  const main = page.getByRole('main');
  await expect(main.locator('[data-turn-slot]')).toHaveCount(TURNS);
  await expect(main.getByText(`Answer ${TURNS - 1}.`).first()).toBeVisible();
  const scroll = main.locator('.thread-scroll');

  // a busy page: the window's own report waits behind other work while the view is already at the top
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
  try {
    const frames = await scroll.evaluate(async (el) => {
      const blank = new Set<string>();
      const shown = new Set<string>();
      const sample = () => {
        const view = el.getBoundingClientRect();
        for (const slot of Array.from(el.querySelectorAll<HTMLElement>('[data-turn-slot]'))) {
          const box = slot.getBoundingClientRect();
          if (box.bottom < view.top || box.top > view.bottom || slot.childElementCount) continue;
          const words = getComputedStyle(slot, '::before').content;
          (words === 'none' || words === 'normal' ? blank : shown).add(slot.dataset.turnSlot!);
        }
      };
      el.scrollTop = 0;
      // before any frame the window has not moved: the turns at the top are placeholders, whatever the page's speed
      sample();
      for (let frame = 0; frame < 40; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        sample();
      }
      return { blank: [...blank], shown: [...shown] };
    });
    // before the window catches up, the turns on screen were placeholders, and each one carried its prompt
    expect(frames.shown.length).toBeGreaterThan(0);
    expect(frames.blank).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('long-chat-top.png') });
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  // once it catches up, the top of the chat is rendered in full
  await expect(main.getByText('Question 0', { exact: true }).first()).toBeVisible();
});
