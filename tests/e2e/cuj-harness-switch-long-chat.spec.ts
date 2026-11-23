// #4236: switching harness on a long chat froze the window and then, as the message went out, the whole app. A long Codex
// chat goes to Claude Code with its conversation handed over, while the window's and main's stalls are measured, and its
// older pages can still be read afterwards (#4252).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const TURNS = 800;
/** A stall this long is a freeze a person sees, and is far above what a busy runner adds: it took seconds before the fix. */
const MAX_STALL_MS = 1500;
const CHAT = 'long chat to switch';
const OUTPUT = Array.from({ length: 40 }, (_, i) => `line ${i} of the command's output`).join('\n');

const seeded = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-long-chat-'));
const threads = path.join(seeded, 'threads.json');
fs.writeFileSync(
  threads,
  JSON.stringify([
    {
      id: '019c0000-0000-7000-8000-0000000000e1',
      name: CHAT,
      turns: Array.from({ length: TURNS }, (_, n) => ({
        text: `request ${n}`,
        items: [
          {
            type: 'userMessage',
            id: `u${n}`,
            content: [{ type: 'text', text: `request ${n}: look at \`src/a${n}.ts\` ${'and more '.repeat(30)}` }],
          },
          ...Array.from({ length: 6 }, (_, c) => ({
            type: 'commandExecution',
            id: `c${n}-${c}`,
            command: `ls src/part-${c}`,
            cwd: '/',
            processId: null,
            source: 'agent',
            status: 'completed',
            commandActions: [],
            aggregatedOutput: OUTPUT,
            exitCode: 0,
            durationMs: 5,
          })),
          { type: 'agentMessage', id: `a${n}`, text: `reply ${n} ${'with some words '.repeat(40)}`, phase: null },
        ],
      })),
    },
  ]),
);
test.afterAll(() => fs.rmSync(seeded, { recursive: true, force: true }));

test.use({ harnesses: 'both', env: { FAKE_CODEX_THREADS: `@${threads}` } });

test('a long chat switches harness without freezing the window or main, and hands its conversation over', async ({ page, harness }) => {
  test.setTimeout(240_000);
  await page.getByRole('complementary').getByText(CHAT, { exact: true }).click();
  await expect(page.getByRole('main').getByText(`reply ${TURNS - 1} `, { exact: false })).toBeVisible({ timeout: 60_000 });

  // from here on: the window's longest gap between two tasks and main's between ticks of a 20 ms timer. A message loop, as
  // this window's timers and long-task reports don't run behind other windows.
  await page.evaluate(() => {
    const w = window as any;
    w.__longest = 0;
    const { port1, port2 } = new MessageChannel();
    let last = performance.now();
    port1.onmessage = () => {
      const now = performance.now();
      w.__longest = Math.max(w.__longest, now - last);
      last = now;
      if (!w.__stopLoop) port2.postMessage(0);
    };
    port2.postMessage(0);
  });
  // the loop sees a task that holds the window, so a low reading below means the window was free
  await page.evaluate(() => {
    const until = performance.now() + 150;
    while (performance.now() < until);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__longest)).toBeGreaterThanOrEqual(100);
  await page.evaluate(() => {
    (window as any).__longest = 0;
  });
  await harness.app.evaluate(() => {
    const g = globalThis as any;
    g.__stall = 0;
    let last = Date.now();
    g.__stallTimer = setInterval(() => {
      const now = Date.now();
      g.__stall = Math.max(g.__stall, now - last - 20);
      last = now;
    }, 20);
  });

  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await expect(page.locator('.switch-chip')).toBeVisible();
  const picking = await page.evaluate(() => (window as any).__longest);

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('carry on');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // the fake echoes its whole input, handoff first, at a few characters a tick: the switch is over once the reply starts
  await expect(page.getByRole('main').getByText('fake-claude: <sage-handoff', { exact: false })).toBeVisible({ timeout: 90_000 });

  const windowTask = await page.evaluate(() => {
    const w = window as any;
    w.__stopLoop = true;
    return w.__longest;
  });
  const mainStall = await harness.app.evaluate(() => {
    const g = globalThis as any;
    clearInterval(g.__stallTimer);
    return g.__stall;
  });
  console.log(
    `switch of a ${TURNS}-turn chat: longest window task ${picking} ms picking, ${windowTask} ms overall; main stall ${mainStall} ms`,
  );

  // the switch really handed the conversation over: the oldest turns condensed, the newest verbatim
  const sent = harness
    .claudeLog()
    .map((l) => JSON.stringify(l))
    .find((l) => l.includes('sage-handoff'));
  expect(sent).toContain('sage-handoff');
  expect(sent).toContain('Earlier turns (condensed):');
  expect(sent).toContain('- Turn 1: user asked');
  expect(sent).toContain(`### Turn ${TURNS}`);

  expect(windowTask).toBeLessThan(MAX_STALL_MS);
  expect(mainStall).toBeLessThan(MAX_STALL_MS);

  // #4252: the window holds one page of the chat, and the switch must not strand the rest above it
  const chat = page.getByRole('main').locator('.thread-view');
  const before = await chat.locator('[data-turn-slot]').count();
  expect(before).toBeLessThan(TURNS);
  // the turn still streams, and a scroll made here would be followed back down: the button stops following first, as a wheel does
  await chat.locator('.turn-navigation-older').dispatchEvent('click');
  await expect.poll(() => chat.locator('[data-turn-slot]').count(), { timeout: 30_000 }).toBeGreaterThan(before);
});
