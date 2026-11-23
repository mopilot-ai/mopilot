// Selects a packaged journey's draft harness and its own model through the real composer picker.
async function openHarnesses(page) {
  const trigger = page.getByRole('button', { name: 'Select model' });
  const basic = (await trigger.getAttribute('class'))?.split(/\s+/).includes('acp-model-trigger');
  await trigger.click();
  if (!basic) await page.getByRole('button', { name: 'Select harness and model' }).click();
  return basic;
}

/** @param {string | null} [model] */
export async function pickHarness(page, label, model = null) {
  const basic = await openHarnesses(page);
  const row = page.locator('.hp-harnesses .hp-row', { hasText: label });
  await row.click();
  if (model) {
    const models = page.getByRole('menu', { name: label, exact: true });
    // An ACP draft first switches to the native harness and closes its picker.
    if (basic) {
      await page.locator('.acp-model-trigger').waitFor({ state: 'detached' });
      await openHarnesses(page);
      await row.click();
    }
    await models.getByRole('menuitemradio', { name: model, exact: true }).click();
  }
  await page.keyboard.press('Escape');
}
