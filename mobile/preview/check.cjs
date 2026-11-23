// Browser smoke check of the web preview (real mobile components, injected test runtime): it starts, draws the chat list, opens a chat and answers its cards.
// Run `npx vite --config preview/vite.config.mjs` in mobile/ first. Screen behavior itself is covered by the phone component tests (tests/phone*.test.ts).
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.MOBILE_PREVIEW_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto('http://127.0.0.1:4189/preview/');
    await page.getByText('Website launch').waitFor();
    await page.getByText('Studio Mac').waitFor();
    await page.screenshot({ path: '/tmp/mobile-home.png' });
    await page.getByText('Website launch').click();
    await page.getByText('Run this command?').waitFor();
    await page.getByText('I am reviewing it now.').waitFor();
    await page.screenshot({ path: '/tmp/mobile-thread.png' });
    await page.getByText('Allow once').click();
    await page.getByText('One', { exact: true }).click();
    await page.getByText('Send answer').click();
    await page.waitForFunction(() => window.calls.filter((c) => c.method === 'card.answer').length === 2);
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(
      calls.filter((c) => c.method === 'card.answer').map(({ params: p }) => ({ cardId: p.cardId, key: p.key, values: p.values ?? null })),
      [
        { cardId: 'a', key: 'once', values: null },
        { cardId: 'b', key: 'submit', values: { q: ['One'] } },
      ],
    );
    assert.deepEqual(errors, [], 'the page raised no errors');
    console.log('mobile preview: started, drew the chat list, opened a chat and answered both cards');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
