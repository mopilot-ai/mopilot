// Computer use in the real app: the fakes call the injected computer tools, main asks on Sage's own
// card, and the call runs against a fake helper on a socket (never the real screen).
// These drive the computer_* tools, offered while shared.computerUse.parityTools is off (COMPUTER_TOOLS); with the
// default switches the desktop_* tools replace them (last describe).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { goalPill } from './fixtures/goal';
import { pickScope } from './fixtures/approvalScope';
import { COMPUTER_TOOLS, remoteFlags } from './fixtures/flags';
import { openedExternal } from './fixtures/externalUrls';
import { PRIVACY_PANES } from '../../shared/skyComputerUse.mjs';
import { settingsEntry } from './fixtures/settings';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const card = (page: Page) => page.locator('.sage-approval');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('Claude Code', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('a click asks on the card; Allow once runs it in Notes only, and the next click asks again', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_click {"x":10,"y":20}');
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText('Allow Claude Code to control Notes');
    // a click needs at least Click: View only can't be picked
    await expect(card(page).getByRole('radio', { name: 'View only' })).toBeDisabled();
    await expect(card(page).getByRole('radio', { name: 'Click' })).toHaveAttribute('aria-checked', 'true');
    await pickScope(card(page), /Allow once/);
    await expect(transcript(page).getByText(/\[cu: Done: click in Notes\. <image>/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);

    const helper = harness.helper!;
    const clicks = helper.log.filter((m) => m.method === 'input.click');
    expect(clicks).toHaveLength(1);
    expect(clicks[0].params).toMatchObject({ x: 10, y: 20, bundleIds: ['com.apple.Notes'] });
    // started on first use, took the desktop once; a Claude model gets a screenshot back
    expect(helper.log[0].method).toBe('hello');
    expect(helper.log.filter((m) => m.method === 'control.acquire')).toHaveLength(1);
    expect(helper.log.some((m) => m.method === 'screenshot')).toBe(true);
    // the window glow ran around the click, for Notes' pid
    const order = helper.log.map((m) => m.method);
    expect(helper.log.find((m) => m.method === 'glow.start')?.params).toEqual({ pid: 4242 });
    expect(order.indexOf('glow.start')).toBeLessThan(order.indexOf('input.click'));
    expect(order.lastIndexOf('glow.stop')).toBeGreaterThan(order.indexOf('input.click'));
    // the turn ended: the desktop was let go
    await expect.poll(() => helper.log.filter((m) => m.method === 'control.release').length).toBe(1);

    // Allow once kept nothing: Deny refuses the next click
    await send(page, 'CUCALL computer_click {"x":11,"y":21}');
    await expect(card(page)).toBeVisible();
    await card(page).getByRole('button', { name: /Deny/ }).click();
    await expect(transcript(page).getByText(/\[cu: error: The user didn't allow controlling Notes\]/)).toBeVisible();
    expect(helper.log.filter((m) => m.method === 'input.click')).toHaveLength(1);
  });

  test('Allow in this chat is kept for the chat; an action that cannot be undone still asks every time', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_type {"text":"hello"}');
    await expect(card(page)).toContainText('Allow Claude Code to control Notes');
    // typing needs Full control
    await expect(card(page).getByRole('radio', { name: 'Full control' })).toHaveAttribute('aria-checked', 'true');
    await pickScope(card(page), /Allow in this chat/);
    await expect(transcript(page).getByText(/\[cu: Done: type in Notes\./)).toBeVisible();

    // no card the second time in this chat
    await send(page, 'CUCALL computer_key {"key":"cmd+a"}');
    await expect(transcript(page).getByText(/\[cu: Done: key in Notes\./)).toBeVisible();

    // the model says this one can't be undone: confirmed on its own card
    await send(page, 'CUCALL computer_key {"key":"cmd+Delete"}');
    await expect(card(page)).toContainText("Allow Claude Code to delete in Notes? This can't be undone.");
    await expect(card(page).getByRole('button', { name: /Always allow/ })).toHaveCount(0);
    await pickScope(card(page), /Allow once/);
    await expect(transcript(page).getByText(/\[cu: Done: key in Notes\./)).toHaveCount(2);
    expect(harness.helper!.log.filter((m) => m.method === 'input.key').map((m) => m.params.key)).toEqual(['cmd+a', 'cmd+Delete']);
  });
});

test.describe('missing permission', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('a tool that fails for Screen Recording shows the guide card; Open System Settings goes to that pane; Try again clears it', async ({
    page,
    harness,
  }) => {
    const helper = harness.helper!;
    helper.permissions.screenRecording = false;
    helper.enforcePermissions = true;
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_screenshot {}');
    await pickScope(card(page), /Allow once/);
    const guide = page.locator('.cu-permission');
    await expect(guide).toHaveAttribute('data-permission', 'screenRecording');
    await expect(guide).toContainText('Allow Screen Recording so Claude Code can see the screen.');
    await expect(transcript(page).getByText(/\[cu: error: screenRecording permission not granted/)).toBeVisible();
    // Accessibility is granted: only Screen Recording's row has actions. The idle helper quits first (System Settings has
    // no running app to ask to Quit & Reopen) and main opens the pane
    await guide.getByRole('button', { name: 'Open System Settings' }).click();
    await expect.poll(() => openedExternal(harness)).toEqual([PRIVACY_PANES.screenRecording]);
    expect(helper.log.filter((m) => m.method === 'permissions.openSettings')).toEqual([]);
    // still missing: the card stays
    const statusChecks = helper.log.filter((m) => m.method === 'permissions.status').length;
    await guide.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => helper.log.filter((m) => m.method === 'permissions.status').length).toBeGreaterThan(statusChecks);
    await expect(guide).toBeVisible();
    helper.permissions.screenRecording = true;
    await guide.getByRole('button', { name: 'Try again' }).click();
    await expect(guide).toHaveCount(0);
  });
});

test.describe('activity bar', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('Using Notes; a take-over pauses until Done, continue; Esc stops the turn and lets go', async ({ page, harness }) => {
    const bar = page.locator('.cu-activity');
    const helper = harness.helper!;
    await expect(home(page)).toBeVisible();
    // the click, then a reply that keeps the turn running
    await send(page, 'CUCALL computer_click {"x":10,"y":20} SLOW');
    await pickScope(card(page), /Allow in this chat/);
    await expect(bar.locator('.elsewhere-title')).toHaveText('Using Notes · Esc to stop');
    // the click is done; the turn goes on
    await expect(transcript(page).getByText(/\[cu: Done: click in Notes\./)).toBeVisible();

    helper.pause('takeover');
    await expect(bar).toContainText('You took over Notes');
    await bar.getByRole('button', { name: 'Done, continue' }).click();
    await expect(bar).toContainText('Using Notes');
    expect(helper.log.filter((m) => m.method === 'control.resume')).toHaveLength(1);

    // a physical Esc: the helper reports it, the turn stops and the desktop is let go
    helper.pause('escape');
    await expect(bar).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
    await expect.poll(() => helper.log.filter((m) => m.method === 'control.release').length).toBe(1);
    expect(harness.claudeLog().some((e) => e.kind === 'in' && e.msg?.request?.subtype === 'interrupt')).toBe(true);
  });
});

test.describe('settings', () => {
  test.use({ harnesses: 'claude', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('Built-in tools → Computer use: permissions with the first-use guide, grants, deny list, engine', async ({ page, harness }) => {
    const helper = harness.helper!;
    helper.permissions.screenRecording = false;
    await expect(home(page)).toBeVisible();
    // a grant for this chat to list
    await send(page, 'CUCALL computer_key {"key":"a"}');
    await pickScope(card(page), /Allow in this chat/);
    await expect(transcript(page).getByText(/\[cu: Done: key in Notes\./)).toBeVisible();

    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await page.locator('.side-row', { hasText: 'Computer use' }).click();
    await expect(page.locator('.settings-title')).toHaveText('Computer use');
    const guide = page.locator('.cu-guide');
    await expect(guide.locator('.cu-guide-text')).toHaveText(
      'Allow Screen Recording for MoPilot in System Settings. Agents can only control apps you approve.',
    );
    // the idle helper quits first and main opens the pane
    await guide.getByRole('button', { name: 'Open System Settings' }).click();
    await expect.poll(() => openedExternal(harness)).toEqual([PRIVACY_PANES.screenRecording]);
    expect(helper.log.filter((m) => m.method === 'permissions.openSettings')).toEqual([]);
    const row = (title: string) =>
      page.locator('.settings-row').filter({ has: page.locator('.settings-row-title').getByText(title, { exact: true }) });
    await expect(row('Accessibility')).toContainText('Allowed');
    await expect(row('Screen Recording').getByRole('button', { name: 'Open System Settings for Screen Recording' })).toBeVisible();
    // the chat's grant, and the engine version from the helper
    await expect(page.locator('.settings-group', { hasText: 'Allowed in a chat' })).toContainText('Full control');
    await expect(row('MoPilot Computer Use')).toContainText('0.0.0-fake');
    // the built-in floor is read-only; the user can add to it
    await expect(row('Keychain Access')).toContainText('Built in');
    await page.getByRole('textbox', { name: 'Bundle ID to block' }).fill('com.example.bank');
    await page.getByRole('textbox', { name: 'Bundle ID to block' }).press('Enter');
    await expect(row('com.example.bank')).toContainText('Added by you');
    // removing the chat's grant
    await page.locator('.settings-group', { hasText: 'Allowed in a chat' }).getByRole('button', { name: 'Remove Notes' }).click();
    await expect(page.locator('.settings-group', { hasText: 'Allowed in a chat' })).toContainText('No apps yet');
  });
});

test.describe('remote switch off', () => {
  // the server switched computer use off: a fresh flags cache for this version and channel
  test.use({
    harnesses: 'claude',
    computerHelper: true,
    seed: { files: remoteFlags({ ...COMPUTER_TOOLS, 'shared.computerUse.enabled': false }) },
  });

  test('no computer tools, no card, no settings page', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    expect(await page.evaluate(() => (window as any).native.flags.isEnabled('shared.computerUse.enabled'))).toBe(false);
    await send(page, 'CUCALL computer_click {"x":1,"y":2}');
    // computer_click isn't one of the session's tools, so it isn't let through: the CLI's own permission
    // request shows as an ordinary tool card, never the computer-use card
    await expect(card(page)).toHaveCount(0);
    await page.getByRole('button', { name: /^Deny/ }).click();
    await expect(transcript(page).getByText(/fake-claude: CUCALL computer_click .*\[cu: deny\]/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(harness.claudeLog().some((e: any) => e.kind === 'cu' && /Done/.test(e.text ?? ''))).toBe(false);
    expect(harness.helper!.log).toEqual([]);
    await page.locator('.sidebar-title').first().click();
    await settingsEntry(page).click();
    await expect(page.locator('.side-row', { hasText: 'Browser' })).toBeVisible();
    await expect(page.locator('.side-row', { hasText: 'Computer use' })).toHaveCount(0);
  });
});

test.describe('unattended', () => {
  test.use({
    harnesses: 'codex',
    computerHelper: true,
    seed: { files: remoteFlags(COMPUTER_TOOLS), uiState: { prefs: { notifyOnComplete: 'always' } } },
  });

  test("a goal's own round can't ask: refused and paused; the visible chat offers recovery with one notification", async ({
    page,
    harness,
  }) => {
    await harness.app.evaluate(({ Notification }) => {
      (globalThis as any).__shown = [];
      Notification.prototype.show = function (this: any) {
        (globalThis as any).__shown.push(this.title);
      };
    });
    await expect(home(page)).toBeVisible();
    // the first round is the user's; the second starts by itself and tries to click
    await send(page, '/goal CONTINUE CUCALL computer_click {"x":1,"y":2}');
    await expect(
      transcript(page).getByText(
        /\[cu: error: Controlling Notes needs the user's OK, and nobody is here to give it \(a turn MoPilot started\)/,
      ),
    ).toBeVisible();
    // The chat is on screen as it pauses, so the refused request comes up as its card once the stopped turn ends;
    // the card takes the composer's place until it is answered.
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await card(page).getByRole('button', { name: /Deny/ }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(goalPill(page)).toContainText('Paused');
    const log = harness.codexLog();
    expect(log.some((e) => e.method === 'thread/goal/set' && e.params.status === 'paused')).toBe(true);
    expect(harness.helper!.log.filter((m) => m.method.startsWith('input.') && m.method !== 'input.idle')).toEqual([]);
    await expect
      .poll(() => harness.app.evaluate(() => (globalThis as any).__shown as string[]))
      .toContainEqual(expect.stringMatching(/needs your OK to control Notes\. Goal paused\./));
    expect((await harness.app.evaluate(() => (globalThis as any).__shown as string[])).filter((t) => /needs your OK/.test(t))).toHaveLength(
      1,
    );
  });
});

test.describe('Claude sub-agent', () => {
  test.use({
    harnesses: 'claude',
    computerHelper: true,
    seed: { files: remoteFlags(COMPUTER_TOOLS), uiState: { prefs: { notifyOnComplete: 'always' } } },
  });

  test("a sub-agent's call is refused; the visible chat offers recovery with one notification", async ({ page, harness }) => {
    await harness.app.evaluate(({ Notification }) => {
      (globalThis as any).__shown = [];
      Notification.prototype.show = function (this: any) {
        (globalThis as any).__shown.push(this.title);
      };
    });
    await expect(home(page)).toBeVisible();
    await send(page, 'SUBCUCALL computer_click {"x":10,"y":20}');
    await expect(
      transcript(page).getByText(/\[cu: error: Controlling Notes needs the user's OK, and nobody is here to give it \(a sub-agent\)/),
    ).toBeVisible();
    // the chat is on screen, so the refused request comes up as its card once the stopped turn ends
    await expect(card(page)).toContainText('Allow Claude Code to control Notes');
    await card(page).getByRole('button', { name: /Deny/ }).click();
    await expect(card(page)).toHaveCount(0);
    expect(harness.helper!.log.filter((m) => m.method === 'input.click')).toEqual([]);
    await expect
      .poll(() => harness.app.evaluate(() => (globalThis as any).__shown as string[]))
      .toContainEqual(expect.stringMatching(/needs your OK to control Notes/));
    expect((await harness.app.evaluate(() => (globalThis as any).__shown as string[])).filter((t) => /needs your OK/.test(t))).toHaveLength(
      1,
    );
  });
});

test.describe('Codex', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('the same card; a text-only model gets the element list instead of a screenshot', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_click {"x":10,"y":20}');
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await page.keyboard.press('1');
    await expect(
      transcript(page).getByText(/\[cu: Done: click in Notes\. Notes: 1 elements [\s\S]*\[0\.0\] Button "New Note" at \(20, 20\)/),
    ).toBeVisible();
    const helper = harness.helper!;
    expect(helper.log.filter((m) => m.method === 'input.click')).toHaveLength(1);
    expect(helper.log.some((m) => m.method === 'screenshot')).toBe(false);
  });
});

test.describe('Codex in the read-only tier', () => {
  test.use({
    harnesses: 'codex',
    computerHelper: true,
    seed: { files: remoteFlags(COMPUTER_TOOLS), uiState: { prefs: { permission: 'read-only' } } },
  });

  test('a click is refused with no card and never reaches the helper; looking still works', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_click {"x":10,"y":20}');
    await expect(transcript(page).getByText(/\[cu: error: This chat is in a read-only mode: computer use can only look\]/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(harness.helper!.log.filter((m) => m.method === 'input.click')).toEqual([]);
  });
});

test.describe('text-only model, no vision backend', () => {
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags(COMPUTER_TOOLS) } });

  test('the element list carries the text read on this Mac; locate and describe are unavailable', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_elements {}');
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await page.keyboard.press('1');
    await expect(
      transcript(page).getByText(
        /\[cu: Notes: 1 elements [\s\S]*Text read from the screen \(OCR\):[\s\S]*\[ocr-0\] Text "Hello world" at \(80, 67\)/,
      ),
    ).toBeVisible();
    const helper = harness.helper!;
    expect(helper.log.some((m) => m.method === 'ocr.elements')).toBe(true);
    expect(helper.log.some((m) => m.method === 'screenshot')).toBe(false);
    await send(page, 'CUCALL computer_locate {"query":"the note"}');
    await expect(transcript(page).getByText(/\[cu: error: No vision model can read the screen in this chat/)).toBeVisible();
    expect(helper.log.some((m) => m.method === 'screenshot')).toBe(false);
  });

  test('a helper without ocr.elements still answers with the accessibility elements', async ({ page, harness }) => {
    harness.helper!.ocr = false;
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_elements {}');
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await page.keyboard.press('1');
    await expect(transcript(page).getByText(/\[cu: Notes: 1 elements /)).toBeVisible();
    await expect(transcript(page).getByText(/Text read from the screen/)).toHaveCount(0);
  });
});

test.describe('text-only model, cross-vendor vision backend', () => {
  test.use({
    harnesses: 'codex',
    computerHelper: true,
    seed: { files: remoteFlags(COMPUTER_TOOLS) },
    env: { SAGE_VISION_FAKE: JSON.stringify({ source: 'mopilot', vendor: 'MoPilot', model: 'fake-vision', crossVendor: true }) },
  });

  test('the first locate asks on the consent card; the screenshot goes only to the vision model', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_locate {"query":"the new note button"}');
    // access to Notes first, then where the screenshot goes
    await expect(card(page)).toContainText('Allow Codex to control Notes');
    await page.keyboard.press('2');
    await expect(card(page)).toContainText('fake-vision will read screenshots of Notes for Codex. Screenshots go to MoPilot.');
    await page.keyboard.press('2');
    await expect(transcript(page).getByText(/\[cu: Found at \(0, 0\) in pixels of the latest 1×1 screenshot\.\]/)).toBeVisible();
    // the main model never got an image
    expect(harness.helper!.log.filter((m) => m.method === 'screenshot')).toHaveLength(1);
    // the answer for the chat is kept: describe asks nothing more
    await send(page, 'CUCALL computer_describe {}');
    await expect(transcript(page).getByText(/\[cu: A fake screen\]/)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });
});

test.describe('default switches', () => {
  // only Codex's own computer use is off, so a Codex Computer Use install on this Mac can't hide MoPilot's tools
  test.use({ harnesses: 'codex', computerHelper: true, seed: { files: remoteFlags({ 'native.codex.enabled': false }) } });

  test('the desktop_* tools replace computer_*: a computer_* call is refused with the replacement named, no card, no input', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'CUCALL computer_click {"x":10,"y":20}');
    await expect(
      transcript(page).getByText(/\[cu: error: computer_click is unavailable: use the desktop_\* tools to control the computer\.\]/),
    ).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    expect(harness.helper!.log.filter((m) => m.method.startsWith('input.'))).toEqual([]);
  });
});
