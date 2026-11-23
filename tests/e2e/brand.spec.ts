// The app names itself MoPilot in its menu and when it connects to Codex (#82).
import { test, expect } from './fixtures/app';

test('brand: the Quit item and the app-server clientInfo use the app name and version', async ({ harness, page }) => {
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const { quit, version } = await harness.app.evaluate(({ app, Menu }) => {
    const first = Menu.getApplicationMenu()!.items[0].submenu!.items;
    return { quit: first.find((i) => i.role === 'quit')?.label, version: app.getVersion() };
  });
  // Windows' File menu says Exit, as Windows apps do (electron/app/menu.cjs)
  expect(quit).toBe(process.platform === 'win32' ? 'Exit' : 'Quit MoPilot');
  const init = harness.codexLog().find((e) => e.method === 'initialize');
  expect(init?.params?.clientInfo).toEqual({ name: 'sage_codex_desktop', title: 'MoPilot', version });
});
