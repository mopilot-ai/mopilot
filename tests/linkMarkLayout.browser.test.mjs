// Focused stylesheet unit tests: render isolated link marks, without starting MoPilot.
// Run with: node --test tests/linkMarkLayout.browser.test.mjs
// Uses installed Chrome; set LINK_LAYOUT_BROWSER to a Chromium executable on other machines.
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

// app.css only imports its area files (src/styles/app/); inline them in order, as the build does
const manifest = new URL('../src/styles/app.css', import.meta.url);
const css = [...readFileSync(manifest, 'utf8').matchAll(/^@import '\.\/([\w/-]+\.css)';$/gm)]
  .map((m) => readFileSync(new URL(m[1], manifest), 'utf8'))
  .join('');
let browser;
before(async () => {
  browser = await chromium.launch(
    process.env.LINK_LAYOUT_BROWSER ? { executablePath: process.env.LINK_LAYOUT_BROWSER } : { channel: 'chrome' },
  );
});
after(async () => {
  await browser?.close();
});

async function fixture(t, { size = 14, width = 420, text = 'Source title' } = {}) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(`<style>${css}
    body { font-family: Arial, sans-serif; font-size: ${size}px; line-height: 1.6; }
    .md { width: ${width}px; }
  </style><div class="md"><ul><li><a href="https://example.com">
    <span class="md-favicon" aria-hidden="true" data-letter="R"></span><span class="title">${text}</span>
  </a></li></ul></div>`);
  return page;
}

test('link mark position does not depend on the smaller generated letter baseline', async (t) => {
  const page = await fixture(t);
  const badge = page.locator('.md-favicon');
  const initial = await badge.boundingBox();
  await page.addStyleTag({ content: '.md .md-favicon::before { font-size: 0.3em; }' });
  const smaller = await badge.boundingBox();
  assert.ok(Math.abs(initial.y - smaller.y) < 0.1, 'changing the letter must not move the badge');
  assert.ok(Math.abs(initial.height - smaller.height) < 0.1);
});

test('link mark remains square and scales with the surrounding text', async (t) => {
  for (const size of [14, 20, 28]) {
    const page = await fixture(t, { size });
    const box = await page.locator('.md-favicon').boundingBox();
    assert.equal(box.width, size);
    assert.equal(box.height, size);
  }
});

test('wrapped CJK and Latin titles retain inline flow and decorative marks stay out of copied text', async (t) => {
  for (const text of [
    '\u65c5\u5c45\u6d77\u5916\u5927\u9646\u5730\u533a\u4eba\u6c11'.repeat(5),
    'A source title that wraps across several lines '.repeat(3),
  ]) {
    const page = await fixture(t, { text, width: 180 });
    const geometry = await page.locator('.title').evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return [...range.getClientRects()].map(({ x, y }) => ({ x, y }));
    });
    const badge = await page.locator('.md-favicon').boundingBox();
    assert.ok(geometry.length > 1, 'title must wrap');
    assert.ok(geometry[0].x >= badge.x + badge.width, 'first line follows the badge');
    assert.ok(Math.abs(geometry[0].y - badge.y) < 8, 'badge stays beside the first line');
    assert.ok(geometry[1].x < geometry[0].x, 'continuation uses normal inline wrapping');
    assert.equal((await page.locator('a').innerText()).trim(), text.trim());
    assert.equal(await page.locator('.md-favicon').getAttribute('aria-hidden'), 'true');
  }
});
