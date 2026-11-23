// A basic-tier harness over ACP (electron/harness/acp.cjs), run in the real app against
// tests/fixtures/fake-acp-agent.mjs installed as Kimi Code: a new chat, streaming, MoPilot's
// tools through sage-mcp, an approval, Stop, and a restart that resumes the session.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

test.describe('basic harness over ACP', () => {
  test.use({ harnesses: 'codex', acp: { kimi: { resume: true } } });

  test('new chat, stream, tools, approval, Stop, then restart and resume', async ({ harness }) => {
    let page = harness.page;
    await expect(home(page)).toBeVisible();

    // pick Kimi Code for the new chat in the harness list
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');

    // send and stream
    await send(page, 'hello acp');
    await expect(transcript(page).getByText('fake-acp: hello acp', { exact: true })).toBeVisible();
    await expect(stop(page)).toHaveCount(0);
    // the chat's own session, not the admission probe's
    const log = () => harness.acpLog('kimi').filter((l) => !JSON.stringify(l).includes('mopilot-acp-probe-'));
    const created = log().find((l) => l.kind === 'in' && l.msg.method === 'session/new');
    // session/new carried this session's own sage_<nonce> server, and it said hello in time
    const server = created.msg.params.mcpServers[0].name;
    expect(server).toMatch(/^sage_[0-9a-f]{12}$/);
    expect(log().find((l) => l.kind === 'mcp')?.ok).toBe(true);

    // MoPilot's tools are reachable from the harness
    const word = `w${Date.now().toString(36)}`;
    await send(page, `MCPCALL ${word}`);
    await expect(transcript(page).getByText(`[mcp ${server}: echo: ${word}]`)).toBeVisible();

    // an approval, rendered from the harness's own options
    await send(page, 'PERMIT this');
    const card = page.locator('.approval-card');
    await expect(card).toContainText('Kimi Code wants to: Fake action');
    await page.keyboard.press('1'); // the first option, by key
    await expect(transcript(page).getByText('fake-acp: PERMIT this', { exact: true })).toBeVisible();
    const answer = log().find((l) => l.kind === 'in' && !l.msg.method && l.msg.result?.outcome);
    expect(answer.msg.result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });

    // Stop sends session/cancel and the turn ends as stopped
    await send(page, 'SLOW work');
    await expect(transcript(page).getByText('fake-acp: SLOW work', { exact: true })).toBeVisible();
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0);
    expect(log().some((l) => l.kind === 'in' && l.msg.method === 'session/cancel')).toBe(true);

    // restart: the chat is in the sidebar with its history, and the same session continues
    await harness.relaunch();
    page = harness.page;
    await expect(home(page)).toBeVisible();
    // its agent titled it (the fake answers a title request with a fixed title, #2150)
    await page.getByRole('complementary').locator('[data-sidebar-chat^="acp:kimi:"]', { hasText: 'Fake chat title' }).first().click();
    await expect(transcript(page).getByText('fake-acp: hello acp', { exact: true })).toBeVisible();
    await expect(transcript(page).getByText(`[mcp ${server}: echo: ${word}]`)).toBeVisible();
    await send(page, 'HISTORY please');
    // three earlier prompts finished in this session (the stopped one doesn't count)
    await expect(transcript(page).getByText('fake-acp: HISTORY please [history: 3]', { exact: true })).toBeVisible();
    const resumed = log().filter((l) => l.kind === 'in' && l.msg.method === 'session/resume');
    expect(resumed).toHaveLength(1);
    expect(resumed[0].msg.params.sessionId).toBe(log().find((l) => l.kind === 'session').sessionId);
  });
});

test.describe('only a basic harness is installed (D-42)', () => {
  test.use({ harnesses: 'none', acp: { kimi: {} } });

  test('the app opens on the main UI, not Welcome, and a new chat runs on the basic harness', async ({ harness }) => {
    const page = harness.page;
    await expect(home(page)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect your coding agents' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Select model' })).toContainText('Kimi Code');
    await send(page, 'hello basic');
    await expect(transcript(page).getByText('fake-acp: hello basic', { exact: true })).toBeVisible();
  });
});
