// #2144: the account relay's address reaches Codex with each thread request, never on its command line, and the relay
// takes model traffic only from the app-server (or a process it started): the app-server's request goes through,
// another local process (this test) is refused with 403.
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the relay knows the app-server by /usr/sbin/lsof and ps as macOS has them');

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });

test.describe('the account relay', () => {
  // the relay on (the fixture turns it off), with its upstream on a closed port so nothing leaves the machine
  test.use({ env: { SAGE_NO_RELAY: '', SAGE_RELAY_UPSTREAM: 'http://127.0.0.1:9' } });

  test('its address goes with thread/start, not argv; only the app-server gets through', async ({ page, harness }) => {
    await composer(page).fill('RELAYPROBE once');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const reply = page.getByRole('main').getByText(/^fake-codex: RELAYPROBE once \[relay (\d+|none|unreachable)\]$/);
    await expect(reply).toBeVisible();
    const status = /\[relay (\w+)\]/.exec((await reply.textContent()) ?? '')?.[1];
    // through the relay to its (closed) upstream: an upstream failure, never the relay's own refusal
    expect(status).toMatch(/^\d+$/);
    expect(status).not.toBe('403');

    const start = harness.codexLog().find((l) => l.method === 'thread/start');
    const base: string = start?.params?.config?.openai_base_url;
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{36}$/);
    const secret = base.split('/').at(-1) as string;
    // no process on this machine shows it on its command line
    expect(execFileSync('ps', ['-A', '-ww', '-o', 'args='], { encoding: 'utf8' })).not.toContain(secret);
    // a process that is not the app-server, holding the full address, is refused
    const foreign = await fetch(`${base}/responses`, { method: 'POST', headers: { 'chatgpt-account-id': 'a' }, body: '{}' });
    expect(foreign.status).toBe(403);
    // a process the app-server starts (a model's command, an MCP server) is refused too: only the app-server is served
    await composer(page).fill('RELAYCHILDPROBE now');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('main').getByText('fake-codex: RELAYCHILDPROBE now [relay child 403]', { exact: true })).toBeVisible();
  });
});
