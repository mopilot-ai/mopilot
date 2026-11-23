// CUJ acp-harness-daily-loop: an admitted basic harness (tests/fixtures/fake-acp-agent.mjs as Kimi Code) through one
// day. It wants a sign-in before admission; once signed in from Settings it is picked up from a Claude Code chat with
// an in-place handoff, then the chat answers an approval, runs one of the harness's commands and a MoPilot tool
// through sage-mcp, and after a restart the same session resumes. The details of each step are in acp.spec.ts,
// acp-admission.spec.ts, acp-switch.spec.ts and acp-commands.spec.ts; this walks them as one journey.
import type { Page } from '@playwright/test';
import type { ChatConfig } from '../../src/lib/chatMeta';
import { test, expect } from './fixtures/app';
import { openSettingsSection, settingsEntry } from './fixtures/settings';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const kimiState = (page: Page) => page.locator('.basic-row[data-harness="kimi"] .basic-row-state');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.use({
  harnesses: 'claude',
  acp: {
    kimi: { needsAuth: true, terminalLogin: true, resume: true, commands: [{ name: 'goal', description: 'Set a goal and keep going' }] },
  },
});

let mainErrors = '';
test.beforeEach(async ({ harness }) => {
  mainErrors = '';
  harness.app.process().stderr?.on('data', (chunk) => (mainErrors += String(chunk)));
  await harness.page.evaluate(() => {
    const probe = window as unknown as { acpProbe: unknown[] };
    probe.acpProbe = [];
    window.native.acp.onEvent((event) => probe.acpProbe.push(event));
  });
});

test.afterEach(async ({ harness }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('acp-switch-protocol', {
    body: JSON.stringify({ protocol: harness.acpLog('kimi'), mainErrors }, null, 2),
    contentType: 'application/json',
  });
  const state = await harness.page.evaluate(async () => {
    const chats = await window.native.chats.snapshot();
    const sessions = await Promise.all(Object.keys(chats.chats).map(async (id) => [id, await window.native.session.snapshot(id)]));
    const histories = await Promise.all(
      Object.entries(chats.chats).flatMap(([id, chat]) =>
        (chat.segments ?? [])
          .filter((seg) => seg.harness.startsWith('acp:'))
          .map(async (seg) => [seg.nativeId, await window.native.acp.turns(seg.nativeId, id, '')]),
      ),
    );
    return { chats, sessions, histories, events: (window as unknown as { acpProbe?: unknown[] }).acpProbe ?? [] };
  });
  await testInfo.attach('acp-switch-state', {
    body: JSON.stringify(state, null, 2),
    contentType: 'application/json',
  });
});

test('sign in, switch from Claude Code, approve, a command, a MoPilot tool, then restart and resume', async ({ harness }) => {
  let page = harness.page;
  await expect(home(page)).toBeVisible();

  // admission: Kimi wants a sign-in first, which runs in the embedded terminal and admits it
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await openSettingsSection(page, 'other-harnesses');
  await expect(page.locator('[data-harness-status="kimi"]')).toHaveText('Sign in to Kimi Code first', { timeout: 20_000 });
  await page.getByRole('button', { name: 'Log in in terminal' }).click();
  await expect(kimiState(page)).toHaveText('Ready', { timeout: 20_000 });
  await page.locator('.side-row', { hasText: 'Back to app' }).click();

  // A Claude Code chat continues on Kimi without changing its sidebar identity.
  await expect(home(page)).toBeVisible();
  await send(page, 'plan the migration');
  await expect(transcript(page).getByText('fake-claude: plan the migration', { exact: true })).toBeVisible();
  const chat = (await page.locator('[data-sidebar-chat][aria-current="page"]').getAttribute('data-sidebar-chat'))!;
  // An explicit first-tier selection must not masquerade as an inherited child cap on the mode-less destination.
  await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
  await page.locator('.perm-menu .perm-item.default').click();
  await expect
    .poll(() =>
      page.evaluate(async (id) => ((await window.native.chats.snapshot()).chats[id].meta.config as ChatConfig | null)?.permission, chat),
    )
    .toBe('default');
  await openHarnessList(page);
  // nothing at risk: the pick switches at once
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
  await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');
  await send(page, 'now continue');
  await expect(transcript(page).getByText('fake-acp:', { exact: false }).first()).toBeVisible();
  // the chat's own prompts and session, not the admission probe's
  const log = () => harness.acpLog('kimi').filter((l) => !JSON.stringify(l).includes('mopilot-acp-probe-'));
  const prompts = () => log().filter((l) => l.kind === 'in' && l.msg.method === 'session/prompt');
  expect(JSON.stringify(prompts()[0].msg.params.prompt)).toContain('<sage-handoff from=\\"Claude Code\\" mode=\\"auto\\">');

  // an approval from the harness's own options
  await send(page, 'PERMIT this');
  await expect(page.locator('.approval-card')).toContainText('Kimi Code wants to: Fake action');
  await page.keyboard.press('1');
  await expect(transcript(page).getByText('fake-acp: PERMIT this', { exact: true })).toBeVisible();

  // one of its commands
  await send(page, '/goal ship it');
  await expect(transcript(page).getByText('ran /goal', { exact: true })).toBeVisible();

  // a MoPilot tool through this session's sage-mcp
  const server = log().find((l) => l.kind === 'in' && l.msg.method === 'session/new').msg.params.mcpServers[0].name;
  const word = `w${Date.now().toString(36)}`;
  await send(page, `MCPCALL ${word}`);
  await expect(transcript(page).getByText(`[mcp ${server}: echo: ${word}]`)).toBeVisible();

  // restart: the chat is there with its history, and the same session goes on
  await harness.relaunch();
  page = harness.page;
  await expect(home(page)).toBeVisible();
  // titled by its agent like the Claude Code chat (both "Fake chat title", #2150): the Kimi row is found by its id
  await page.getByRole('complementary').locator(`[data-sidebar-chat="${chat}"]`).click();
  await expect(transcript(page).getByText(`[mcp ${server}: echo: ${word}]`)).toBeVisible();
  await send(page, 'HISTORY please');
  await expect(transcript(page).getByText('fake-acp: HISTORY please [history: 4]', { exact: true })).toBeVisible();
  const resumed = log().filter((l) => l.kind === 'in' && l.msg.method === 'session/resume');
  expect(resumed.map((l) => l.msg.params.sessionId)).toEqual([log().find((l) => l.kind === 'session').sessionId]);
});
