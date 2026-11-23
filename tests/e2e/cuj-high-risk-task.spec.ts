// A financial site's task allowance covers ordinary clicks in one turn, while a committing control still asks; all bank requests are fulfilled locally in scratch Chrome.
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { pickScope } from './fixtures/approvalScope';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude' });
test.describe.configure({ timeout: 240_000 });

test('high-risk task allowance: ordinary clicks share consent, Confirm still asks', async ({ page, launchChrome }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const chrome = await launchChrome();
  // No request goes to a real financial service.
  await chrome.context.route('https://www.chase.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Bank fixture</title>
      <button style="position:absolute;left:20px;top:20px;width:140px;height:50px" onclick="document.documentElement.dataset.clicks=String(1+Number(document.documentElement.dataset.clicks||0))">Search hotels</button>
      <button style="position:absolute;left:220px;top:20px;width:140px;height:50px" onclick="document.documentElement.dataset.confirmed='yes'">Confirm</button>`,
    }),
  );
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto('data:text/html,<title>Financial task panel</title><h1>Local task fixture</h1>');
  const side = await chrome.sidePanel(welcome, front);
  const panel = await side.panel();
  await expect(panel.getByRole('button', { name: 'I understand' })).toBeVisible();
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
  await card.getByRole('radio', { name: 'Read and write', exact: true }).check();
  await pickScope(card, /Allow in this chat/);
  await expect(panel.locator('#rows')).toContainText('Bank fixture', { timeout: 30_000 });
  const bank = chrome.context.pages().find((p) => p.url() === 'https://www.chase.com/fixture');
  expect(bank).toBeTruthy();
  const tabId = await welcome.evaluate(async () => {
    const tabs = await (globalThis as any).chrome.tabs.query({});
    return tabs.find((t: any) => t.url === 'https://www.chase.com/fixture').id;
  });
  const click = (x: number) =>
    `CUCALL mcp__mopilot_chrome__computer ${JSON.stringify({ tabId, action: 'left_click', coordinate: [x, 45] })}`;
  await send([click(80), click(80), click(280)].join('\n'));
  await card.getByRole('button', { name: /Allow for this task/ }).click();
  await expect.poll(() => bank!.evaluate(() => document.documentElement.dataset.clicks), { timeout: 30_000 }).toBe('2');
  // Confirm is still a separate held confirmation, even though the same turn has the task allowance.
  await expect(card).toContainText("This can't be undone.");
  await expect(card.getByRole('button', { name: /Allow for this task/ })).toHaveCount(0);
  await expect(card.getByRole('button', { name: /Allow once/ })).toBeVisible();
  expect(await bank!.evaluate(() => document.documentElement.dataset.confirmed)).toBeUndefined();
  await card.getByRole('button', { name: /Deny/ }).click();
  await expect(card).toHaveCount(0);
});
