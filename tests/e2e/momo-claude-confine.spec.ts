// MoMo's Claude Code session is confined (#2305, #2318), on the fake Claude CLI: it starts with no built-in tools (`--tools ""`),
// only the MCP servers MoPilot passes (`--strict-mcp-config`) and the claude.ai connectors off, while a coding chat's session
// keeps its normal options. The fake CLI logs the argv and the connector switch it was started with.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply, openMomoChat } from './fixtures/momo';

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });

const CONNECTORS_OFF = 'ENABLE_CLAUDEAI_MCP_SERVERS=false';

test('MoMo’s Claude session has no built-in tools, a strict MCP config and the connectors off; a coding chat’s keeps its options', async ({
  page,
  harness,
}: {
  page: Page;
  harness: any;
}) => {
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  const reply = (text: string) => page.getByText(new RegExp(`fake-claude: .*${text}`));

  // a coding chat first
  await expect(composer).toBeVisible();
  await composer.fill('a coding chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(reply('a coding chat')).toBeVisible({ timeout: 20_000 });

  // then MoMo's main chat
  const { chat, send } = await openMomoChat(page);
  await send('hello MoMo');
  await expect(chat.getByText(momoReply('fake-claude', 'hello MoMo'))).toBeVisible({ timeout: 20_000 });

  const starts = (harness.claudeLog() as any[]).filter(
    (e) => e.kind === 'argv' && e.argv.some((a: string) => /^--(session-id|resume)=/.test(a)),
  );
  const momo = starts.filter((e) => /[\\/]momo(?:[\\/]|$)/.test(e.cwd));
  const coding = starts.filter((e) => !/[\\/]momo(?:[\\/]|$)/.test(e.cwd));
  const seen = JSON.stringify(starts.map((e) => ({ pid: e.pid, cwd: e.cwd, argv: e.argv, env: e.cloudEnv })));
  expect(momo.length, seen).toBeGreaterThan(0);
  expect(coding.length).toBeGreaterThan(0);
  for (const e of momo) {
    // no built-in tools: `--tools` with an empty list
    expect(e.argv, seen).toContain('--tools=');
    expect(e.argv).toContain('--strict-mcp-config');
    expect(e.cloudEnv).toContain(CONNECTORS_OFF);
  }
  for (const e of coding) {
    expect(e.argv).not.toContain('--strict-mcp-config');
    expect(e.argv).not.toContain('--tools=');
    expect(e.cloudEnv).not.toContain(CONNECTORS_OFF);
  }
});
