// Native Chrome side-panel forms deliver real SDK answers through trusted CDP clicks without moving the user to the desktop app.
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'claude' });
test.describe.configure({ timeout: 240_000 });
test('chrome-panel-forms on Claude Code: MCP form and multi-select question answer in the native panel', async ({
  page,
  launchChrome,
}, info) => {
  const chrome = await launchChrome();
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto('data:text/html,<title>Panel forms</title><h1>Local forms fixture</h1>');
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await side.inPanel(`(() => {
    const harness = document.getElementById('harness'); harness.value = 'claude'; harness.dispatchEvent(new Event('change'));
    const input = document.getElementById('text'); input.value = 'ELICIT ASKMULTI'; input.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
  const cards = () => side.inPanel(`document.getElementById('cards')?.textContent`);
  await expect.poll(cards, { timeout: 30_000 }).toContain('Which workspace?');
  expect(await cards()).not.toContain('Answer in MoPilot');
  await side.inPanel(`document.querySelector('#cards input').value = 'Panel workspace'`);
  await side.screenshot(info.outputPath('mcp-form.png'));
  await side.click('#cards .choices button:first-child');
  await expect.poll(cards, { timeout: 30_000 }).toContain('Which files?');
  await side.click('#cards input[value="a.ts"]');
  await side.click('#cards input[value="c.ts"]');
  await side.screenshot(info.outputPath('multi-select.png'));
  await side.click('#cards .choices button:first-child');
  await expect
    .poll(() => side.inPanel(`document.getElementById('rows')?.textContent`), { timeout: 30_000 })
    .toContain('[elicitation: accept]');
  await expect.poll(() => side.inPanel(`document.getElementById('rows')?.textContent`)).toContain('a.ts, c.ts');
  await expect.poll(cards).toBe('');
  expect(await side.inPanel(`document.getElementById('error')?.textContent`)).toBe('');
});
