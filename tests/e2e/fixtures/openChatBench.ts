// The open-an-unloaded-chat benchmark (#2963), shared by perf-open-chat-idle.spec.ts and perf-open-chat-load.spec.ts: 30 chats of 50-300 turns (10 per harness) on the fake harnesses, a fresh instance so none is loaded,
// each shown with the window's open-chat command while a page-side timer waits for the chat's text. With load, 30 more chats stream in the background first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../../..');
const load = (file: string): Promise<any> =>
  new Function('u', 'return import(u)')(pathToFileURL(path.join(ROOT, 'scripts/perf-bench', file)).href);
const FAMILIES = ['claude', 'codex', 'acp'] as const;
type Family = (typeof FAMILIES)[number];
const SIZES = [50, 80, 120, 160, 200, 240, 280, 300, 100, 60];
const LOAD_CHATS = 30;
const GAP_MS = 1600;

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] : null;
};
const round = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

export function openChatBench(WITH_LOAD: boolean, REPEATS: number) {
  test.skip(
    process.platform !== 'darwin',
    'a basic harness is admitted only with sage-mcp, which builds only on macOS; the benchmark runs on macOS runners (ci-cuj)',
  );
  test(`open an unloaded chat, ${WITH_LOAD ? 'with 30 streaming chats' : 'idle'}: ${REPEATS} fresh instances`, async ({}, testInfo) => {
    test.setTimeout(REPEATS * (WITH_LOAD ? 1_500_000 : 600_000) + 600_000);
    const { createDriver, warmSettings, writeSettings } = await load('driver.mjs');
    const { MARK } = await load('replay.mjs');
    const { codexThreads, writeClaudeSession, acpRecords } = await load('history.mjs');
    const { randomUUID } = await import('node:crypto');
    const driver = createDriver({ electron: _electron, root: ROOT, log: (m: string) => console.log(m) });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'open-chat-'));
    const dir = path.join(work, 'profile');
    const tags = SIZES.map((_, i) => `${i}`);
    // history for Codex (the fake app-server's threads) and Claude Code (transcripts) is written before the first start
    const codex = codexThreads(
      tags.map((t) => `x${t}`),
      SIZES,
    );
    const claude = tags.map((t, i) => ({ id: randomUUID(), tag: `l${t}`, turns: SIZES[i] }));
    for (const c of claude) writeClaudeSession(path.join(dir, 'home', '.claude'), path.join(dir, 'home'), c);
    // the seeded turns are megabytes: past what an environment variable holds
    const seedFile = path.join(work, 'codex-threads.json');
    fs.writeFileSync(seedFile, JSON.stringify(codex.map((t: any) => ({ ...t, cwd: path.join(dir, 'home') }))));
    const env = { FAKE_CODEX_THREADS: `@${seedFile}` };
    // basic harness chats are made through the app, then their transcripts are extended while it is closed
    const setup = await driver.start(dir, { foreground: true, env });
    // the fakes log turn ends (what the driver waits for) only in replay mode
    writeSettings(setup.ctl, warmSettings(256));
    const acpIds: string[] = [];
    // the sidebar is still filling with the seeded chats: let it settle, and retry a harness list that re-renders under the click
    await setup.page.waitForTimeout(8000);
    for (let i = 0; i < tags.length; i++) {
      for (let attempt = 1; ; attempt++) {
        try {
          acpIds.push(await driver.newChat(setup, 'acp', `${MARK} seed ${i}`));
          break;
        } catch (e) {
          await testInfo.attach(`setup-failed-${i}-${attempt}.png`, { body: await setup.page.screenshot(), contentType: 'image/png' });
          await testInfo.attach(`setup-failed-${i}-${attempt}.txt`, {
            body: await setup.page.evaluate(() => document.body.innerText.slice(0, 3000)),
            contentType: 'text/plain',
          });
          if (attempt === 3) throw e;
          await setup.page.waitForTimeout(3000);
        }
      }
    }
    await driver.stop(setup, work);
    acpIds.forEach((id, i) => {
      const file = path.join(setup.userData, 'threads', `${encodeURIComponent(id)}.items.jsonl`);
      fs.appendFileSync(
        file,
        acpRecords(`a${i}`, SIZES[i])
          .map((r: any) => JSON.stringify(r))
          .join('\n') + '\n',
      );
    });
    const chats: { family: Family; id: string; tag: string; turns: number }[] = [];
    SIZES.forEach((n, i) => {
      chats.push({ family: 'claude', id: `claude:${claude[i].id}`, tag: claude[i].tag, turns: n });
      chats.push({ family: 'codex', id: codex[i].id, tag: `x${i}`, turns: n });
      chats.push({ family: 'acp', id: acpIds[i], tag: `a${i}`, turns: n });
    });

    const runs: any[] = [];
    for (let rep = 1; rep <= REPEATS; rep++) {
      const s = await driver.start(dir, { foreground: true, env });
      const page = s.page;
      if (WITH_LOAD) {
        writeSettings(s.ctl, warmSettings(256));
        const ids: string[] = [];
        for (let i = 0; i < LOAD_CHATS; i++) ids.push(await driver.newChat(s, FAMILIES[i % 3], `${MARK} warm ${i}`));
        writeSettings(s.ctl, { mode: 'replay', bytes: 32768, rate: 40, chunk: 4, toolEveryMs: 200, gate: true });
        fs.rmSync(path.join(s.ctl, 'go'), { force: true });
        for (const id of ids) {
          await driver.openChat(s, id);
          await page.locator('button.send-btn.stop').waitFor({ state: 'detached', timeout: 30_000 });
          await driver.send(s, `${MARK} load ${rep}`);
        }
        fs.writeFileSync(path.join(s.ctl, 'go'), '');
        await page.waitForTimeout(3000);
      } else await page.waitForTimeout(4000);
      await page.evaluate(() => {
        (window as any).__waitFor = (needles: string[], ms: number) =>
          new Promise((resolve) => {
            const t0 = performance.now();
            const hit: (number | null)[] = needles.map(() => null);
            const tick = () => {
              const text = document.body.textContent ?? '';
              needles.forEach((n, i) => {
                if (hit[i] === null && text.includes(n)) hit[i] = performance.now() - t0;
              });
              if (hit.every((h) => h !== null) || performance.now() - t0 > ms) return resolve(hit);
              setTimeout(tick, 20);
            };
            tick();
          });
      });
      const win = await s.app.browserWindow(page);
      const rows: any[] = [];
      // alternate harnesses so neighbouring opens do not share a warm path
      for (const c of chats) {
        const wait = page.evaluate(
          ([needles]) => (window as any).__waitFor(needles, 12000),
          [[`Q-${c.tag}-${c.turns - 1}`, `END-${c.tag}`, `Q-${c.tag}-${Math.max(0, c.turns - 30)}`]],
        );
        const t0 = Date.now();
        await win.evaluate((w: any, id: string) => w.webContents.send('app:command', 'open-chat', id), c.id);
        const [newest, end, firstPageOldest] = (await wait) as (number | null)[];
        rows.push({ ...c, t0, newest, end, firstPageOldest });
        await page.waitForTimeout(GAP_MS);
      }
      const probes = await driver.stop(s, work);
      const samples = probes.flatMap((f: string) =>
        fs
          .readFileSync(path.join(work, f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap((l) => {
            try {
              return [JSON.parse(l)];
            } catch {
              return [];
            }
          }),
      );
      // what main and the window did while each open waited, from the probe's one-second samples whose second ends inside the open's window
      for (const r of rows) {
        const to = r.t0 + (r.end ?? 12_000) + 1000;
        const inWindow = samples.filter((x) => x.t >= r.t0 && x.t <= to);
        const of = (kind: string) => inWindow.filter((x) => x.kind === kind);
        const invoke: Record<string, { n: number; ms: number; max: number }> = {};
        for (const x of of('invoke')) {
          const v = invoke[x.channel] ?? { n: 0, ms: 0, max: 0 };
          invoke[x.channel] = { n: v.n + x.count, ms: v.ms + x.ms, max: Math.max(v.max, x.max) };
        }
        r.main = {
          loopMaxMs: round(Math.max(0, ...of('loop').map((x) => x.max))),
          loopP99Ms: round(Math.max(0, ...of('loop').map((x) => x.p99))),
          invoke: Object.fromEntries(
            Object.entries(invoke)
              .filter(([, v]) => v.ms >= 5)
              .map(([k, v]) => [k, { n: v.n, ms: round(v.ms), max: round(v.max) }]),
          ),
          // events the harnesses streamed to main in the window, and IPC messages main sent the windows
          // sidebar badge reads started in the window, by what made them (the effect's changed inputs, 'mount', 'again' or 'poll')
          badgeReads: of('badgeRead').reduce<Record<string, number>>((by, x) => ({ ...by, [x.trigger]: (by[x.trigger] ?? 0) + 1 }), {}),
          harnessEvents: of('raw').reduce((n, x) => n + x.count, 0),
          ipcSends: of('ipc').reduce((n, x) => n + x.count, 0),
          longtaskMs: round(of('longtask').reduce((n, x) => n + x.ms, 0)),
          longtaskMaxMs: round(Math.max(0, ...of('longtask').map((x) => x.ms))),
        };
        // one line per open in the test's output, which the CI artifact keeps even when the test passes
        console.log(`OPENROW ${JSON.stringify({ load: WITH_LOAD, rep, ...r })}`);
      }
      runs.push({ rep, rows });
      await testInfo.attach(`rows-rep${rep}.json`, { body: JSON.stringify(rows), contentType: 'application/json' });
    }
    const summary: Record<string, any> = {};
    for (const f of FAMILIES) {
      const rs = runs.flatMap((r) => r.rows).filter((r: any) => r.family === f);
      const of = (k: string) => rs.map((r: any) => r[k]).filter((v: any) => typeof v === 'number');
      summary[f] = {
        opens: rs.length,
        timedOut: rs.filter((r: any) => r.end === null).length,
        newestMs: {
          p50: round(quantile(of('newest'), 0.5)),
          p95: round(quantile(of('newest'), 0.95)),
          max: round(Math.max(0, ...of('newest'))),
        },
        endMs: { p50: round(quantile(of('end'), 0.5)), p95: round(quantile(of('end'), 0.95)), max: round(Math.max(0, ...of('end'))) },
        firstPageOldestMs: { p50: round(quantile(of('firstPageOldest'), 0.5)), p95: round(quantile(of('firstPageOldest'), 0.95)) },
      };
    }
    const result = { load: WITH_LOAD, sizes: SIZES, summary, runs };
    await testInfo.attach('open-chat.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    console.log(JSON.stringify({ load: WITH_LOAD, summary }));
    expect(runs).toHaveLength(REPEATS);
  });
}
