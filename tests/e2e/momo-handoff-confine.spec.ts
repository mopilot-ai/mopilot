// The handoff note of a MoMo chat is written as confined as the chat (#2364, #2366), on the fake Claude CLI: a coding chat on Claude
// Code switches to Codex with the Summary mode, so Claude Code runs the note in a hidden fork with its normal options. MoMo's chat is
// moved through its brain chip (the shell has no switch sheet and no Summary mode): no hidden fork is run for it, and every Claude
// Code run in MoMo's folder has no built-in tools (`--tools=`), a strict MCP config and the connectors off. A note written for a
// MoMo chat is covered by tests/momoHelperConfinement.test.ts. The fake CLI logs the argv and the connector switch of every run.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { momoReply, momoSetupDone, openMomoChat } from './fixtures/momo';
import { codexCliLogin } from './fixtures/codexAccounts';
import { openHarnessList } from './fixtures/harnessPicker';

test.use({
  harnesses: 'both',
  env: { MOPILOT_MOMO_DEV: '1' },
  // This journey owns handoff confinement; first-run setup is covered by momo-entry.spec.ts.
  seed: { ...momoSetupDone, files: codexCliLogin },
});

const CONNECTORS_OFF = 'ENABLE_CLAUDEAI_MCP_SERVERS=false';

/** Switch the chat in `scope` to Codex with a Summary handoff, and send `text` on it. */
async function switchToCodexWithSummary(page: Page, scope: ReturnType<Page['locator']>, text: string, reply: RegExp) {
  await scope.getByRole('button', { name: 'Select model' }).click();
  await page.getByRole('button', { name: 'Select harness and model' }).click();
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Codex' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Model One' }).click();
  // the switch goes ahead on the pick; the chip's Options sets how the conversation carries over
  await scope.locator('.switch-chip').getByRole('button', { name: 'Options', exact: true }).click();
  const sheet = page.locator('.switch-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'More options' }).click();
  await sheet.locator('.ss-opt', { hasText: 'Summary' }).click();
  await page.getByRole('button', { name: 'Switch', exact: true }).click();
  await scope.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await scope.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(scope.getByText(reply)).toBeVisible({ timeout: 60_000 });
}

/** The confinement case chooses each brain explicitly instead of inheriting the coding chat's last harness. */
async function chooseMomoBrain(page: Page, chat: ReturnType<Page['locator']>, harness: string, model: string) {
  const chip = chat.getByRole('button', { name: "MoMo's brain" });
  await chip.click();
  await page.locator('.hp-harnesses .hp-row', { hasText: harness }).click();
  await page.locator('.hp-models .menu-item', { hasText: model }).click();
  await expect(chip).toContainText(harness);
  await expect(chip).toContainText(model);
}

test('the handoff note of a MoMo chat runs confined; a coding chat’s keeps its options', async ({ page, harness }) => {
  test.setTimeout(240_000);
  const body = page.getByRole('main');
  // a coding chat on Claude Code, switched to Codex with a summary
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('a coding chat');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(body.getByText(/fake-claude: .*a coding chat/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });
  await switchToCodexWithSummary(page, body, 'coding on codex', /fake-codex: <sage-handoff/);

  // then MoMo's main chat on Claude Code, moved to Codex through its brain chip: the Muse-style shell has no switch sheet, so
  // MoMo's switch hands its record over with no hidden fork (no summary note), and no Claude Code run is left unconfined
  const { chat, send } = await openMomoChat(page);
  await chooseMomoBrain(page, chat, 'Claude Code', 'Fake Sonnet');
  await send('hello MoMo');
  await expect(chat.getByText(momoReply('fake-claude', 'hello MoMo'))).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });
  await chooseMomoBrain(page, chat, 'Codex', 'Fake Model One');
  await send('MoMo on codex');
  await expect(chat.getByText(/fake-codex: <sage-handoff/)).toBeVisible({ timeout: 60_000 });

  // the note runs are the CLI starts that resume a session in a hidden fork
  const notes = (harness.claudeLog() as any[]).filter((e) => e.kind === 'argv' && e.argv.includes('--fork-session'));
  const seen = JSON.stringify(notes.map((e) => ({ cwd: e.cwd, argv: e.argv, env: e.cloudEnv })));
  const momo = notes.filter((e) => /[\\/]momo(?:[\\/]|$)/.test(e.cwd));
  const coding = notes.filter((e) => !/[\\/]momo(?:[\\/]|$)/.test(e.cwd));
  expect(coding.length, seen).toBe(1);
  expect(coding[0].argv, seen).not.toContain('--tools=');
  expect(coding[0].argv, seen).not.toContain('--strict-mcp-config');
  expect(coding[0].cloudEnv, seen).not.toContain(CONNECTORS_OFF);
  // MoMo's switch ran no note; every Claude Code session in MoMo's folder is confined, notes included
  expect(momo.length, seen).toBe(0);
  // (a CLI start with no session is a bare capabilities probe: it takes no turn and runs nothing)
  const momoRuns = (harness.claudeLog() as any[]).filter(
    (e) => e.kind === 'argv' && /[\\/]momo(?:[\\/]|$)/.test(e.cwd) && e.argv.some((a: string) => /^--(session-id|resume)=/.test(a)),
  );
  const runs = JSON.stringify(momoRuns.map((e) => ({ cwd: e.cwd, argv: e.argv, env: e.cloudEnv })));
  expect(momoRuns.length, runs).toBeGreaterThan(0);
  for (const e of momoRuns) {
    expect(e.argv, runs).toContain('--tools=');
    expect(e.argv, runs).toContain('--strict-mcp-config');
    expect(e.cloudEnv, runs).toContain(CONNECTORS_OFF);
  }
});
