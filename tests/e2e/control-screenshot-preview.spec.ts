// Replays control screenshots in the real app and checks first-click previews independently of disclosure hit targets.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const images = [
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAB4CAIAAADUhU+qAAABL0lEQVR4nO3SMQ0AIADAMCSiCXXIwgC74WhSATs25tpwNZ4X8C1zkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBOgSXKaqYHaPjAAAAAElFTkSuQmCC',
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAB4CAIAAADUhU+qAAABL0lEQVR4nO3SMQ0AIADAMCSiCXXIwgC74WhSATs29ppwNZ4X8C1zkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBMgfJHCRzkMxBOiM4KaoPzMVcAAAAAElFTkSuQmCC',
];
const variants = ['single step', 'control run', 'mixed group'];
test.use({
  harnesses: 'claude',
  seed: {
    uiState: { summaryOpen: true, prefs: { fontSize: 24, zoomLevel: 0 } },
    files: ({ home, claudeHome }) => {
      variants.forEach((kind, index) => {
        const sessionId = `55555555-1111-4222-8333-44444444444${index}`;
        const cwd = path.join(home, `preview-${index}`);
        const folder = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
        fs.mkdirSync(cwd, { recursive: true });
        fs.mkdirSync(folder, { recursive: true });
        const records: object[] = [{ type: 'custom-title', sessionId, customTitle: `Preview ${kind}` }];
        let parentUuid: string | null = null;
        const record = (type: string, message: object) => {
          const uuid = `record-${records.length}`;
          records.push({ type, uuid, parentUuid, sessionId, cwd, timestamp: new Date().toISOString(), isSidechain: false, message });
          parentUuid = uuid;
        };
        record('user', { role: 'user', content: 'Inspect the browser screenshots' });
        const count = kind === 'single step' ? 1 : 3;
        for (let i = 0; i < count; i++) {
          record('assistant', {
            id: `msg-${i}`,
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-${i}`, name: 'mcp__claude-in-chrome__computer', input: { action: 'screenshot' } }],
            stop_reason: 'tool_use',
          });
          record('user', {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: `tool-${i}`,
                content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: images[i % 2] } }],
              },
            ],
          });
        }
        if (kind === 'mixed group') {
          record('assistant', {
            id: 'msg-read',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: path.join(cwd, 'README.md') } }],
            stop_reason: 'tool_use',
          });
          record('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Browser documentation' }] });
        }
        record('assistant', {
          id: 'msg-done',
          role: 'assistant',
          content: [{ type: 'text', text: 'Screenshots checked.' }],
          stop_reason: 'end_turn',
        });
        fs.writeFileSync(path.join(folder, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      });
    },
  },
});

for (const kind of variants) {
  test(`${kind}: one click previews the chosen screenshot at narrow width with panels and large text`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1024, height: 682 });
    await page.getByRole('complementary').getByText(`Preview ${kind}`, { exact: true }).first().click();
    const main = page.getByRole('main');
    await main.getByRole('button', { name: /^Worked/ }).click();
    const row = main.locator('.step-row').first();
    // a lone call shows its screenshot below its row; a group shows thumbnails at its row's end
    const thumbs = kind === 'single step' ? main.locator('.step-shots .step-shot') : row.locator('.step-thumb');
    await expect(thumbs.first()).toBeVisible();
    // the row says what the calls did, in Claude Desktop's words
    const said = {
      'single step': 'Took a screenshot',
      'control run': 'Captured page 3 times',
      'mixed group': 'Read a file, captured page 3 times',
    };
    await expect(row.locator('.step-text')).toHaveText(said[kind as keyof typeof said]);
    const toggle = row.locator('.step-row-hit');
    for (const expanded of [false, true]) {
      await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
      for (let i = 0; i < (await thumbs.count()); i++) {
        const thumb = thumbs.nth(i);
        const src = await thumb.getAttribute('src');
        await expect.poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(180);
        const start = Date.now();
        // Locator.click uses Chromium's real hit test; no force, dispatchEvent or DOM .click fallback.
        await thumb.click();
        await expect(page.getByRole('dialog', { name: /^Image preview:/ })).toBeVisible();
        await expect(page.locator('.lightbox-image')).toHaveAttribute('src', src!);
        await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
        test
          .info()
          .annotations.push({ type: 'preview-ms', description: `${kind} image ${i + 1}, expanded=${expanded}: ${Date.now() - start}` });
        await page.screenshot({ path: info.outputPath(`preview-${expanded}-${i}.png`) });
        await page.keyboard.press('Escape');
        await expect(page.locator('.lightbox')).toHaveCount(0);
        await expect(thumb).toBeFocused();
        await thumb.press('Enter');
        await expect(page.locator('.lightbox')).toBeVisible();
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.locator('.lightbox')).toHaveCount(0);
      }
      // Text and chevron retain the same detail disclosure action.
      const detailTarget = await row.locator(expanded ? '.step-chevron' : '.step-text').boundingBox();
      expect(detailTarget).not.toBeNull();
      await page.mouse.click(detailTarget!.x + detailTarget!.width / 2, detailTarget!.y + detailTarget!.height / 2);
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await page.screenshot({ path: info.outputPath('thumbnail-row.png') });
  });
}
