// The phone usage method on the real main process and fake Codex accounts, preserving per-account windows without credentials or Host attribution.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';

test.use({
  harnesses: 'codex',
  env: { FAKE_CODEX_USAGE: '1' },
  mainRequire: [path.join(__dirname, 'fixtures', 'remote-service-hook.cjs')],
  seed: { files: (dirs) => twoCodexAccounts(dirs) },
});

test('phone usage reads each local account through production wiring and provider windows', async ({ harness }) => {
  const read = () =>
    harness.app.evaluate(async () => {
      const service = (globalThis as any).__remoteService;
      const phone = { kind: 'phone', pairId: 'phone-usage-e2e', follows: new Set<string>() };
      const hello = await service.call(phone, 'machine.hello', {});
      const usage = await service.call(phone, 'usage.get', { refresh: true, hostId: 'not-a-local-account' });
      return { methods: hello.capabilities.methods, usage };
    });
  await expect
    .poll(
      async () => {
        const { usage } = await read();
        return usage.accounts.filter((a: any) => a.harness === 'codex' && a.state === 'available').length;
      },
      { timeout: 45000 },
    )
    .toBe(2);
  const { methods, usage } = await read();
  expect(methods).toContain('usage.get');
  expect(usage.scope).toBe('local');
  const codex = usage.accounts.filter((a: any) => a.harness === 'codex');
  expect(codex.map((a: any) => a.account).sort()).toEqual(['default', 'second']);
  for (const account of codex) {
    expect(account.windows.map((w: any) => [w.label, w.usedPercent])).toEqual([
      ['5h', 42],
      ['Weekly', 10],
    ]);
    expect(account.windows[0].at).toBeGreaterThan(0);
    expect(account.windows[0].resetsAt).toBeGreaterThan(Date.now() / 1000);
    expect(account.windows[0].stale).toBe(false);
  }
  expect(JSON.stringify(usage)).not.toMatch(/access_token|refresh_token|id_token|chatgptAccountId|auth\.json|not-a-local-account/);
});
