// CUJ conductor-import: a Mac with what Conductor leaves behind (a repository, and a workspace that is a git worktree of it under
// ~/conductor/workspaces/<repo>/<workspace>, with a .conductor/settings.toml) offers "Import from Conductor" in Settings →
// Worktrees. Importing adds the repository as a project and adopts the workspace in place: its branch, files and git state are
// untouched, only the adoption marker is written inside the worktree's own git folder, and nothing is left to import after.
// The new project has no chat yet: on the home page, whose new chat goes to it, the sidebar lists it as the current row, and
// the Projects page lists it (docs/project-sidebar.md).
// e2e-covers: electron/platform/conductorImport.cjs electron/platform/worktreeAdopt.cjs electron/platform/git.cjs electron/platform/projects.cjs
// e2e-covers: src/components/pages/settings/Git.tsx src/components/pages/settings/ConductorImport.tsx src/lib/conductorImport.ts
// e2e-covers: src/components/pages/Projects.tsx src/components/sidebar/projectGroups.ts src/components/sidebar/Sidebar.tsx src/store/projects.ts
// e2e-covers: src/components/sidebar/homeTarget.ts
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, type Dirs } from './fixtures/app';
import { settingsEntry } from './fixtures/settings';

const CONDUCTOR_TOML = `[scripts]
setup = "echo setup"
archive = "echo archive"

[scripts.run.web]
command = "echo run"
`;

/** The repository and its Conductor workspace, as Conductor makes them: a linked worktree on its own branch. */
function conductorInstall({ home }: Dirs) {
  const repo = path.join(home, 'work', 'acme');
  const workspace = path.join(home, 'conductor', 'workspaces', 'acme', 'riga');
  fs.mkdirSync(path.join(repo, '.conductor'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.conductor', 'settings.toml'), CONDUCTOR_TOML);
  fs.writeFileSync(path.join(repo, 'README.md'), 'acme\n');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', 'commit', '-q', '-m', 'init');
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  git(repo, 'worktree', 'add', '-q', '-b', 'riga-work', workspace);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'work in progress\n');
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** userData/projects.json's projects as [name, real path, source]; none while it is not written yet. */
function savedProjects(dir: string) {
  try {
    const { projects } = JSON.parse(fs.readFileSync(path.join(dir, 'userData', 'projects.json'), 'utf8'));
    return (projects as { name: string; path: string; source?: string }[]).map((p) => [p.name, fs.realpathSync(p.path), p.source]);
  } catch {
    return [];
  }
}

async function openWorktreeSettings(page: Page) {
  await page.locator('.sidebar-title').first().click();
  await settingsEntry(page).click();
  await page.locator('.side-row', { hasText: 'Git', hasNotText: 'GitHub' }).click();
}

test.describe('Import from Conductor', () => {
  test.use({ harnesses: 'codex', seed: { files: conductorInstall } });

  test('a Conductor workspace is imported in place: a project, the workspace adopted, its branch and files untouched', async ({
    harness,
  }) => {
    const page = harness.page;
    const home = path.join(harness.dir, 'home');
    const repo = path.join(home, 'work', 'acme');
    const workspace = path.join(home, 'conductor', 'workspaces', 'acme', 'riga');
    const headBefore = git(workspace, 'rev-parse', 'HEAD');

    await openWorktreeSettings(page);
    const group = page.locator('section.settings-group', { has: page.getByRole('heading', { name: 'Import from Conductor' }) });
    await expect(group).toBeVisible();
    await expect(group).toContainText('acme');
    await expect(group).toContainText('1 workspace');
    await group.getByRole('button', { name: 'Import acme', exact: true }).click();
    await expect(page.getByText('Imported 1 workspace', { exact: true })).toBeVisible();
    await expect(group.getByText('Nothing left to import', { exact: true })).toBeVisible();

    // the repository is a project now: saved at its own folder, the home page's row in the sidebar, and on the Projects page
    await expect.poll(() => savedProjects(harness.dir)).toEqual([['acme', fs.realpathSync(repo), 'sage']]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('complementary').locator('.project-row.selected[aria-label="acme"]')).toBeVisible();
    await page.getByRole('complementary').getByRole('button', { name: 'All projects', exact: true }).click();
    await expect(page.getByRole('main').getByRole('button', { name: 'acme', exact: true })).toBeVisible();

    // adopted in place: the marker sits in the worktree's own git folder; branch, commit and files are as Conductor left them
    const gitDir = git(workspace, 'rev-parse', '--absolute-git-dir');
    expect(fs.existsSync(path.join(gitDir, 'mopilot-worktree.json'))).toBe(true);
    expect(git(workspace, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('riga-work');
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(workspace, 'status', '--porcelain')).toBe('?? notes.txt');
    expect(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8')).toBe('work in progress\n');
    expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`worktree ${fs.realpathSync(workspace)}`);
  });
});
