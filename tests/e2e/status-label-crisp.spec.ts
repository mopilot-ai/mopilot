// The running status line's words stay crisp text while the label changes over a long turn (#4654): the owner saw
// "Searching web Bosch 800 Series 36 in induction…" smeared and blocky after its first words. A fake Claude (LABELCHURN) runs
// 24 Bash calls with long, distinct descriptions, one label every ~1.1 s. The spec takes the window's own pixels (capturePage,
// so the compositor's raster) around the label ~0.7 s after each one appears, and afterwards compares each crop with the same
// words drawn as plain text: the ink of a smeared label sits in other columns than the plain words' ink. The label's computed
// style is checked too (no filter, opacity 1, no transform). The plain words take every text-drawing property of the live label
// (its variable font weight 430 among them), and a crop counts only when the label neither moved nor changed while it was captured
// and the frame had painted it (#4943). Covers 'src/styles/app/motion.css' and
// 'src/components/ui/ShimmerBand.tsx'.
import fs from 'node:fs';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

test.use({ harnesses: 'claude' });

const LABEL = '.claude-activity-label';
const LABELS = 24;
/** Column-ink similarity of a crop and the plain words: ~0.83 for the same words, ~0.75 where the highlight band crosses them, 0.46 smeared. */
const MIN_SIMILARITY = 0.6;

/** Allows every approval card that shows, until the signal says stop. */
async function allowAll(page: Page, stop: { done: boolean }) {
  while (!stop.done) {
    const allow = page
      .locator('.approval-card')
      .getByRole('button', { name: /Allow once/ })
      .first();
    if (await allow.isVisible().catch(() => false)) await allow.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

/** The label's own and its ancestors' effects that could smear or double its words, and how many text nodes it holds. */
function describeLabel(page: Page) {
  return page.evaluate((selector) => {
    const label = document.querySelector<HTMLElement>(selector);
    if (!label) return null;
    const chain: Record<string, string>[] = [];
    for (let el: HTMLElement | null = label; el && el.tagName !== 'MAIN'; el = el.parentElement) {
      const cs = getComputedStyle(el);
      chain.push({ el: `${el.tagName.toLowerCase()}.${el.className}`, filter: cs.filter, opacity: cs.opacity, transform: cs.transform });
    }
    const textNodes = [...label.childNodes].filter((n) => n.nodeType === 3 && n.textContent?.trim()).length;
    return { text: label.textContent, textNodes, chain };
  }, LABEL);
}

const wordsOf = (page: Page) =>
  page
    .locator(LABEL)
    .first()
    .textContent({ timeout: 500 })
    .then((t) => t ?? '')
    .catch(() => '');

const setZoom = (h: Harness, level: number) =>
  h.app.evaluate(({ BrowserWindow }, l) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.setZoomLevel(l);
  }, level);

const setVisible = (h: Harness, visible: boolean) =>
  h.app.evaluate(({ BrowserWindow }, v) => {
    for (const win of BrowserWindow.getAllWindows()) if (win.webContents.getURL().startsWith('file:')) v ? win.show() : win.hide();
  }, visible);

/**
 * Keeps the window's pixels around the live label under `key` (in the app's main process), with the label's box and words.
 * Returns the words, or '' when the label moved or changed while it was captured (the crop says nothing about the label then).
 * A crop with no ink at all is a frame that had not painted the label yet (the first one after the window was shown again):
 * it is taken again for up to 2 s, and the last crop is kept if no ink ever appears, so a label that really is not painted
 * still fails the similarity check (it scores 0).
 */
function keep(h: Harness, selector: string, key: string) {
  return h.app.evaluate(
    async ({ BrowserWindow }, [sel, k]) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL().startsWith('file:') && !w.webContents.getURL().includes('#mini'),
      )!;
      const wc = win.webContents;
      const read = `(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, words: el.firstChild.textContent, inner: window.innerWidth };
      })()`;
      let box: any;
      let crop: any;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // two frames first, so the capture below is of a frame that holds what the box and words are read from: the
        // compositor's last frame can be older than the DOM (the first label of a turn, cropped where the avatar still was)
        await wc.executeJavaScript(
          'new Promise((done) => { setTimeout(done, 300); requestAnimationFrame(() => requestAnimationFrame(() => done(0))); })',
        );
        box = await wc.executeJavaScript(read);
        const image = await wc.capturePage();
        // the capture is asynchronous: a label that moved or changed its words meanwhile (the transcript reflowing as a new
        // step arrives) was cropped from where it no longer is
        const after = await wc.executeJavaScript(read);
        if (after.x !== box.x || after.y !== box.y || after.w !== box.w || after.h !== box.h || after.words !== box.words) return '';
        const scale = image.getSize().width / box.inner;
        crop = image.crop({
          x: Math.floor(box.x * scale),
          y: Math.floor(box.y * scale),
          width: Math.ceil(Math.min(box.w, 640) * scale),
          height: Math.ceil(box.h * scale),
        });
        const px = crop.toBitmap();
        let lo = 255;
        let hi = 0;
        for (let i = 0; i < px.length; i += 4) {
          const l = 0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2];
          lo = Math.min(lo, l);
          hi = Math.max(hi, l);
        }
        if (hi - lo >= 8) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const g = globalThis as any;
      g.__crisp ??= new Map();
      g.__crisp.set(k, { box, crop });
      return box.words as string;
    },
    [selector, key] as const,
  );
}

/**
 * How alike each kept crop is to the same words drawn as plain text at the same sub-pixel offset, width and line clamp:
 * 1 minus the share of ink (darkness over the page's background) that sits in different columns. Both crops come back as PNGs.
 */
function compare(h: Harness, selector: string, keys: string[]) {
  return h.app.evaluate(
    async ({ BrowserWindow }, [sel, ks]) => {
      const win = BrowserWindow.getAllWindows().find(
        (w) => w.webContents.getURL().startsWith('file:') && !w.webContents.getURL().includes('#mini'),
      )!;
      const wc = win.webContents;
      const g = globalThis as any;
      const profile = (crop: any) => {
        const { width, height } = crop.getSize();
        const px = crop.toBitmap();
        const lum = (i: number) => 0.114 * px[i] + 0.587 * px[i + 1] + 0.299 * px[i + 2];
        let bg = 0;
        for (let i = 0; i < px.length; i += 4) bg = Math.max(bg, lum(i));
        const cols = new Float64Array(width);
        for (let x = 0; x < width; x += 1) for (let y = 0; y < height; y += 1) cols[x] += Math.max(0, bg - lum((y * width + x) * 4));
        return cols;
      };
      const out: { key: string; words: string; similarity: number; blank: boolean; live: string; plain: string }[] = [];
      for (const k of ks as string[]) {
        const { box, crop } = g.__crisp.get(k);
        await wc.executeJavaScript(`(() => {
          const live = document.querySelector(${JSON.stringify(sel)});
          const cs = getComputedStyle(live);
          const holder = document.createElement('div');
          holder.dataset.crispProbe = '1';
          holder.style.cssText = 'position:fixed;z-index:99999;background:var(--bg, #fff);left:0;top:90px;width:' + (${box.w} + 80) + 'px;padding:4px 0 4px ' + (${box.x} - Math.floor(${box.x}) + 40) + 'px;';
          const copy = document.createElement('span');
          copy.style.cssText = 'display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;width:${box.w}px;font-size:' + cs.fontSize + ';line-height:' + cs.lineHeight + ';font-family:' + cs.fontFamily + ';color:' + cs.color + ';';
          // every other property that sets how the words are drawn comes from the live label too, so only the band differs
          for (const p of ['font-weight', 'font-style', 'font-stretch', 'font-kerning', 'font-feature-settings', 'font-variation-settings', 'font-optical-sizing', 'font-synthesis', 'font-variant-ligatures', 'font-variant-numeric', 'letter-spacing', 'word-spacing', 'text-rendering', '-webkit-font-smoothing', 'text-transform', 'text-indent', 'text-shadow'])
            copy.style.setProperty(p, cs.getPropertyValue(p));
          copy.textContent = ${JSON.stringify(box.words)};
          holder.append(copy);
          document.body.append(holder);
        })()`);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const image = await wc.capturePage();
        const at = await wc.executeJavaScript(
          `(() => { const r = document.querySelector('[data-crisp-probe] span').getBoundingClientRect(); return { x: r.left, y: r.top, inner: window.innerWidth }; })()`,
        );
        const s = image.getSize().width / at.inner;
        const ref = image.crop({
          x: Math.floor(at.x * s),
          y: Math.floor(at.y * s),
          width: crop.getSize().width,
          height: crop.getSize().height,
        });
        await wc.executeJavaScript(`document.querySelectorAll('[data-crisp-probe]').forEach((e) => e.remove())`);
        const a = profile(crop);
        const p = profile(ref);
        let diff = 0;
        let sum = 0;
        for (let x = 0; x < Math.min(a.length, p.length); x += 1) {
          diff += Math.abs(a[x] - p[x]);
          sum += a[x] + p[x];
        }
        out.push({
          key: k,
          words: box.words,
          similarity: sum ? 1 - diff / sum : 0,
          blank: sum === 0,
          live: crop.toPNG().toString('base64'),
          plain: ref.toPNG().toString('base64'),
        });
      }
      return out;
    },
    [selector, keys] as const,
  );
}

/** One LABELCHURN turn: a crop for each of the 24 labels, then (zoom) the held label at other zoom levels, each compared with plain text. */
async function churn(
  page: Page,
  harness: Harness,
  testInfo: TestInfo,
  { load, zoom, others, hide }: { load: boolean; zoom: boolean; others?: boolean; hide?: boolean },
) {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  // a busy main thread (45% of every 100 ms) widens any race between the renderer's paint and the compositor's raster
  if (load)
    await page.evaluate(() =>
      setInterval(() => {
        const t = performance.now();
        while (performance.now() - t < 45);
      }, 100),
    );
  // other shimmering labels coming and going around it, as a sidebar title or a card does while a turn runs
  if (others)
    await page.evaluate(() =>
      setInterval(() => {
        const span = document.createElement('span');
        span.className = 'shimmer-text';
        span.style.cssText = 'position:fixed;z-index:1;left:8px;bottom:8px;font-size:12px';
        span.textContent = `Working ${Math.random()}`;
        const band = document.createElement('span');
        band.className = 'shimmer-band';
        span.append(band);
        document.body.append(span);
        setTimeout(() => span.remove(), 240);
      }, 330),
    );
  const stop = { done: false };
  const approvals = allowAll(page, stop);
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('LABELCHURN go');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const kept: string[] = [];
  const styles: { words: string; style: Awaited<ReturnType<typeof describeLabel>> }[] = [];
  let last = '';
  let hidden = false;
  let labels = 0;
  // three crops of each new label: as soon as it appears, 0.25 s and 0.6 s later (a stale mask may last a moment only)
  const deadline = Date.now() + 150_000;
  while (labels < LABELS && Date.now() < deadline) {
    const text = await wordsOf(page);
    if (hide && labels === 4 && !hidden) {
      // the window is away for a while (the user is in another app) and the labels keep changing
      hidden = true;
      await setVisible(harness, false);
      await page.waitForTimeout(5000);
      await setVisible(harness, true);
      last = '';
      await page.waitForTimeout(300);
      continue;
    }
    if (text && text !== last && !/^Thinking/.test(text)) {
      last = text;
      let taken = 0;
      for (const wait of [0, 250, 350]) {
        await page.waitForTimeout(wait);
        const key = `label-${labels}-${taken}`;
        const words = await keep(harness, LABEL, key);
        // a label that changed while it was kept says nothing about itself
        if (words !== text) break;
        kept.push(key);
        taken += 1;
      }
      if (taken) {
        labels += 1;
        styles.push({ words: text, style: await describeLabel(page) });
      }
    }
    await page.waitForTimeout(40);
  }
  expect(labels, 'labels measured').toBeGreaterThanOrEqual(LABELS - 4);

  // the last label is held: zoom reflows its words and rasters them at another scale, and they must stay crisp
  const results = await compare(harness, LABEL, kept);
  for (const level of zoom ? [1, 2, 0] : []) {
    await setZoom(harness, level);
    await page.waitForTimeout(800);
    await keep(harness, LABEL, `zoom-${level}`);
    results.push(...(await compare(harness, LABEL, [`zoom-${level}`])));
  }
  harness.releaseClaudeCommand();
  stop.done = true;
  await approvals;
  for (const r of results) {
    fs.writeFileSync(testInfo.outputPath(`${r.key}.live.png`), Buffer.from(r.live, 'base64'));
    fs.writeFileSync(testInfo.outputPath(`${r.key}.plain.png`), Buffer.from(r.plain, 'base64'));
    console.log('label', JSON.stringify({ key: r.key, similarity: +r.similarity.toFixed(3), words: r.words }));
  }

  for (const { words, style } of styles) {
    // one visible text node, no effect left on the label or an ancestor
    expect(style?.textNodes, words).toBe(1);
    for (const link of style?.chain ?? []) {
      expect(link.filter, `${words}: ${link.el}`).toBe('none');
      expect(link.opacity, `${words}: ${link.el}`).toBe('1');
      expect(link.transform, `${words}: ${link.el}`).toBe('none');
    }
  }
  // the live words sit where the plain words' ink sits
  // a capture with no ink at all (the window was not painting) is not a sample; a few are tolerated
  const blank = results.filter((r) => r.blank);
  expect(blank.length, `blank captures: ${blank.map((r) => r.key)}`).toBeLessThanOrEqual(Math.ceil(results.length * 0.05));
  const smeared = results
    .filter((r) => !r.blank && r.similarity < MIN_SIMILARITY)
    .map((r) => `${r.key} ${r.similarity.toFixed(3)} ${r.words}`);
  expect(smeared, `smeared labels of ${results.length}`).toEqual([]);
}

test('the status label stays crisp while it changes over a turn', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000);
  await churn(page, harness, testInfo, { load: false, zoom: true });
});

test('the status label stays crisp while the renderer is busy', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000);
  await churn(page, harness, testInfo, { load: true, zoom: false });
});

test('the status label stays crisp while other shimmering labels come and go', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000);
  await churn(page, harness, testInfo, { load: false, zoom: false, others: true });
});

test('the status label stays crisp after the window was hidden while it changed', async ({ page, harness }, testInfo) => {
  test.setTimeout(240_000);
  await churn(page, harness, testInfo, { load: false, zoom: false, hide: true });
});
