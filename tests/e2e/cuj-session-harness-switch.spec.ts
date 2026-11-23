// A parent session moves a linked session to another harness in the actual app: set_session_harness records the switch,
// the settings it would lose are refused meanwhile, and the child's next message settles it with the conversation carried
// across, on the model and effort asked for. The fixture scripts the tool calls; it does not simulate a model choosing them.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Harness } from './fixtures/app';
import { claudeAllUserTexts } from './fixtures/claudeChat';
import { openHarnessList } from './fixtures/harnessPicker';
import type { Page } from '@playwright/test';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const call = (tool: string, args: object) => `CUCALL ${tool} ${JSON.stringify(args)}`;
const results = (h: Harness, name: string): string[] =>
  (h.claudeLog() as any[]).filter((entry) => entry.kind === 'cu' && entry.tool === name).map((entry) => entry.text);
const childIds = (h: Harness) => {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'orchestration.json'), 'utf8')).children ?? {});
  } catch {
    return [];
  }
};

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
}

test.use({ harnesses: 'both' });

test('a parent moves its Codex child to Claude Code, and the child’s next message lands there with the conversation', async ({
  page,
  harness,
}) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();

  await send(
    page,
    `Start a session on Codex CUSTEPS\n${call('start_session', {
      initiation: 'user_asked',
      context: 'fresh',
      use_worktree: false,
      harness: 'codex',
      title: 'Harness mover',
      prompt: 'Remember the marker PLUM-42',
      background: 'An independent linked task that runs on Codex first; its parent later moves it to another harness.',
      paths: ['mover.md'],
    })}`,
  );
  await expect.poll(() => childIds(harness).length).toBe(1);
  const child = childIds(harness)[0];
  await expect
    .poll(
      () =>
        harness
          .codexLog()
          .filter((e: any) => e.method === 'turn/start' && e.params?.threadId === child && JSON.stringify(e.params).includes('PLUM-42'))
          .length,
    )
    .toBe(1);

  // back on this chat's harness needs no named harness; the low effort is cheap
  await send(page, `Bring it back CUSTEPS\n${call('set_session_harness', { session_id: child, harness: 'claude', effort: 'low' })}`);
  await expect.poll(() => results(harness, 'set_session_harness').length).toBe(1);
  expect(results(harness, 'set_session_harness')[0]).toContain('moves to claude');
  expect(results(harness, 'set_session_harness')[0]).toContain('at low effort');

  // recorded, not yet settled: nothing started on Claude for the child, and a setting for the harness it is leaving is refused
  await send(page, `Check it CUSTEPS\n${call('get_session', { session_id: child })}`);
  await expect.poll(() => results(harness, 'get_session').length).toBe(1);
  const waiting = JSON.parse(results(harness, 'get_session')[0]);
  expect(waiting.harness).toBe('codex');
  expect(waiting.pendingSwitch).toMatchObject({ harness: 'claude', effort: 'low' });
  await send(page, `Try the model CUSTEPS\n${call('set_session_model', { session_id: child, model: 'gpt-costly' })}`);
  await expect.poll(() => results(harness, 'set_session_model').length).toBe(1);
  expect(results(harness, 'set_session_model')[0]).toContain('set_session_harness');

  await send(page, `Continue it CUSTEPS\n${call('send_message', { to: child, message: 'What was the marker? PEAR-7' })}`);
  await expect.poll(() => claudeAllUserTexts(harness).filter((t) => t.includes('PEAR-7')).length).toBeGreaterThan(0);
  // the handoff carried the Codex segment's words to the new harness
  expect(claudeAllUserTexts(harness).some((t) => t.includes('PEAR-7') && t.includes('PLUM-42'))).toBe(true);

  await send(page, `Check it again CUSTEPS\n${call('get_session', { session_id: child })}`);
  await expect.poll(() => results(harness, 'get_session').length).toBe(2);
  const moved = JSON.parse(results(harness, 'get_session')[1]);
  expect(moved.harness).toBe('claude');
  expect(moved.effort).toBe('low');
  expect(moved.pendingSwitch).toBeUndefined();
});
