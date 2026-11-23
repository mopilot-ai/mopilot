// New sessions appear in the project immediately while real worktree setup is held unfinished, on every harness family.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, type Harness } from './fixtures/app';

/** A scratch repository whose setup waits for the spec to release it, rather than depending on a startup delay. */
async function heldProject(h: Harness) {
  const repo = path.join(h.dir, 'home', 'work', 'instant-session');
  const release = path.join(h.dir, 'release-worktree-setup');
  fs.mkdirSync(path.join(repo, '.codex', 'environments'), { recursive: true });
  const script = `while [ ! -f '${release}' ]; do sleep 0.1; done`;
  fs.writeFileSync(
    path.join(repo, '.codex', 'environments', 'environment.toml'),
    `version = 1\n[setup]\nscript = ${JSON.stringify(script)}\n`,
  );
  fs.writeFileSync(path.join(repo, 'README.md'), 'Scratch session startup fixture\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'Fixture');
  await h.app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as any;
  }, repo);
  return release;
}

for (const family of ['codex', 'claude', 'acp'] as const) {
  test.describe(family, () => {
    if (family === 'acp') test.skip(process.platform !== 'darwin', 'ACP admission needs the macOS sage-mcp build');
    test.use({
      harnesses: family === 'acp' ? 'none' : family,
      seed: {
        uiState: { summaryOpen: true, prefs: { defaultHarness: family === 'acp' ? 'acp:opencode' : family, fontSize: 24, zoomLevel: 0 } },
      },
      acp: family === 'acp' ? { opencode: {} } : {},
    });

    test('submission is visible before setup finishes and becomes exactly one real session', async ({ page, harness }, info) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const composer = page.getByRole('textbox', { name: 'Message', exact: true });
      const sidebar = page.getByRole('complementary');
      await expect(composer).toBeVisible();
      const release = await heldProject(harness);
      try {
        await sidebar.getByRole('button', { name: 'Add new project', exact: true }).click();
        const project = sidebar.locator('.project-group', { has: page.locator('.project-row', { hasText: 'instant-session' }) });
        await expect(project).toBeVisible();
        await page.locator('label.ctx-check', { hasText: 'Worktree' }).click();
        await expect(page.locator('label.ctx-check input')).toBeChecked();
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt) {
            fs.unlinkSync(release);
            await project.locator('.project-row').hover();
            await project.getByRole('button', { name: 'New chat in instant-session', exact: true }).click();
            await expect(composer).toBeVisible();
            await expect(page.locator('label.ctx-check input')).toBeChecked();
          }
          const prompt = `Instant project session ${attempt + 1}`;
          await composer.fill(prompt);
          const sent = Date.now();
          await page.getByRole('button', { name: 'Send', exact: true }).click();
          const pending = project.locator('[data-chat-start]');
          await expect(pending).toHaveCount(1);
          await expect(pending).toBeVisible();
          const appeared = Date.now() - sent;
          await expect(pending).toContainText(prompt);
          await expect(pending).toHaveAttribute('aria-busy', 'true');
          await expect(pending.getByRole('img', { name: 'Starting chat', exact: true })).toBeVisible();
          await expect(project.locator('[data-sidebar-chat]')).toHaveCount(attempt);
          expect(fs.existsSync(release)).toBe(false, 'startup has not been released');
          await expect(async () => {
            await pending.scrollIntoViewIfNeeded();
            const geometry = await pending.evaluate((el) => {
              const box = el.getBoundingClientRect();
              const dot = el.querySelector('.row-dot')!.getBoundingClientRect();
              return {
                bounds: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
                viewport: { width: innerWidth, height: innerHeight },
                // Electron zoom can round a viewport edge by a fraction of a CSS pixel.
                inView: box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1,
                dotVisible: dot.width > 0 && dot.height > 0,
              };
            });
            expect(geometry.inView, JSON.stringify(geometry)).toBe(true);
            expect(geometry.dotVisible, JSON.stringify(geometry)).toBe(true);
          }).toPass({ timeout: 5000 });
          console.log(`[session-start-sidebar] ${family} submission ${attempt + 1}: row rendered in ${appeared} ms while setup is held`);
          await page.screenshot({ path: info.outputPath(`${family}-starting-${attempt + 1}.png`) });
          fs.writeFileSync(release, 'continue');
          await expect(sidebar.locator('[data-chat-start]')).toHaveCount(0);
          await expect(project.locator('[data-sidebar-chat]')).toHaveCount(attempt + 1);
          await expect(page.getByRole('main').locator('.user-bubble', { hasText: prompt })).toBeVisible();
          await expect(composer).toHaveText('');
          await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
          await expect(composer).toBeEditable();
        }
      } finally {
        fs.writeFileSync(release, 'continue');
      }
    });
  });
}
