// A real scratch-app browser task preserves valid text beside null and malformed text fields.
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
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Tool result smoke</title><h1>Tool result text survived</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
test.afterAll(() => server.close());

test.use({
  harnesses: 'codex',
  env: { SAGE_DEBUG_PORT: '18794' },
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

test('a malformed wrapper still returns browser page text to the agent', async ({ page, harness }) => {
  const started = Date.now();
  const registryPath = path.resolve(__dirname, '../../electron/capabilities/contract/registry.cjs');
  try {
    await harness.app.evaluate((_electron, modulePath) => {
      const { Registry, toContent } = process.getBuiltinModule('module').createRequire(modulePath)(modulePath);
      const invoke = Registry.prototype.invoke;
      Registry.prototype.invoke = function (...args) {
        const tool = this.tools.get(args[2]);
        if (args[2] !== 'browser_get_page_text' || !tool) return invoke.apply(this, args);
        const handler = tool.handler;
        tool.handler = async (...inputs) => {
          const out = await handler(...inputs);
          Registry.toolResultInjected = (Registry.toolResultInjected ?? 0) + 1;
          return { content: [null, { type: 'text', text: ['SHOULD_NOT_RENDER'] }, { type: 'text', text: 42 }, ...toContent(out)] };
        };
        return invoke.apply(this, args).finally(() => {
          tool.handler = handler;
        });
      };
    }, registryPath);
    const cdp = await fetch('http://127.0.0.1:18794/json/version').then((r) => r.json());
    expect(cdp.webSocketDebuggerUrl).toContain(':18794/');
    await expect(page.getByRole('heading', { name: 'What should we build?' })).toBeVisible();
    const url = `http://127.0.0.1:${port}/`;
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill(`CUCALL browser_navigate ${JSON.stringify({ url })}\nCUCALL browser_get_page_text {}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const approval = page.locator('.sage-approval');
    await expect(approval).toContainText(`127.0.0.1:${port}`);
    await pickScope(approval, /Allow once/);
    await expect(page.getByRole('main')).toContainText('Tool result text survived');
    await expect(page.getByRole('main')).not.toContainText('SHOULD_NOT_RENDER');
    expect(
      await harness.app.evaluate(
        (_electron, modulePath) => process.getBuiltinModule('module').createRequire(modulePath)(modulePath).Registry.toolResultInjected,
        registryPath,
      ),
    ).toBe(1);
    console.log(`tool-result smoke ${Date.now() - started}ms; scratch ${harness.dir}; CDP 18794`);
  } finally {
    await harness.app.evaluate(({ app }) => app.exit(0));
  }
});
