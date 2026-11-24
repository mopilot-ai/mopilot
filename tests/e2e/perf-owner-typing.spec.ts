// Typing in an owner-sized profile (#5398), under the conditions the owner types in: idle, while linked-session broadcasts land at his rate and at a busy one, while turns stream in the open chat and in other chats, with an IME composing Chinese, a long multi-line draft and the slash and @ pickers. Reports each key's keydown-to-paint time (p50, p95, max, keys over 32 and 100 ms), long tasks and what one keypress re-renders. Fake data only; counts and times, never content.
// e2e-runner: bench — launches the app twice on a large profile: it runs only when named (scripts/ci-cuj.mjs --spec)
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  PROJECTS,
  BIG,
  claudeId,
  claudeSessions,
  codexThreads,
  journal,
  proj,
  observe,
  now,
  jankBetween,
  profileTop,
  profileTotals,
  settled,
  switchTo,
  keySummary,
  sceneCounts,
} from './fixtures/ownerProfile';
import { test } from './fixtures/app';

test.beforeEach(() => {
  test.skip(test.info().config.shard !== null, 'a bench: run it alone through ci-cuj');
});

test.use({
  harnesses: 'both',
  env: { FAKE_CLAUDE_STATUS_MS: '1500', FAKE_CODEX_START_MS: '1500' },
  codexProjects: Array.from({ length: PROJECTS }, (_, n) => proj(n)),
  mainRequire: [path.join(__dirname, 'fixtures', 'react-commits-hook.cjs')],
  seed: { claudeSessions, codexThreads, userData: { 'orchestration.json': journal() } },
});

/** Typing seconds per condition, and the pause between keys. */
const KEYS_PER_CONDITION = 360;
const KEY_DELAY_MS = 70;
const PHRASE = 'the quick brown fox jumps over the lazy dog and keeps typing for a while ';
const filler = (n: number) => 'lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(Math.ceil(n / 57)).slice(0, n);
const COMPOSER = '[role="textbox"][aria-label="Message"]';
/** Pinyin and the characters it commits to, as an IME shows them: the composition text grows, then the choice replaces it. */
const SYLLABLES = [
  ['n', 'ni', '你'],
  ['h', 'hao', '好'],
  ['sh', 'shi', '世'],
  ['j', 'jie', '界'],
  ['w', 'wo', '我'],
  ['x', 'xiang', '想'],
] as const;

test('typing under the owner’s conditions: broadcasts, streaming turns, IME, long drafts and pickers', async ({ harness }, testInfo) => {
  test.setTimeout(2_400_000);
  await settled(harness.page);
  await harness.page.waitForTimeout(6000);
  await harness.relaunch();
  await settled(harness.page);
  await harness.page.waitForTimeout(5000);
  const page: Page = harness.page;
  await observe(page);
  const cdp = await page.context().newCDPSession(page);
  const report: Record<string, unknown> = { scene: await sceneCounts(page) };
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      report[name] = await run();
    } catch (e) {
      report[name] = { error: String(e).slice(0, 400) };
    }
  };
  await switchTo(harness, BIG);
  await page.waitForTimeout(1500);
  const composer = page.locator(COMPOSER);

  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  /** `run`'s result with a CPU profile of it by self time, and the longest frames' scripts (what the long tasks ran). */
  const profiled = async <T extends Record<string, unknown>>(run: () => Promise<T>) => {
    await cdp.send('Profiler.start');
    const out = await run();
    const { profile } = (await cdp.send('Profiler.stop')) as any;
    const { self, total } = profileTotals(profile);
    return { ...out, cpuTop: self.slice(0, 12), cpuTotal: total };
  };

  const clear = async () => {
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
  };
  /** Types `count` Latin keys; the per-key results and the long tasks around them. */
  const typeLatin = async (count = KEYS_PER_CONDITION) => {
    await composer.click();
    const from = await now(page);
    await page.evaluate(() => ((window as any).__jank.keys.length = 0));
    let typed = 0;
    while (typed < count) {
      const chunk = PHRASE.slice(0, Math.min(PHRASE.length, count - typed));
      await page.keyboard.type(chunk, { delay: KEY_DELAY_MS });
      typed += chunk.length;
    }
    await page.waitForTimeout(400);
    const keys: number[] = await page.evaluate(() => (window as any).__jank.keys.slice());
    return { keys: keySummary(keys), jank: await jankBetween(page, from, await now(page)) };
  };
  /** Composes Chinese through the IME protocol (CDP Input.imeSetComposition / insertText), `rounds` syllables. */
  const typeChinese = async (rounds = 60) => {
    await composer.click();
    const from = await now(page);
    await page.evaluate(() => ((window as any).__jank.ime.length = 0));
    for (let i = 0; i < rounds; i++) {
      const [a, b, hanzi] = SYLLABLES[i % SYLLABLES.length];
      for (const text of [a, b]) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await page.waitForTimeout(45);
      }
      await cdp.send('Input.insertText', { text: hanzi });
      await page.waitForTimeout(KEY_DELAY_MS);
    }
    await page.waitForTimeout(400);
    const ime: number[] = await page.evaluate(() => (window as any).__jank.ime.slice());
    return { compositionEventsToPaint: keySummary(ime), jank: await jankBetween(page, from, await now(page)) };
  };

  // what one keypress re-renders (React's commit hook counts the components and elements that rendered)
  await step('onePress', async () => {
    await clear();
    await composer.click();
    const out: Record<string, unknown> = {};
    for (const name of ['first', 'second', 'third']) {
      await page.evaluate(() => (window as any).__renders?.start());
      await page.keyboard.press('x');
      await page.waitForTimeout(150);
      out[name] = await page.evaluate(() => (window as any).__renders?.stop() ?? null);
    }
    return out;
  });

  await step('idle', async () => (await clear(), typeLatin()));

  await step('imeIdle', async () => (await clear(), typeChinese()));

  await step('longDraft', async () => {
    await clear();
    // 40 lines of 80 characters, then the keys that follow them
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}: ${filler(70)}`).join('\n');
    await page.keyboard.insertText(lines);
    const tail = await typeLatin(200);
    return { draftLines: 40, ...tail };
  });

  await step('pickers', async () => {
    await clear();
    await composer.click();
    const out: Record<string, unknown> = {};
    for (const [name, trigger] of [
      ['slash', '/'],
      ['mention', '@'],
    ] as const) {
      await page.evaluate(() => ((window as any).__jank.keys.length = 0));
      await page.keyboard.type(`${trigger}a`, { delay: 120 });
      await page.waitForTimeout(600);
      for (let i = 0; i < 4; i++) {
        await page.keyboard.type('b', { delay: 120 });
        await page.waitForTimeout(150);
      }
      const keys: number[] = await page.evaluate(() => (window as any).__jank.keys.slice());
      out[name] = keySummary(keys);
      await page.keyboard.press('Escape');
      await clear();
    }
    return out;
  });

  /** Orchestration broadcasts, each moving one session's clock, every `everyMs` until the returned stop. */
  const view = await page.evaluate(() => (window as any).native.orchestration.snapshot());
  const startBroadcasts = (everyMs: number) => {
    let n = 0;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      const moved = JSON.parse(JSON.stringify(view));
      const kid = moved.children[claudeId(0)];
      if (kid?.worked) kid.worked.ms += ++n;
      else moved.children[`tick-${n++}`] = { ...Object.values<any>(moved.children)[0], name: `tick ${n}` };
      await harness.app
        .evaluate(
          ({ BrowserWindow }: any, v: unknown) => BrowserWindow.getAllWindows()[0].webContents.send('orchestration:changed', v),
          moved,
        )
        .catch(() => {});
      busy = false;
    }, everyMs);
    return () => clearInterval(timer);
  };
  await step('broadcastsHisRate', async () => {
    await clear();
    // one every 20 s: over 360 keys (25 s of typing) one or two land
    const stop = startBroadcasts(8000);
    try {
      return { everyMs: 8000, ...(await typeLatin()) };
    } finally {
      stop();
    }
  });
  await step('broadcastsBusy', async () => {
    await clear();
    // several sessions working: a journal write every 1.5 s
    const stop = startBroadcasts(1500);
    try {
      return { everyMs: 1500, ...(await typeLatin()) };
    } finally {
      stop();
    }
  });

  /** Sends a long prompt in a chat, which the fake streams for tens of seconds (8 characters every 15 ms). */
  const startTurn = async (chatId: string, chars: number) => {
    await switchTo(harness, chatId);
    await composer.click();
    await page.keyboard.insertText(`stream ${filler(chars)}`);
    await page.keyboard.press('Enter');
  };
  await step('streamingOpenChat', async () => {
    await clear();
    await startTurn(BIG, 24000);
    await page.waitForTimeout(1500);
    return { streamChars: 24000, ...(await profiled(() => typeLatin())) };
  });

  await step('streamingOtherChats', async () => {
    const others = [1, 2, 5, 6, 7, 8].map(claudeId);
    for (const id of others) await startTurn(id, 24000);
    await switchTo(harness, BIG);
    await page.waitForTimeout(1500);
    await clear();
    return { otherChatsStreaming: others.length, ...(await profiled(() => typeLatin())) };
  });

  await step('combined', async () => {
    await clear();
    const stop = startBroadcasts(1500);
    try {
      // streaming turns are still running in other chats; the IME and Latin keys both go through the open chat's composer
      const chinese = await profiled(() => typeChinese(60));
      const latin = await typeLatin();
      return { everyMs: 1500, chinese, latin };
    } finally {
      stop();
    }
  });

  // one CPU profile of typing in the busiest condition, by self time
  await step('cpuTopWhileTyping', async () => {
    await clear();
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    const stop = startBroadcasts(1500);
    await typeLatin(160);
    stop();
    const { profile } = (await cdp.send('Profiler.stop')) as any;
    return profileTop(profile);
  });

  // what the app itself recorded of this run in userData/perf/renderer.jsonl (content-free lines: long tasks, slow input, what the composer refused)
  const recorded = path.join(harness.env.MOPILOT_USER_DATA, 'perf', 'renderer.jsonl');
  report.rendererRecord = fs.existsSync(recorded) ? fs.readFileSync(recorded, 'utf8').split('\n').filter(Boolean).slice(-200) : null;
  await testInfo.attach('owner-typing.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(`OWNER_TYPING ${JSON.stringify(report)}`);
});
