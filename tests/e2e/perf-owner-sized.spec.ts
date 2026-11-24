// What an owner-sized profile costs the window (#5398): about 2,660 chats in 30 projects, a 1,400-session linked-session journal of about 2.8 MB and a 300-turn chat, on the fake harnesses. After a relaunch (a saved sidebar snapshot, as a long-time user starts) it measures keystroke-to-paint in the composer, chat switches, sidebar and transcript scrolling (frame intervals), and what one `orchestration:changed` broadcast costs the renderer (time to the next paint, long tasks and the components and rows it re-renders, read through React's DevTools hook), each with a CPU profile of its own. Fake data only; reports numbers, never content.
// e2e-runner: bench — launches the app twice on a large profile: it runs only when named (scripts/ci-cuj.mjs --spec)
import path from 'node:path';
import {
  PROJECTS,
  BROADCASTS,
  KEYS,
  BIG,
  claudeId,
  claudeSessions,
  codexThreads,
  journal,
  proj,
  stats,
  round,
  observe,
  now,
  jankBetween,
  profileTop,
  scrollerPoint,
  sceneCounts,
} from './fixtures/ownerProfile';
import { test, expect } from './fixtures/app';

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

test('owner-sized profile: composer, chat switch, scrolling and a state broadcast', async ({ harness }, testInfo) => {
  test.setTimeout(900_000);
  const settled = async () => {
    await expect
      .poll(
        () =>
          harness.page
            .evaluate(
              () =>
                document.querySelectorAll('[data-sidebar-chat]').length > 100 &&
                !!performance.getEntriesByName('mopilot:chats:claude').length &&
                !!performance.getEntriesByName('mopilot:chats:codex').length,
            )
            .catch(() => false),
        { timeout: 180_000, intervals: [500] },
      )
      .toBe(true);
  };
  await settled();
  // the sidebar's snapshot is saved a couple of seconds after the lists answer; a relaunch starts from it, as a long-time user does
  await harness.page.waitForTimeout(6000);
  await harness.relaunch();
  await settled();
  await harness.page.waitForTimeout(5000);
  const page = harness.page;
  await observe(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
  const profiled = async <T>(run: () => Promise<T>) => {
    await cdp.send('Profiler.start');
    const out = await run();
    const { profile } = (await cdp.send('Profiler.stop')) as any;
    return { out, top: profileTop(profile) };
  };
  const report: Record<string, unknown> = {};
  const step = async (name: string, run: () => Promise<unknown>) => {
    try {
      report[name] = await run();
    } catch (e) {
      report[name] = { error: String(e).slice(0, 400) };
    }
  };
  report.scene = await sceneCounts(page);

  // the journal the fixture wrote was read (the app moves an unreadable one aside)
  await step('journal', async () => {
    const view = await page.evaluate(() => (window as any).native.orchestration.snapshot());
    return {
      children: Object.keys(view?.children ?? {}).length,
      deliveries: Object.keys(view?.deliveries ?? {}).length,
      proposals: Object.keys(view?.proposals ?? {}).length,
    };
  });

  // a chat switch: the open-chat command to the column drawn, the composer usable and a paint after it
  const open = (id: string) =>
    harness.app.evaluate(
      ({ BrowserWindow }, chat) => BrowserWindow.getAllWindows()[0].webContents.send('app:command', 'open-chat', chat),
      id,
    );
  const switchTo = async (id: string) => {
    await page.evaluate((chat) => {
      const t0 = performance.now();
      (window as any).__switch = new Promise<number>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 60_000);
        const done = () => {
          const col = document.querySelector(`.thread-column[data-selection-source="thread-${chat}"]`);
          const input = document.querySelector('[role="textbox"][aria-label="Message"]') as HTMLElement | null;
          if (!col?.textContent || !input || input.offsetParent === null) return false;
          clearTimeout(timer);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - t0)));
          return true;
        };
        if (!done()) {
          const observer = new MutationObserver(() => done() && observer.disconnect());
          observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        }
      });
    }, id);
    await open(id);
    const ms = await page.evaluate(() => (window as any).__switch as Promise<number>);
    // what the window shows when the chat never did: the column it has (an id, no content) and whether it is loading
    if (ms < 0)
      report[`switchFailed:${id.slice(-12)}`] = await page.evaluate(() => ({
        column: document.querySelector('.thread-column')?.getAttribute('data-selection-source') ?? null,
        columnTextLength: document.querySelector('.thread-column')?.textContent?.length ?? 0,
        composer: !!document.querySelector('[role="textbox"][aria-label="Message"]'),
        title: document.title.slice(0, 60),
      }));
    return ms;
  };
  await step('chatSwitch', async () => {
    const ids = [BIG, claudeId(1), claudeId(2), BIG, claudeId(5), claudeId(6), BIG];
    const first = await switchTo(ids[0]);
    const ms: number[] = [];
    const from = await now(page);
    for (const id of ids.slice(1)) {
      ms.push(await switchTo(id));
      await page.waitForTimeout(500);
    }
    return {
      firstOpenMs: round(first),
      repeats: stats(ms.filter((x) => x >= 0).map(round)),
      failed: ms.filter((x) => x < 0).length,
      jank: await jankBetween(page, from, await now(page)),
      scene: await sceneCounts(page),
    };
  });
  await switchTo(BIG);
  await page.waitForTimeout(1500);

  await step('composerTyping', async () => {
    await page.locator('[role="textbox"][aria-label="Message"]').click();
    const { out, top } = await profiled(async () => {
      const from = await now(page);
      await page.evaluate(() => ((window as any).__jank.keys.length = 0));
      await page.keyboard.type(KEYS, { delay: 45 });
      await page.waitForTimeout(300);
      const keys: number[] = await page.evaluate(() => (window as any).__jank.keys.slice());
      return { keys, jank: await jankBetween(page, from, await now(page)) };
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    return { keydownToPaintMs: stats(out.keys.map(round)), jank: out.jank, cpuTop: top };
  });

  const scrollOf = (name: string, selector: string, wheelY: number, moves: number) =>
    step(name, async () => {
      const point = await scrollerPoint(page, selector);
      if (!point) return { error: `no scroller for ${selector}` };
      await page.mouse.move(point.x, point.y);
      const { out, top } = await profiled(async () => {
        const from = await now(page);
        await page.evaluate(() => (window as any).__frames.start());
        for (let i = 0; i < moves; i++) {
          await page.mouse.wheel(0, wheelY);
          await page.waitForTimeout(12);
        }
        await page.waitForTimeout(400);
        const frames: number[] = await page.evaluate(() => (window as any).__frames.stop());
        return { frames, jank: await jankBetween(page, from, await now(page)) };
      });
      const f = out.frames;
      return {
        scroller: { scrollHeight: point.scrollHeight, clientHeight: point.clientHeight },
        frameMs: stats(f.map(round)),
        framesOver33: f.filter((x) => x > 33).length,
        framesOver100: f.filter((x) => x > 100).length,
        jank: out.jank,
        scene: await sceneCounts(page),
        cpuTop: top,
      };
    });
  await scrollOf('transcriptScroll', '.thread-column', -240, 90);
  await scrollOf('sidebarScroll', '[data-sidebar-chat]', 240, 90);

  // one orchestration:changed broadcast as main sends it (the whole view again): with nothing in it a row shows changed,
  // and with one running session's clock moved (what the journal sends about every 20 s while a session works)
  const broadcastStep = (name: string, change: (view: any, n: number) => any) =>
    step(name, async () => {
      const view = await page.evaluate(() => (window as any).native.orchestration.snapshot());
      await page.evaluate(() => {
        const w = window as any;
        w.__bc = [];
        w.native.orchestration.onChanged(() => {
          const recv = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => w.__bc.push(performance.now() - recv)));
        });
      });
      const send = (v: unknown) =>
        harness.app.evaluate(
          ({ BrowserWindow }, next) => BrowserWindow.getAllWindows()[0].webContents.send('orchestration:changed', next),
          v,
        );
      const renders: any[] = [];
      const { top } = await profiled(async () => {
        const from = await now(page);
        for (let i = 0; i < BROADCASTS; i++) {
          await page.evaluate(() => (window as any).__renders?.start());
          await send(change(view, i));
          await page.waitForTimeout(700);
          renders.push(await page.evaluate(() => (window as any).__renders?.stop() ?? null));
        }
        report[`${name}Jank`] = await jankBetween(page, from, await now(page));
      });
      const paints: number[] = await page.evaluate(() => (window as any).__bc);
      const sum = (k: 'commits' | 'components' | 'hosts') => renders.map((r) => r?.[k] ?? 0);
      return {
        viewChildren: Object.keys(view?.children ?? {}).length,
        viewBytes: JSON.stringify(view).length,
        receiveToPaintMs: stats(paints.map(round)),
        commitsPerBroadcast: stats(sum('commits')),
        componentsRenderedPerBroadcast: stats(sum('components')),
        hostElementsRenderedPerBroadcast: stats(sum('hosts')),
        topRenderedClasses: renders[renders.length - 1]?.byClass ?? null,
        hookInstalled: renders.every((r) => r !== null),
        cpuTop: top,
      };
    });
  await broadcastStep('orchestrationBroadcast', (view) => view);
  // the first session that is linked and listed: its worked time moves by a second each broadcast, as a running session's does
  await broadcastStep('orchestrationClockChange', (view, n) => {
    const id = Object.keys(view.children)[0];
    const entry = view.children[id];
    return {
      ...view,
      children: { ...view.children, [id]: { ...entry, worked: { ...(entry.worked ?? {}), ms: (entry.worked?.ms ?? 0) + 1000 * (n + 1) } } },
    };
  });

  await testInfo.attach('owner-sized-baseline.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  console.log(`OWNER_SIZED_BASELINE ${JSON.stringify(report)}`);
});
