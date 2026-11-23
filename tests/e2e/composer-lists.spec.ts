// Claude Code desktop-style composer lists: native typing, repeated items, nesting, empty-item exit and prompt delivery.
// e2e-covers: src/components/composer/ComposerInput.tsx src/lib/composerLists.ts src/lib/composerListNesting.ts src/lib/composerBlockEdit.ts src/lib/composerEditorDocument.ts src/lib/skillDeletion.ts src/styles/app/composer.css
import { test, expect } from './fixtures/app';
import { claudeChatMessages, claudeTextOf } from './fixtures/claudeChat';
import { sizeRealWindow } from './fixtures/window';

for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {}, defaultHarness: 'codex' },
  { label: 'Claude Code', harnesses: 'claude', acp: {}, defaultHarness: 'claude' },
  { label: 'ACP', harnesses: 'none', acp: { opencode: {} }, defaultHarness: 'acp:opencode' },
] as const) {
  for (const sendWith of ['enter', 'cmdEnter'] as const) {
    test.describe(`${family.label} list editing with ${sendWith}`, () => {
      test.skip(process.platform !== 'darwin', 'All three harnesses are verified together on an isolated macOS runner');
      test.use({
        harnesses: family.harnesses,
        acp: family.acp,
        // Pin zoom so the legacy font-size migration cannot change the capture's coordinate scale.
        seed: { uiState: { prefs: { defaultHarness: family.defaultHarness, sendWith, fontSize: 24, zoomLevel: 0 } } },
      });
      test('formatted lists keep their numbers through typing, nesting and sending', async ({ page, harness }, testInfo) => {
        await sizeRealWindow(page, harness, 1024, 682);
        const input = page.getByRole('textbox', { name: 'Message', exact: true });
        await expect(input).toHaveCSS('font-size', '24px');
        const value = () => input.evaluate((el) => (el as HTMLElement & { value: string }).value);
        const newline = sendWith === 'enter' ? 'Shift+Enter' : 'Enter';
        const send = sendWith === 'enter' ? 'Enter' : 'Meta+Enter';
        await input.click();
        await page.keyboard.type('1. First');
        await expect(input.locator('ol > li')).toHaveCount(1);
        await expect.poll(value).toBe('1. First');
        await input.press('Tab');
        await expect.poll(value).toBe('1. First');
        await input.press(newline);
        await page.keyboard.type('Second');
        await input.press(newline);
        await page.keyboard.type('Third');
        await expect(input.locator('ol > li')).toHaveCount(3);
        await expect.poll(value).toBe('1. First\n2. Second\n3. Third');
        await input.press('Tab');
        await expect(input.locator('ol ol > li')).toHaveCount(1);
        await expect.poll(value).toBe('1. First\n2. Second\n   1. Third');
        await input.press('Shift+Tab');
        await expect(input.locator('ol ol')).toHaveCount(0);
        await expect.poll(value).toBe('1. First\n2. Second\n3. Third');
        await input.press(newline);
        await expect.poll(value).toBe('1. First\n2. Second\n3. Third\n4. ');
        await input.press(newline);
        await page.keyboard.type('9. Restarted');
        await input.press(newline);
        await page.keyboard.type('Continued');
        await expect.poll(value).toBe('1. First\n2. Second\n3. Third\n9. Restarted\n10. Continued');
        await input.press(newline);
        await input.press(newline);
        await page.keyboard.type('After the list');
        await expect.poll(value).toBe('1. First\n2. Second\n3. Third\n9. Restarted\n10. Continued\nAfter the list');
        await input.press(newline);
        await page.keyboard.type('- Bullet one');
        await input.press('Alt+Enter');
        await page.keyboard.type('Bullet two');
        await expect(input.locator('ul > li')).toHaveCount(2);
        const expected = '1. First\n2. Second\n3. Third\n9. Restarted\n10. Continued\nAfter the list\n- Bullet one\n- Bullet two';
        await expect.poll(value).toBe(expected);
        await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('composer-window.png') });
        await input.screenshot({ animations: 'disabled', path: testInfo.outputPath('composer-lists.png') });
        await input.press(send);
        await expect(input).toHaveText('');
        if (family.harnesses === 'codex') {
          await expect
            .poll(() =>
              harness
                .codexLog()
                .some(
                  (entry) => entry.method === 'turn/start' && entry.params.input.some((part: { text?: string }) => part.text === expected),
                ),
            )
            .toBe(true);
        } else if (family.harnesses === 'claude') {
          await expect.poll(() => claudeChatMessages(harness).some((message) => claudeTextOf(message) === expected)).toBe(true);
        } else {
          await expect
            .poll(() =>
              harness
                .acpLog('opencode')
                .some(
                  (entry) =>
                    entry.kind === 'in' &&
                    entry.msg.method === 'session/prompt' &&
                    entry.msg.params.prompt.some((part: { text?: string }) => part.text === expected),
                ),
            )
            .toBe(true);
        }
        await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
        // The same editor remains usable after a completed turn. Native undo/redo preserves list mutations.
        const followUp = '9. Follow-up';
        await page.keyboard.type(followUp);
        await input.press(newline);
        await expect.poll(value).toBe(`${followUp}\n10. `);
        await input.press('Meta+z');
        // Chromium can group some of the preceding typing into the paragraph's native undo transaction.
        await expect
          .poll(async () => {
            const draft = await value();
            return { draft, isItemPrefix: draft.startsWith('9. ') && followUp.startsWith(draft) };
          })
          .toMatchObject({ isItemPrefix: true });
        await expect(input.locator('ol > li')).toHaveCount(1);
        await input.press('Meta+Shift+z');
        await expect.poll(value).toBe(`${followUp}\n10. `);
        await input.press('Backspace');
        await page.keyboard.type('Outside again');
        await expect(input.locator('li')).toHaveCount(1);
        await expect(input.locator('ol div')).toHaveCount(0);
        await expect.poll(value).toBe('9. Follow-up\nOutside again');
        // A pasted parent and its mixed descendants move together, including through native undo.
        await input.press('Meta+A');
        await input.evaluate((el) => {
          const clipboard = new DataTransfer();
          clipboard.setData('text/plain', '1. Parent\n2. Child\n   - Grandchild');
          el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
          const editor = el as HTMLElement & { setSelectionRange(start: number, end: number): void };
          editor.setSelectionRange(18, 18);
        });
        const subtree = '1. Parent\n2. Child\n   - Grandchild';
        await expect.poll(value).toBe(subtree);
        await input.press('Tab');
        const nested = '1. Parent\n   1. Child\n      - Grandchild';
        await expect.poll(value).toBe(nested);
        await input.press('Meta+z');
        await expect.poll(value).toBe(subtree);
        await input.press('Meta+Shift+z');
        await expect.poll(value).toBe(nested);
        await input.evaluate((el) => {
          const editor = el as HTMLElement & { value: string; setSelectionRange(start: number, end: number): void };
          const caret = editor.value.indexOf('Child') + 5;
          editor.setSelectionRange(caret, caret);
        });
        await input.press('Shift+Tab');
        await expect.poll(value).toBe(subtree);
      });
    });
  }
}
