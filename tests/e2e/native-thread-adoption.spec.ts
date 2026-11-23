// Native routing survives a child reply and still navigates the app's browser, over fake vendor RPC in a scratch profile.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from './fixtures/app';
import { pickScope } from './fixtures/approvalScope';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let port = 0;
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Adoption smoke</title><h1>Parent routing still works</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

test.use({
  harnesses: 'codex',
  env: { SAGE_DEBUG_PORT: '18791' },
  seed: {
    files: ({ home, codexHome }) => {
      // Availability is seeded; no real Chrome connection or vendor computer-control operation is used.
      const runtime = path.join(codexHome, 'plugins/cache/openai-bundled/unified-computer-use/26.1007.1');
      fs.mkdirSync(path.join(runtime, '.codex-plugin'), { recursive: true });
      fs.writeFileSync(path.join(runtime, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: { command: process.execPath } } }));
      const chrome = path.join(home, 'Library/Application Support/Google/Chrome');
      fs.mkdirSync(path.join(chrome, 'NativeMessagingHosts'), { recursive: true });
      const id = 'a'.repeat(32);
      fs.mkdirSync(path.join(chrome, 'Default/Extensions', id), { recursive: true });
      // registered and on in the profile, as Chrome records an installed extension
      fs.writeFileSync(
        path.join(chrome, 'Default/Secure Preferences'),
        JSON.stringify({ extensions: { settings: { [id]: { state: 1 } } } }),
      );
      fs.writeFileSync(
        path.join(chrome, 'NativeMessagingHosts/com.openai.codexextension.json'),
        JSON.stringify({ path: process.execPath, allowed_origins: [`chrome-extension://${id}/`] }),
      );
    },
  },
});

test('a child message to its native parent does not break the next browser task', async ({ page, harness }) => {
  const started = Date.now();
  const cdp = await fetch('http://127.0.0.1:18791/json/version').then((r) => r.json());
  expect(cdp.webSocketDebuggerUrl).toContain(':18791/');
  await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('SPAWN_REPLY_PARENT');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('fake-codex: SPAWN_REPLY_PARENT');
  const config = harness.codexLog().find((e) => e.method === 'thread/start' && e.params.ephemeral !== true && e.params.config?.plugins)
    ?.params.config;
  expect(Object.values(config?.plugins ?? {}).some((plugin: any) => plugin.enabled === true)).toBe(true);
  const url = `http://127.0.0.1:${port}/`;
  await composer.fill(`CUCALL browser_navigate ${JSON.stringify({ url })}\nCUCALL browser_get_page_text {}`);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const approval = page.locator('.sage-approval');
  await expect(approval).toContainText(`127.0.0.1:${port}`);
  await pickScope(approval, /Allow once/);
  await expect(page.getByRole('main')).toContainText('Parent routing still works');
  await harness.app.evaluate(({ app }) => app.exit(0));
  console.log(`native-adoption smoke ${Date.now() - started}ms; scratch ${harness.dir}; CDP 18791`);
});
