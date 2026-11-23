// Windows preserves official package commands with manual execution, actionable explanations and vendor guidance.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render, click, byText } from './support/pages-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h } = await import('react');
const calls: string[] = [];
const copied: string[] = [];
installNativeStub({ harnessRuns: { find: async () => false } });
stubStore({ connect: async () => undefined, toast: () => undefined });
mock.module('../src/session/harness/claude.ts', {
  namedExports: { detectClaude: async () => undefined, recheckClaude: async () => undefined },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { recheckBasic: async () => undefined } });
mock.module('../src/lib/platform.ts', { namedExports: { platform: 'win32' } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: (command: string) => copied.push(command) } });
mock.module('../src/session/open.ts', { namedExports: { openLink: (url: string) => calls.push(url) } });
mock.module('../src/components/panels/TerminalPanel.tsx', { namedExports: { TermView: () => null } });
const { InstallLines } = await import('../src/components/harness/InstallLines.tsx');

test("Windows shows its own commands, and the vendor's note beside the line that needs it", async () => {
  const item: any = { kind: 'acp:kimi', label: 'Kimi Code', vendor: 'Moonshot AI', tier: 'basic', state: 'missing', version: null };
  const v = await render(h(InstallLines, { item, onSetLocation: () => undefined }));
  const lines = [...v.host.querySelectorAll('.install-line')];
  assert.deepEqual(
    lines.map((l) => [l.querySelector('.install-via')!.textContent, l.querySelector('.install-why')?.textContent ?? null]),
    [
      ['npm', 'Run this command in your terminal. Automatic package changes are unavailable on Windows.'],
      ['PowerShell', 'Run this command in your terminal. Automatic package changes are unavailable on Windows. · Needs Git for Windows'],
    ],
  );
  for (const button of v.host.querySelectorAll<HTMLButtonElement>('button[aria-label^="Run "]')) assert.equal(button.disabled, true);
  const copy = v.host.querySelector<HTMLButtonElement>('button[aria-label^="Copy the"]')!;
  await click(copy);
  assert.deepEqual(copied, ['npm install -g @moonshot-ai/kimi-code']);
  await v.unmount();
});

test('a platform without a one-line installer still offers the vendor and a manual location', async () => {
  calls.length = 0;
  const item: any = { kind: 'acp:goose', label: 'Goose', vendor: 'AAIF', tier: 'basic', state: 'missing', version: null };
  const v = await render(h(InstallLines, { item, onSetLocation: () => calls.push('locate') }));
  assert.equal(v.host.querySelectorAll('.install-line').length, 0);
  await click(byText(v.host, 'Get it from AAIF ↗'));
  await click(byText(v.host, 'Set location…'));
  assert.deepEqual(calls, ['https://goose-docs.ai/docs/getting-started/installation', 'locate']);
  await v.unmount();
});
