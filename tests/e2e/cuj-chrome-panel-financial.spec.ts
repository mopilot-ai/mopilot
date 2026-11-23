// The actual native panel answers a financial site's scopes and held confirmation on the original page, with every bank request fulfilled locally.
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude' });
test.describe.configure({ timeout: 240_000 });
test('chrome-panel-financial: task scope and short/complete confirmation holds stay in the native panel', async ({
  page,
  launchChrome,
}, info) => {
  const chrome = await launchChrome();
  await chrome.context.route('https://www.chase.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Local bank fixture</title>
    <button style="position:absolute;left:20px;top:20px;width:140px;height:50px" onclick="document.documentElement.dataset.clicks=String(1+Number(document.documentElement.dataset.clicks||0))">Search hotels</button>
    <button style="position:absolute;left:220px;top:20px;width:140px;height:50px" onclick="document.documentElement.dataset.confirmed='yes'">Confirm</button>`,
    }),
  );
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto('https://www.chase.com/panel-fixture');
  const side = await chrome.sidePanel(welcome, front);
  await expect.poll(() => side.inPanel(`document.getElementById('tab-title')?.textContent`)).toBe('Local bank fixture');
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await side.inPanel(`(() => { const h=document.getElementById('harness'); h.value='claude'; h.dispatchEvent(new Event('change')); })()`);
  const tabId = await welcome.evaluate(
    async () => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === 'https://www.chase.com/panel-fixture').id,
  );
  const send = (text: string) =>
    side.inPanel(
      `(() => { const input=document.getElementById('text'); input.value=${JSON.stringify(text)}; input.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit(); })()`,
    );
  const cards = () => side.inPanel(`document.getElementById('cards')?.textContent`);
  await send(`CUCALL mcp__mopilot_chrome__read_page ${JSON.stringify({ tabId, filter: 'all' })}`);
  await expect.poll(cards, { timeout: 30_000 }).toContain('chase.com');
  expect(await cards()).not.toContain('Answer in MoPilot');
  await side.inPanel(`document.querySelector('#cards select').value='write'`);
  await side.click('#cards button[data-choice="chat"]');
  await expect
    .poll(() => side.inPanel(`document.getElementById('rows')?.textContent`), { timeout: 30_000 })
    .toContain('Local bank fixture');
  await expect.poll(() => side.inPanel(`document.getElementById('progress-text')?.textContent`)).toBe('Done');
  const click = (x: number) =>
    `CUCALL mcp__mopilot_chrome__computer ${JSON.stringify({ tabId, action: 'left_click', coordinate: [x, 45] })}`;
  await send([click(80), click(80), click(280)].join('\n'));
  await expect.poll(cards, { timeout: 30_000 }).toContain('Allow for this task');
  await side.screenshot(info.outputPath('financial-task.png'));
  await side.click('#cards button[data-choice="task"]');
  await expect.poll(() => front.evaluate(() => document.documentElement.dataset.clicks), { timeout: 30_000 }).toBe('2');
  await expect.poll(cards).toContain("This can't be undone.");
  expect(await cards()).not.toContain('Allow for this task');
  await side.inPanel(`(() => {
    globalThis.__holdEvents = [];
    const capture = event => {
      if (globalThis.__holdEvents.length >= 100) globalThis.__holdEvents.shift();
      const button = document.querySelector('#cards button[data-choice="once"]');
      const rect = button?.getBoundingClientRect();
      globalThis.__holdEvents.push({type:event.type, target:event.target?.tagName, choice:event.target?.dataset?.choice,
        trusted:event.isTrusted, at:performance.now(), hidden:document.hidden, active:document.activeElement?.tagName,
        holding:button?.classList.contains('holding'), top:rect?.top, scroll:document.getElementById('chat')?.scrollTop});
    };
    for (const name of ['pointerdown','pointerup','pointerleave','pointercancel','blur','focus','visibilitychange','scroll'])
      document.addEventListener(name, capture, true);
  })()`);
  await side.screenshot(info.outputPath('held-confirmation.png'));
  await side.click('#cards button[data-choice="once"]', 200);
  // Outlast the original hold deadline: a cancelled timer must never submit after pointer release.
  await front.waitForTimeout(1100);
  // Diagnostic rectangle reads are intentionally observable, not timing-neutral instrumentation.
  const shortEvidence = await side.inPanel(`globalThis.__holdEvents`);
  await info.attach('native-short-hold-events.json', { body: JSON.stringify(shortEvidence, null, 2), contentType: 'application/json' });
  expect(shortEvidence.some((event: any) => event.type === 'pointerdown' && event.choice === 'once' && event.trusted)).toBe(true);
  expect(await front.evaluate(() => document.documentElement.dataset.confirmed)).toBeUndefined();
  await expect.poll(cards).toContain('Allow once');
  await side.click('#cards button[data-choice="once"]', 1100, async () => {
    await expect
      .poll(
        () => side.inPanel(`(() => { const b=document.querySelector('#cards button[data-choice="once"]'); return !b || b.disabled; })()`),
        { timeout: 5000 },
      )
      .toBe(true);
  });
  const holdEvidence = await side.inPanel(`({events:globalThis.__holdEvents, error:document.getElementById('error')?.textContent,
    cards:document.getElementById('cards')?.textContent})`);
  await info.attach('native-hold-events.json', { body: JSON.stringify(holdEvidence, null, 2), contentType: 'application/json' });
  await expect
    .poll(() => front.evaluate(() => document.documentElement.dataset.confirmed), {
      timeout: 30_000,
      message: JSON.stringify(holdEvidence),
    })
    .toBe('yes');
  await expect.poll(cards).toBe('');
  expect(await side.inPanel(`document.getElementById('error')?.textContent`)).toBe('');
  expect(await welcome.evaluate(async (id) => (await (globalThis as any).chrome.tabs.get(id)).url, tabId)).toBe(
    'https://www.chase.com/panel-fixture',
  );
});
