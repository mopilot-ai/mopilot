// MoPilot's tools reach each harness through its own channel: Claude's in-process SDK server
// and Codex's per-thread sage-mcp. The fakes call sage_debug_echo through them, and the random
// word has to come back. The ACP channel is covered in tests/toolChannels.test.ts.
import fs from 'node:fs';
import { readJsonLineLog } from '../../scripts/fixture-json-log.mjs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(text);
  await expect(composer).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const word = () => `w${Math.random().toString(36).slice(2, 10)}`;

/** Calls of a tool in main's local operation log. */
function operations(h: Harness, tool: string) {
  return readJsonLineLog(path.join(h.dir, 'userData', 'capabilities', 'operations.jsonl')).filter((e) => e.tool === tool);
}

// a chat's thread/start: not the ephemeral ones Sage starts itself (the runtime probe at launch, the title helper)
const chatStart = (e: { method?: string | null; params?: any }) => e.method === 'thread/start' && !e.params?.ephemeral;

test.describe('Codex', () => {
  test('a Codex thread gets sage-mcp and calls sage_debug_echo once, with three windows open', async ({ page, harness }) => {
    await expect(home(page)).toBeVisible();
    for (let i = 0; i < 2; i++) await page.evaluate(() => (window as any).native.win.open());
    await expect.poll(() => harness.app.windows().length).toBe(3);

    const w = word();
    await send(page, `MCPCALL ${w}`);
    const reply = transcript(page).getByText(new RegExp(`^fake-codex: MCPCALL ${w} \\[mcp sage_[0-9a-f]{12}: echo: ${w}\\]$`));
    await expect(reply).toBeVisible();

    // thread/start carried the fragment: a random server name, tools approved, native cua_repl off
    const start = harness.codexLog().find((e) => chatStart(e) && e.params?.config?.mcp_servers)!;
    const names = Object.keys(start.params.config.mcp_servers);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^sage_[0-9a-f]{12}$/);
    const server = start.params.config.mcp_servers[names[0]];
    expect(server.default_tools_approval_mode).toBe('approve');
    expect(server.command).toMatch(/sage-mcp$/);
    expect(start.params.config.plugins['unified-computer-use@openai-bundled']).toEqual({ enabled: false });

    const mcp = harness.codexLog().filter((e: any) => e.kind === 'mcp') as any[];
    expect(mcp).toHaveLength(1);
    expect(mcp[0].server).toBe(names[0]);
    expect(mcp[0].serverInfo.name).toBe(names[0]);
    expect(mcp[0].text).toBe(`echo: ${w}`);
    // one call, run once in main, however many windows are open
    await expect.poll(() => operations(harness, 'sage_debug_echo').length).toBe(1);
    expect(operations(harness, 'sage_debug_echo')[0].outcome).toBe('ok');
  });
});

test.describe('Codex resume', () => {
  test('an old thread resumed after a restart gets sage-mcp again, with a new token, and reads the word back', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const w1 = word();
    await send(page, `MCPCALL ${w1}`);
    await expect(transcript(page).getByText(new RegExp(`echo: ${w1}\\]$`))).toBeVisible();
    const start = harness.codexLog().find((e) => chatStart(e) && e.params?.config?.mcp_servers)!;
    const threadId = harness.codexLog().find((e) => e.method === 'turn/start' && e.params.input?.[0]?.text === `MCPCALL ${w1}`)!
      .params.threadId;

    await harness.quit();
    await harness.relaunch();
    const p = harness.page;
    await p.getByRole('complementary').getByText('Fake chat title', { exact: true }).click();
    const w2 = word();
    await send(p, `MCPCALL ${w2}`);
    await expect(transcript(p).getByText(new RegExp(`echo: ${w2}\\]$`))).toBeVisible();

    const resume = harness
      .codexLog()
      .find((e) => e.method === 'thread/resume' && e.params.threadId === threadId && e.params?.config?.mcp_servers)!;
    const env = (params: any) => (Object.values(params.config.mcp_servers)[0] as any).env;
    // a new token for the resumed thread; native cua_repl stays off
    expect(env(resume.params).SAGE_MCP_TOKEN).not.toBe(env(start.params).SAGE_MCP_TOKEN);
    expect(resume.params.config.plugins['unified-computer-use@openai-bundled']).toEqual({ enabled: false });
    const mcp = harness.codexLog().filter((e: any) => e.kind === 'mcp') as any[];
    expect(mcp.map((m) => m.text)).toEqual([`echo: ${w1}`, `echo: ${w2}`]);
  });
});

test.describe('Codex crash', () => {
  test('after the app-server crashes its sage-mcp session is over: the resumed thread opens a new one under the same shared name and still reads the word back', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const w1 = word();
    await send(page, `MCPCALL ${w1}`);
    await expect(transcript(page).getByText(new RegExp(`echo: ${w1}\\]$`))).toBeVisible();
    const start = harness.codexLog().find((e) => chatStart(e) && e.params?.config?.mcp_servers)!;
    const first = Object.keys(start.params.config.mcp_servers)[0];

    // a turn that waits on an approval, then the app-server exits
    await send(page, 'please CRASH');
    await expect(page.getByText('working on it')).toBeVisible();
    fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.ask'), '');
    await expect(page.getByText('Allow Codex to run this command?')).toBeVisible();
    fs.writeFileSync(path.join(harness.dir, 'fake-codex.jsonl.crash'), '');
    const inits = () => harness.codexLog().filter((e) => e.method === 'initialize');
    await expect.poll(() => inits().length, { timeout: 15_000 }).toBe(2);

    const w2 = word();
    await send(page, `MCPCALL ${w2}`);
    await expect(transcript(page).getByText(new RegExp(`echo: ${w2}\\]$`))).toBeVisible();
    // the old session ended with the process: the thread's resume opened a new one, which presents the app run's one
    // shared server name (so the provider's prompt cache keeps matching, #2579)
    const resume = harness
      .codexLog()
      .filter((e) => e.method === 'thread/resume' && e.params?.config?.mcp_servers)
      .at(-1)!;
    const second = Object.keys(resume.params.config.mcp_servers)[0];
    expect(second).toMatch(/^sage_[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });
});

test.describe('Claude', () => {
  // This suite verifies the dedicated computer server as well as the browser and session servers.
  test.use({ harnesses: 'claude', computerHelper: true });

  test('a Claude session gets its own always-loaded SDK server; its tools need no card, a repo "sage" server does', async ({
    page,
    harness,
  }) => {
    await expect(home(page)).toBeVisible();
    const w = word();
    await send(page, `MCPCALL ${w}`);
    await expect(transcript(page).getByText(`fake-claude: MCPCALL ${w} [mcp: echo: ${w}]`, { exact: true })).toBeVisible();
    await expect(page.locator('.approval-card')).toHaveCount(0);

    const mcp = harness.claudeLog().filter((e: any) => e.kind === 'mcp') as any[];
    expect(mcp).toHaveLength(1);
    expect(mcp[0].server).toMatch(/^sage_[0-9a-f]{12}$/);
    expect(mcp[0].tools).toContain('sage_debug_echo');
    expect(mcp[0].alwaysLoad).toBe(true);
    // canUseTool was asked and let it through without a card
    expect(mcp[0].permission).toBe('allow');
    expect(mcp[0].text).toBe(`echo: ${w}`);
    // The SDK announced that server next to the in-app browser, computer and default Chrome servers.
    // This fixture ships the extension and has no native Chrome controller (#1483).
    const init = harness
      .claudeLog()
      .find((e) => e.kind === 'in' && e.msg.request?.subtype === 'initialize' && e.msg.request.sdkMcpServers?.length) as any;
    expect([...init.msg.request.sdkMcpServers].sort()).toEqual(
      [mcp[0].server, 'mopilot_browser', 'mopilot_computer', 'mopilot_chrome', 'mopilot_ios_simulator', 'mopilot_android_emulator'].sort(),
    );
    await expect.poll(() => operations(harness, 'sage_debug_echo').length).toBe(1);

    // a tool from an MCP server a repo calls "sage" is not MoPilot's: it gets the usual card
    await send(page, 'MCPREPO');
    const card = page.locator('.approval-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Allow Claude Code to use sage · sage_debug_echo?');
    await card.getByRole('button', { name: /Deny/ }).click();
    await expect(transcript(page).getByText('fake-claude: MCPREPO [repo sage: deny]', { exact: true })).toBeVisible();
  });
});
