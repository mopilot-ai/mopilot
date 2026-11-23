// VM-only interaction measurements on the streaming benchmark's isolated profiles and synthetic harnesses.
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createDriver, warmSettings, writeSettings } from '../../scripts/perf-bench/driver.mjs';
import { plans } from '../../scripts/perf-bench/scenarios.mjs';
import { metrics, percentile, readSamples } from '../../scripts/perf-bench/aggregate.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const APP = path.resolve(process.env.MOPILOT_PERF_APP || ROOT);
const OUT = path.resolve(process.env.MOPILOT_PERF_OUT || '/tmp/mopilot-input-perf');
const BASELINE = process.env.MOPILOT_PERF_BASELINE === '1';
const SCENARIOS = (process.env.MOPILOT_PERF_SCENARIOS || 'S1,S3,S5,S7').split(',');
const driver = createDriver({ electron: _electron, root: APP, log: console.log });
const paint = (page: any) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

async function show(s: any, id: string) {
  await driver.openChat(s, id);
  await s.page.locator(`.thread-column[data-selection-source="thread-${id}"]`).waitFor();
  await paint(s.page);
}

async function timedSwitch(s: any, win: any, id: string) {
  await s.page.evaluate((chatId: string) => {
    const started = performance.now();
    (window as any).__switchPerf = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('cached conversation did not become interactive'));
      }, 10_000);
      let painting = false;
      const check = () => {
        const column = document.querySelector(`.thread-column[data-selection-source="thread-${chatId}"]`);
        const composer = document.querySelector('[role="textbox"][aria-label="Message"]') as HTMLElement | null;
        if (
          painting ||
          !column?.textContent ||
          !composer ||
          composer.offsetParent === null ||
          composer.getAttribute('aria-disabled') === 'true'
        )
          return;
        painting = true;
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timer);
            resolve(performance.now() - started);
          }),
        );
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      check();
    });
  }, id);
  await win.evaluate((w: any, chatId: string) => w.webContents.send('app:command', 'open-chat', chatId), id);
  return await s.page.evaluate(() => (window as any).__switchPerf as Promise<number>);
}

// Exercise the real AppServer reader in Electron main, with a synthetic readable that honors pause/resume.
// Setup and wire allocation precede the measurement window; only feeding, parsing and delivery are timed.
async function prepareInput(s: any) {
  return await s.app.evaluate(async ({ app }: any) => {
    const { createRequire } = process.getBuiltinModule('module');
    const require = createRequire(`${app.getAppPath()}/package.json`);
    const { AppServer } = require('./electron/harness/codexProcess.cjs');
    const { EventEmitter } = require('node:events');
    const stdout: any = new EventEmitter();
    stdout.paused = false;
    stdout.setEncoding = () => {
      stdout.strings = true;
    };
    stdout.pause = () => {
      stdout.paused = true;
    };
    stdout.resume = () => {
      stdout.paused = false;
    };
    const proc: any = new EventEmitter();
    proc.stdout = stdout;
    proc.stderr = new EventEmitter();
    proc.stderr.setEncoding = () => {};
    proc.stdin = new EventEmitter();
    proc.stdin.write = () => true;
    proc.kill = () => {};
    const server = new AppServer({ spawn: () => proc, findBin: () => 'synthetic-perf-input' });
    server.start();
    const wires = new Map<number, { raw: Buffer; text: string }>();
    for (const size of [0.01, 1, 4, 16, 32]) {
      const text = JSON.stringify({ text: 'x'.repeat(Math.floor(size * 1024 * 1024)), id: size }) + '\n';
      wires.set(size, { raw: Buffer.from(text), text });
    }
    async function run(size: number, paced = false) {
      const wire = wires.get(size)!;
      const input = stdout.strings ? wire.text : wire.raw;
      const started = performance.now();
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.listeners.delete(receive);
          reject(new Error('JSON input timed out'));
        }, 60_000);
        const receive = (event: any) => {
          if (event.kind === 'error') {
            clearTimeout(timer);
            server.listeners.delete(receive);
            reject(new Error(event.error));
          }
          if (event.kind !== 'message') return;
          clearTimeout(timer);
          server.listeners.delete(receive);
          if (event.msg.id !== size || event.msg.text !== wire.text.slice(9, 9 + Math.floor(size * 1024 * 1024))) {
            reject(new Error('JSON delivery changed content or ordering'));
          } else resolve(performance.now() - started);
        };
        server.listeners.add(receive);
        let at = 0;
        const feed = () => {
          if (stdout.paused) {
            setImmediate(feed);
            return;
          }
          if (at >= input.length) return;
          stdout.emit('data', input.slice(at, at + 32768));
          at += 32768;
          if (at < input.length) {
            if (paced) setTimeout(feed, 1);
            else setImmediate(feed);
          }
        };
        feed();
      });
    }
    let loading = false;
    let load: Promise<number[]> | null = null;
    (globalThis as any).__jsonPerf = {
      run,
      begin() {
        loading = true;
        load = (async () => {
          const times: number[] = [];
          while (loading) times.push(await run(32, true));
          return times;
        })();
      },
      async endLoad() {
        loading = false;
        return await load;
      },
      close: () => server.stop(),
    };
    return await run(0.01); // retain cold startup separately from warmed throughput samples
  });
}

async function typing(s: any) {
  const box = s.page.getByRole('textbox', { name: 'Message', exact: true });
  await box.fill('');
  await box.focus();
  await s.page.evaluate(() => {
    const input = document.activeElement as HTMLElement;
    const measured: number[] = [];
    (window as any).__typingPerf = measured;
    const key = (e: KeyboardEvent) => {
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey) return;
      const started = performance.now();
      const before = input.textContent;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (input.textContent !== before) measured.push(performance.now() - started);
        }),
      );
    };
    input.addEventListener('keydown', key);
    (window as any).__typingCleanup = () => input.removeEventListener('keydown', key);
  });
  const text = 'typing responsiveness under simultaneous JSON input '.repeat(2);
  const dispatched: number[] = [];
  for (const key of text) {
    const started = performance.now();
    await s.page.keyboard.press(key === ' ' ? 'Space' : key);
    await s.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    dispatched.push(performance.now() - started);
  }
  await paint(s.page);
  expect(await box.textContent()).toBe(text);
  const samples = await s.page.evaluate(() => {
    (window as any).__typingCleanup();
    return (window as any).__typingPerf as number[];
  });
  expect(samples).toHaveLength(text.length);
  await box.fill('');
  return { dispatched, renderer: samples };
}

async function scrolling(s: any) {
  return s.page.evaluate(async () => {
    const el = document.querySelector('.thread-scroll')!;
    const frames: number[] = [];
    let previous = performance.now();
    let moved = false;
    for (let i = 0; i < 120; i++) {
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const now = performance.now();
      if (i) frames.push(now - previous);
      previous = now;
      const before = el.scrollTop;
      el.scrollTop += i % 40 < 20 ? -120 : 120;
      moved ||= before !== el.scrollTop;
    }
    return { frames, moved };
  });
}

for (const plan of plans(SCENARIOS)) {
  test(`${plan.id}/${plan.variant}: three complete input and JSON measurements`, async ({}, info) => {
    test.setTimeout(1_800_000);
    const dir = path.join(OUT, `${plan.id}-${plan.variant}`);
    const s = await driver.start(dir, { foreground: true });
    const runs: any[] = [];
    let probe: string[] = [];
    try {
      writeSettings(s.ctl, warmSettings(plan.bytes));
      const ids: string[] = [];
      for (const chat of plan.chats) {
        const id = await driver.newChat(s, chat.family, '[bench] warm 1');
        for (let n = 2; n <= plan.turns; n++) {
          const since = Date.now();
          await driver.send(s, `[bench] warm ${n}`);
          await driver.waitTurns(s, 1, since, 120_000);
        }
        ids.push(id);
      }
      const active = ids.at(-1)!;
      const cached = ids.length > 1 ? ids[0] : await driver.newChat(s, plan.chats[0].family, '[bench] cached other chat');
      await show(s, active);
      await driver.focus(s);
      const win = await s.app.browserWindow(s.page);
      const coldInputMs = await prepareInput(s);
      // Let setup allocation/GC leave the probe's one-second loop bucket.
      await s.page.waitForTimeout(1500);
      for (let rep = 1; rep <= 3; rep++) {
        writeSettings(s.ctl, { mode: 'replay', bytes: plan.bytes, rate: 120, chunk: 4, toolEveryMs: plan.toolEveryMs, gate: true });
        fs.rmSync(path.join(s.ctl, 'go'), { force: true });
        for (const id of ids) {
          await show(s, id);
          await driver.send(s, `[bench] measured ${rep}`);
        }
        await show(s, active);
        const from = Date.now();
        fs.writeFileSync(path.join(s.ctl, 'go'), '');
        const framing = await s.app.evaluate(async () => {
          const result: Record<string, number> = {};
          for (const size of [1, 4, 16, 32]) result[size] = await (globalThis as any).__jsonPerf.run(size);
          return result;
        });
        // The same large fragmented-input workload remains active throughout typing, scrolling and switching.
        await s.app.evaluate(() => (globalThis as any).__jsonPerf.begin());
        const keys = await typing(s);
        const scroll = await scrolling(s);
        expect(scroll.moved).toBe(true);
        const switches: number[] = [];
        for (let n = 0; n < 20; n++) {
          switches.push(await timedSwitch(s, win, n % 2 ? active : cached));
        }
        const duringInput = await s.app.evaluate(() => (globalThis as any).__jsonPerf.endLoad());
        expect(duringInput.length).toBeGreaterThan(0);
        await driver.waitTurns(s, ids.length, from, 120_000);
        await s.page.waitForTimeout(1200);
        runs.push({
          rep,
          from,
          to: Date.now(),
          framing,
          coldInputMs,
          duringInput,
          typingP95: percentile(keys.dispatched, 95),
          rendererTypingP95: percentile(keys.renderer, 95),
          scrollP95: percentile(scroll.frames, 95),
          switchP95: percentile(switches, 95),
          counts: { keys: keys.dispatched.length, frames: scroll.frames.length, switches: switches.length },
        });
      }
      await s.app.evaluate(() => (globalThis as any).__jsonPerf.close());
    } finally {
      probe = await driver.stop(s, OUT);
    }
    expect(probe.length).toBeGreaterThan(0);
    const reads = probe.map((p) => readSamples(fs.readFileSync(path.join(OUT, p), 'utf8')));
    expect(reads.every((r) => r.skipped === 0)).toBe(true);
    const all = reads.flatMap((r) => r.samples);
    expect(all.some((v) => v.kind === 'dropped' && v.count > 0)).toBe(false);
    for (const run of runs) {
      run.stream = metrics(all, run);
      run.passed =
        run.typingP95 <= 50 && run.scrollP95 <= 33 && run.switchP95 <= 200 && run.stream.loopP95 !== null && run.stream.loopP95 <= 20;
      expect(run.stream.frameP95).not.toBeNull();
      expect(run.stream.firstToken).not.toBeNull();
    }
    const framing32Median = percentile(
      runs.map((r) => r.framing[32]),
      50,
    )!;
    const report = {
      revision: process.env.MOPILOT_PERF_REV,
      app: APP,
      baseline: BASELINE,
      scenario: plan.id,
      variant: plan.variant,
      historyTurns: plan.turns,
      chats: plan.chats,
      probe,
      runs,
      framing32Median,
      passed: runs.every((r) => r.passed) && framing32Median <= 100,
    };
    fs.writeFileSync(path.join(dir, 'interaction-results.json'), JSON.stringify(report, null, 2));
    await info.attach('interaction-results', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify(report));
    if (!BASELINE) expect(report.passed).toBe(true);
  });
}
