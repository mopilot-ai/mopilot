// A financial site saved for good (#5464): its site card and one JavaScript card answered "always" cover later runs in this turn and the next, while a committing click still asks; all bank requests are fulfilled locally in scratch Chrome.
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { pickScope } from './fixtures/approvalScope';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude' });
test.describe.configure({ timeout: 240_000 });

test('high-risk Always allow: the site and its page JavaScript are saved, a Confirm click still asks', async ({ page, launchChrome }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const chrome = await launchChrome();
  // No request goes to a real financial service.
  await chrome.context.route('https://www.chase.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Bank fixture</title>
      <button style="position:absolute;left:220px;top:20px;width:140px;height:50px" onclick="document.documentElement.dataset.confirmed='yes'">Confirm</button>`,
    }),
  );
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto('data:text/html,<title>Financial task panel</title><h1>Local task fixture</h1>');
  const side = await chrome.sidePanel(welcome, front);
  const panel = await side.panel();
  await panel.getByRole('button', { name: 'I understand' }).click();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await panel.getByRole('button', { name: 'Let’s go' }).click();
  await expect(panel.locator('#model')).toContainText('Fake Opus');
  const send = async (text: string) => {
    await panel.getByRole('textbox', { name: 'Message' }).fill(text);
    await panel.getByRole('button', { name: 'Send', exact: true }).click();
  };
  await send('CUCALL mcp__mopilot_chrome__navigate {"url":"https://www.chase.com/fixture"}');
  await expect(panel.locator('#cards')).toContainText('https://www.chase.com', { timeout: 30_000 });
  await panel.locator('#more').click();
  await panel.getByRole('menuitem', { name: 'Open in MoPilot', exact: false }).click();
  const card = page.locator('.sage-approval');
  // the site card of a high-risk site shows its risk and now offers Always allow
  await expect(card.locator('.approval-risk')).toContainText('Banking site');
  await card.getByRole('radio', { name: 'Read and write', exact: true }).check();
  await pickScope(card, /^Always allow/);
  try {
    await expect(panel.locator('#rows')).toContainText('Bank fixture', { timeout: 30_000 });
  } catch (error) {
    // what the app and the panel show when the step after the site card does not finish
    await test.info().attach('app', { body: await page.screenshot(), contentType: 'image/png' });
    await test.info().attach('panel', { body: await panel.screenshot(), contentType: 'image/png' });
    const text = async (l: any) => ((await l.count()) ? await l.allInnerTexts() : []);
    await test.info().attach('state', {
      body: JSON.stringify(
        {
          appCards: await text(page.locator('.approval-card')),
          appRows: await text(page.locator('.thread-view')),
          panelCards: await text(panel.locator('#cards')),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  }
  const bank = chrome.context.pages().find((p) => p.url() === 'https://www.chase.com/fixture');
  expect(bank).toBeTruthy();
  const tabId = await welcome.evaluate(async () => {
    const tabs = await (globalThis as any).chrome.tabs.query({});
    return tabs.find((t: any) => t.url === 'https://www.chase.com/fixture').id;
  });
  const runs = () => bank!.evaluate(() => document.documentElement.dataset.runs);
  const js = `CUCALL mcp__mopilot_chrome__javascript_tool ${JSON.stringify({
    tabId,
    text: 'document.documentElement.dataset.runs = String(1 + Number(document.documentElement.dataset.runs || 0))',
  })}`;
  // two runs in one turn: one card, answered Always allow on this site (a click, no hold)
  await send([js, js].join('\n'));
  await expect(card).toContainText('Banking site', { timeout: 30_000 });
  await card.getByRole('button', { name: /Always allow on this site/ }).click();
  await expect.poll(runs, { timeout: 30_000 }).toBe('2');
  await expect(card).toHaveCount(0);
  // the next turn's runs go without a card; a Confirm click still asks, held, with no Always allow
  await send(
    [js, `CUCALL mcp__mopilot_chrome__computer ${JSON.stringify({ tabId, action: 'left_click', coordinate: [280, 45] })}`].join('\n'),
  );
  await expect.poll(runs, { timeout: 30_000 }).toBe('3');
  await expect(card).toContainText("This can't be undone.", { timeout: 30_000 });
  await expect(card.getByRole('button', { name: /Always allow on this site/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Allow once/ })).toBeVisible();
  expect(await bank!.evaluate(() => document.documentElement.dataset.confirmed)).toBeUndefined();
  await card.getByRole('button', { name: /Deny/ }).click();
  await expect(card).toHaveCount(0);
});
