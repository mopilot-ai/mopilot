// Server requests from the Codex app-server are answered once, by main, however many windows are open.
import { test, expect } from './fixtures/app';

test('an item/tool/call for a Sage tool is answered once, with three windows open', async ({ page, harness }) => {
  const home = (p: typeof page) => p.getByRole('heading', { name: 'What should we build?' });
  await expect(home(page)).toBeVisible();
  // two more windows, each subscribed to the same app-server messages
  for (let i = 0; i < 2; i++) await page.evaluate(() => (window as any).native.win.open());
  await expect.poll(() => harness.app.windows().length).toBe(3);
  for (const w of harness.app.windows()) await expect(home(w)).toBeVisible();

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('TOOLCALL pineapple');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main').getByText('fake-codex: TOOLCALL pineapple [echo: pineapple]', { exact: true })).toBeVisible();

  const asked = harness.codexLog().filter((e) => e.method === null);
  const toolAnswers = asked.filter((e) => e.response?.result?.contentItems);
  expect(toolAnswers).toHaveLength(1);
  expect(toolAnswers[0].response!.result).toEqual({ contentItems: [{ type: 'inputText', text: 'echo: pineapple' }], success: true });
  // the attestation/generate request the fake sent alongside got exactly one -32601
  const refused = asked.filter((e) => e.response?.error);
  expect(refused.map((e) => e.response!.error!.code)).toEqual([-32601]);
  expect(asked).toHaveLength(2);
});
