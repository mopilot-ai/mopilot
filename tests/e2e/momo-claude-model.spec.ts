// MoMo's Claude Code turns run on the brain's model (#2304), on the fake Claude CLI: pick a model on MoMo's brain chip, reload the
// window, and the next turn runs on that model, with no set_model reset and no `/model` text sent to the CLI.
import { test, expect } from './fixtures/app';
import { momoChat, momoChatSession, momoReply, openMomo } from './fixtures/momo';

test.use({ harnesses: 'claude', env: { MOPILOT_MOMO_DEV: '1' } });

async function say(page: Parameters<typeof openMomo>[0], text: string) {
  const chat = momoChat(page);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(chat.getByText(momoReply('fake-claude', text))).toBeVisible({ timeout: 20_000 });
  await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 20_000 });
}

test('a model picked for MoMo survives a window reload: the next turn runs on it, with no model reset', async ({ page, harness }) => {
  await openMomo(page);
  const { chat } = await momoChatSession(page);
  // the Muse-style composer has no model picker: MoMo's brain chip (harness · model) changes the model MoMo's chat runs on
  const chip = chat.getByRole('button', { name: "MoMo's brain" });
  await chip.click();
  await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
  await page.locator('.hp-models .menu-item', { hasText: 'Fake Haiku' }).click();
  await expect(chip).toContainText('Fake Haiku');
  await say(page, 'before the reload');

  await page.reload();
  await openMomo(page);
  await momoChatSession(page);
  await expect(momoChat(page).getByRole('button', { name: "MoMo's brain" })).toContainText('Fake Haiku');
  await say(page, 'after the reload');

  const log = harness.claudeLog() as any[];
  const turn = (text: string) => log.filter((e) => e.kind === 'turn' && e.text.includes(text));
  expect(turn('before the reload').map((e) => e.model)).toEqual(['claude-fake-haiku']);
  expect(turn('after the reload').map((e) => e.model)).toEqual(['claude-fake-haiku']);
  // nothing put the live CLI back on its default model, and no `/model` text reached it
  const ins = log.filter((e) => e.kind === 'in').map((e) => e.msg);
  const setModels = ins.filter((m) => m.type === 'control_request' && m.request?.subtype === 'set_model').map((m) => m.request.model);
  expect(setModels.filter((m) => m !== 'haiku' && m !== 'claude-fake-haiku')).toEqual([]);
  const texts = ins.filter((m) => m.type === 'user').map((m) => JSON.stringify(m.message?.content));
  expect(texts.filter((t) => t.includes('/model'))).toEqual([]);
});
