// What the continuous animations cost the renderer (#3151): per scene (idle list, 10/20/30 rows working, one chat streaming,
// e2e-runner: bench — about 40 minutes for three instances: it runs only when named (scripts/ci-cuj.mjs --spec perf-animations-trace*).
// A/B switches of single suspects, shimmer forms) a fixed window records a Chromium trace (Electron contentTracing), Performance.getMetrics,
// the frames the page produced, the layer count and every running animation, split by what it animates. Runs on a CI runner via
// `node scripts/ci-cuj.mjs --branch <b> --spec 'perf-animations-trace*'`; each repeat is a fresh instance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron, expect, test } from '@playwright/test';

const ROOT = path.resolve(__dirname, '../..');
/** The bench's ES modules, loaded natively: Playwright compiles this spec to CommonJS, which cannot import them. */
const load = (file: string): Promise<any> =>
  new Function('u', 'return import(u)')(pathToFileURL(path.join(ROOT, 'scripts/perf-bench', file)).href);
const FAMILIES = ['claude', 'codex', 'acp'] as const;
const ROWS = Number(process.env.PERF_ROWS ?? 40);
const REPEATS = Number(process.env.PERF_REPEATS ?? 3);
const WINDOW_MS = Number(process.env.PERF_WINDOW_MS ?? 10_000);
const SETTLE_MS = 1500;
const CATEGORIES = ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'gpu', 'viz', 'blink', 'latencyInfo'];

/** In the page: the running animations by type and by what they animate; `main` ones cannot run on the compositor. */
const ANIMATION_PROBE = () => {
  const COMPOSITED = new Set(['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter', 'backdrop-filter']);
  const META = new Set(['offset', 'easing', 'composite', 'computedOffset']);
  const out: any = { total: 0, byType: {}, composited: 0, main: 0, steps: 0, inViewport: 0, offscreen: 0, mainProps: {}, byName: {} };
  for (const a of document.getAnimations()) {
    out.total += 1;
    out.byType[a.constructor.name] = (out.byType[a.constructor.name] ?? 0) + 1;
    const effect = a.effect as KeyframeEffect;
    const props = new Set<string>();
    for (const kf of effect.getKeyframes()) for (const k of Object.keys(kf)) if (!META.has(k)) props.add(k);
    const bad = [...props].filter((p) => !COMPOSITED.has(p));
    if (bad.length === 0) out.composited += 1;
    else {
      out.main += 1;
      for (const p of bad) out.mainProps[p] = (out.mainProps[p] ?? 0) + 1;
    }
    if (String(effect.getTiming().easing).startsWith('steps')) out.steps += 1;
    const name = (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? 'script';
    out.byName[name] = (out.byName[name] ?? 0) + 1;
    const target = effect.target as Element | null;
    const r = target?.getBoundingClientRect();
    const seen = !!r && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
    if (seen) out.inViewport += 1;
    else out.offscreen += 1;
  }
  out.shimmerInfo = [...document.querySelectorAll('.shimmer-band')].map((el) => {
    const r = (el.parentElement as HTMLElement).getBoundingClientRect();
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      sidebar: !!el.closest('.sidebar'),
      cls: (el.parentElement as HTMLElement).className,
    };
  });
  out.dots = document.querySelectorAll('.row-dot.working, .row-dot.elsewhere').length;
  out.shimmers = document.querySelectorAll('.shimmer-band').length;
  out.spinners = document.querySelectorAll('.spinner:not(.still)').length;
  out.visibility = document.visibilityState;
  out.focused = document.hasFocus();
  return out;
};

/** Micro scenes on the idle list: five elements of one kind animating, so each kind's frame cost shows against the idle 2 frames/s. */
const VARIANTS: Record<string, { css: string; html: string }> = {
  'app-dot': { css: '', html: '<span class="row-dot working" style="position:fixed;top:{i}px;left:300px"></span>' },
  'app-shimmer': {
    css: '',
    html: '<span class="shimmer" style="position:fixed;top:{i}px;left:300px">Thinking<span class="shimmer-band"></span></span>',
  },
  'app-spinner': {
    css: '',
    html: '<span class="spinner" style="position:fixed;top:{i}px;left:300px;width:12px;height:12px;border:2px solid #888;border-top-color:transparent;border-radius:50%"></span>',
  },
  opacity: {
    css: '@keyframes mv{50%{opacity:.3}}',
    html: '<span style="position:fixed;top:{i}px;left:300px;width:8px;height:8px;background:#888;animation:mv 1.5s ease-in-out infinite"></span>',
  },
  translate: {
    css: '@keyframes mv{50%{translate:20px}}',
    html: '<span style="position:fixed;top:{i}px;left:300px;width:8px;height:8px;background:#888;animation:mv 3s linear infinite"></span>',
  },
  transform: {
    css: '@keyframes mv{50%{transform:translateX(20px)}}',
    html: '<span style="position:fixed;top:{i}px;left:300px;width:8px;height:8px;background:#888;animation:mv 3s linear infinite"></span>',
  },
  'rotate-steps': {
    css: '@keyframes mv{to{transform:rotate(360deg)}}',
    html: '<span style="position:fixed;top:{i}px;left:300px;width:12px;height:12px;border:2px solid #888;border-top-color:transparent;border-radius:50%;animation:mv 2s steps(60,end) infinite"></span>',
  },
  'rotate-linear': {
    css: '@keyframes mv{to{transform:rotate(360deg)}}',
    html: '<span style="position:fixed;top:{i}px;left:300px;width:12px;height:12px;border:2px solid #888;border-top-color:transparent;border-radius:50%;animation:mv 2s linear infinite"></span>',
  },
};

/** Shimmer forms compared at a forced 60 frames/s (one opacity animation drives them), five labels each, all in the app's colours. */
const LABEL = 'Working on it';
const GRAD = 'linear-gradient(120deg,transparent 37.5%,{peak} 50%,transparent 62.5%)';
const PEAK = 'color-mix(in srgb,#888 30%,white)';
const DRIVER = '<span style="position:fixed;top:0;left:0;width:2px;height:2px;background:#888;animation:drv 1s linear infinite"></span>';
const BASE_CSS =
  '@keyframes drv{50%{opacity:.3}}@keyframes sb{0%,15%{translate:-62.5%;animation-timing-function:cubic-bezier(.714,.121,.211,.888)}85%,100%{translate:-12.5%}}' +
  '@keyframes cl{0%,15%{translate:250%;animation-timing-function:cubic-bezier(.714,.121,.211,.888)}85%,100%{translate:50%}}' +
  '.l{position:fixed;left:300px;color:#888;display:inline-block;font:13px system-ui}' +
  '.l>.b{display:block;position:absolute;inset:0;overflow:clip}' +
  '.l>.b::after{content:"";position:absolute;inset:0 -300% 0 0;background-image:' +
  GRAD.replace('{peak}', PEAK) +
  ';translate:-62.5%;animation:sb 3s linear infinite}';
const label = (i: number, inner: string, cls = 'l', extra = '') =>
  `<span class="${cls}" style="top:${200 + i * 24}px;${extra}">${LABEL}${inner}</span>`;
const SHIMMERS: Record<string, { css: string; html: (i: number) => string }> = {
  'sh-current': {
    css: '.l{-webkit-mask-image:linear-gradient(black 0 0);-webkit-mask-clip:text}',
    html: (i) => label(i, '<span class="b"></span>'),
  },
  'sh-nomask': { css: '', html: (i) => label(i, '<span class="b"></span>') },
  'sh-clone': {
    css:
      '.l>.w{position:absolute;inset:0;overflow:clip}.l>.w>.m{position:absolute;top:0;bottom:0;left:0;width:400%;-webkit-mask-image:' +
      GRAD.replace('{peak}', 'black') +
      ';translate:-62.5%;animation:sb 3s linear infinite}.l>.w>.m>.c{position:absolute;top:0;left:0;color:' +
      PEAK +
      ';translate:250%;animation:cl 3s linear infinite}',
    html: (i) => label(i, `<span class="w"><span class="m"><span class="c">${LABEL}</span></span></span>`),
  },
};

const round = (x: number) => Math.round(x * 100) / 100;

test(`animation cost per scene: ${ROWS} rows, ${REPEATS} fresh instances`, async ({}, testInfo) => {
  test.skip(test.info().config.shard !== null, 'a bench: it takes a runner to itself, run it through ci-cuj');
  // three instances of 40 chats and 22 scenes each take about 40 minutes
  test.setTimeout(150 * 60_000);
  const { createDriver, warmSettings, writeSettings } = await load('driver.mjs');
  const { MARK } = await load('replay.mjs');
  const { summarizeTrace } = await load('traceSummary.mjs');
  const driver = createDriver({ electron: _electron, root: ROOT, log: (m: string) => console.log(m) });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'anim-trace-'));
  const runs: any[] = [];
  for (let rep = 1; rep <= REPEATS; rep++) {
    const s = await driver.start(path.join(work, `rep${rep}`), { foreground: true });
    const ids: string[] = [];
    writeSettings(s.ctl, warmSettings(256));
    for (let i = 0; i < ROWS; i++) ids.push(await driver.newChat(s, FAMILIES[i % FAMILIES.length], `${MARK} warm ${i}`));
    const cdp = await s.page.context().newCDPSession(s.page);
    await cdp.send('Performance.enable');
    await cdp.send('LayerTree.enable');
    let layers = 0;
    cdp.on('LayerTree.layerTreeDidChange', (e: any) => {
      layers = e.layers?.length ?? layers;
    });
    const scenes: any[] = [];
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m: any) => [m.name, m.value]));
    const appCpu = () =>
      s.app.evaluate(({ app }: any) => app.getAppMetrics().map((m: any) => ({ type: m.type, cpu: m.cpu.cumulativeCPUUsage })));

    /** Records one window of the scene as it stands. */
    async function scene(name: string, extra: Record<string, unknown> = {}) {
      await s.page.waitForTimeout(SETTLE_MS);
      const animations = await s.page.evaluate(ANIMATION_PROBE);
      const m0 = await metrics();
      const cpu0 = await appCpu();
      await s.app.evaluate(
        ({ contentTracing }: any, categories: string[]) => contentTracing.startRecording({ included_categories: categories }),
        CATEGORIES,
      );
      const t0 = Date.now();
      await s.page.waitForTimeout(WINDOW_MS);
      const seconds = (Date.now() - t0) / 1000;
      const file = path.join(work, `trace-rep${rep}-${name}.json`);
      await s.app.evaluate(({ contentTracing }: any, f: string) => contentTracing.stopRecording(f), file);
      const cpu = await appCpu();
      const m1 = await metrics();
      const trace = JSON.parse(fs.readFileSync(file, 'utf8'));
      const summary = summarizeTrace(trace.traceEvents ?? trace);
      fs.rmSync(file);
      const d = (k: string) => (m1[k] ?? 0) - (m0[k] ?? 0);
      // CPU seconds per wall second, summed over the processes of a type
      const sumOf = (xs: any[], t: string) => xs.filter((c: any) => c.type === t).reduce((n: number, c: any) => n + (c.cpu ?? 0), 0);
      const byType = (t: string) => round(((sumOf(cpu, t) - sumOf(cpu0, t)) / seconds) * 100);
      const row = {
        scene: name,
        ...extra,
        seconds: round(seconds),
        rendererBusyPct: round((d('TaskDuration') / seconds) * 100),
        scriptMs: round(d('ScriptDuration') * 1000),
        styleMs: round(d('RecalcStyleDuration') * 1000),
        layoutMs: round(d('LayoutDuration') * 1000),
        recalcStyleCount: d('RecalcStyleCount'),
        layoutCount: d('LayoutCount'),
        framesPerSecond: round(summary.frames.drawn / seconds),
        mainFramesPerSecond: round(summary.frames.main / seconds),
        layers,
        cpuPct: { renderer: byType('Tab'), gpu: byType('GPU'), browser: byType('Browser') },
        animations,
        trace: summary,
      };
      scenes.push(row);
      console.log(JSON.stringify(row));
    }

    // (a) the list idle
    await driver.openChat(s, ids[0]);
    await driver.focus(s);
    await scene('a-idle');
    // micro: each kind of animation alone on the idle list
    for (const [name, v] of Object.entries(VARIANTS)) {
      await s.page.evaluate(({ css, html }: { css: string; html: string }) => {
        const root = document.createElement('div');
        root.id = '__micro';
        root.innerHTML = `<style>${css}</style>${[0, 1, 2, 3, 4].map((i) => html.replaceAll('{i}', String(200 + i * 24))).join('')}`;
        document.body.append(root);
      }, v);
      await scene(`m-${name}`);
      await s.page.evaluate(() => document.getElementById('__micro')?.remove());
    }
    for (const [name, v] of Object.entries(SHIMMERS)) {
      await s.page.evaluate(
        ({ css, html }: { css: string; html: string[] }) => {
          const root = document.createElement('div');
          root.id = '__micro';
          root.innerHTML = `<style>${css}</style>${html.join('')}`;
          document.body.append(root);
        },
        { css: `${BASE_CSS}${v.css}`, html: [DRIVER, ...[0, 1, 2, 3, 4].map((i) => v.html(i))] },
      );
      // the same sweep phase in every form, for a pixel comparison
      await s.page.evaluate(() => {
        for (const a of document.getAnimations()) {
          a.pause();
          a.currentTime = 1800;
        }
      });
      await s.page.waitForTimeout(300);
      await testInfo.attach(`shimmer-${name}-rep${rep}.png`, {
        body: await s.page.screenshot({ clip: { x: 290, y: 195, width: 140, height: 130 } }),
        contentType: 'image/png',
      });
      await s.page.evaluate(() => {
        for (const a of document.getAnimations()) a.play();
      });
      await scene(`m-${name}`);
      await s.page.evaluate(() => document.getElementById('__micro')?.remove());
    }
    // (c) one open chat streaming: spinner, shimmer and steps
    writeSettings(s.ctl, { mode: 'replay', bytes: 8192, rate: 40, chunk: 4, toolEveryMs: 200, gate: false });
    const since = Date.now();
    await driver.send(s, `${MARK} stream ${rep}`);
    await scene('c-streaming');
    await driver.waitTurns(s, 1, since, 180_000);
    // (b) rows working: turns held mid-flight by the gate, so each row shows its working dot and shimmer
    writeSettings(s.ctl, { mode: 'replay', bytes: 8192, rate: 40, chunk: 4, toolEveryMs: 200, gate: true });
    fs.rmSync(path.join(s.ctl, 'go'), { force: true });
    let working = 0;
    for (const target of [10, 20, 30]) {
      for (; working < target; working++) {
        await driver.openChat(s, ids[working]);
        await s.page.locator('button.send-btn.stop').waitFor({ state: 'detached', timeout: 30_000 });
        await driver.send(s, `${MARK} load ${rep}`);
      }
      await scene(`b-working-${target}`, { working: target });
    }
    // (x) A/B inside the working scene: switch one suspect off at a time and see what the frames cost
    const AB: Record<string, string> = {
      'x-no-shimmer': '.shimmer-band::after{animation:none!important}',
      'x-no-shimmer-sidebar': '.sidebar .shimmer-band::after{animation:none!important}',
      'x-no-mask': ':is(.shimmer-text,.shimmer){-webkit-mask-image:none!important}',
      'x-contain-paint': ':is(.shimmer-text,.shimmer){contain:paint!important}',
      'x-isolate': ':is(.shimmer-text,.shimmer){isolation:isolate!important}',
      'x-willchange': '.shimmer-band::after{will-change:translate!important}',
    };
    for (const [name, css] of Object.entries(AB)) {
      await s.page.evaluate((c: string) => {
        const el = document.createElement('style');
        el.id = '__ab';
        el.textContent = c;
        document.head.append(el);
      }, css);
      await scene(name);
      await s.page.evaluate(() => document.getElementById('__ab')?.remove());
    }
    // quitting with turns still held mid-flight can wait on a confirmation: bound it, then end the process
    runs.push({ rep, scenes });
    await testInfo.attach(`animations-trace-rep${rep}.json`, {
      body: JSON.stringify({ rep, scenes }, null, 2),
      contentType: 'application/json',
    });
    await Promise.race([driver.stop(s, work), new Promise((r) => setTimeout(r, 30_000))]);
    s.app.process().kill('SIGKILL');
  }
  const result = { rows: ROWS, windowMs: WINDOW_MS, runs };
  await testInfo.attach('animations-trace.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(runs).toHaveLength(REPEATS);
  for (const r of runs) expect(r.scenes.length).toBeGreaterThanOrEqual(22);
});
