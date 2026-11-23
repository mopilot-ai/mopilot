// e2e-runner: bench
// Remote Run audit M13, M14, M47, M49, M51 and M53: the menus of a chat that runs on a machine, in the real Mac app against a real Host process over real ssh (this runner's sshd and the app's ssh tunnel) that has the repo's fake Claude Code. The sidebar row menu, the title-bar menu and the project group menu have the same items as for a chat on This Mac; the ones that act on this Mac's disk are greyed with "On <machine>", the resume command and the working directory say which machine they are for, and the folder is its own group, marked with the machine.
// This runner's folder (REMOTE_FOLDER) is a real folder on this Mac too: the greyed Reveal in Finder is the point. One machine is all a runner can host, so two machines with one path are in tests/projectGroupMachine.test.ts. It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-menus.spec.ts`.
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/ThreadRow.tsx src/components/titleBar/TitleBar.tsx src/components/ui/HostMark.tsx
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import {
  REMOTE_FOLDER,
  type RemoteHost,
  connectRemote,
  machineName,
  sshToSelf,
  startRemoteChat,
  startRemoteHost,
} from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and writes the ssh config');

const HOME = os.homedir();
let remote: RemoteHost;

test.setTimeout(8 * 60_000);
test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: 'claude+codex' });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', HOME },
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:runner@localhost',
            name: 'localhost',
            address: 'runner@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            harnesses: [],
            // read when the seed is written, not when the worker loads this file (hostFixtureHeartbeat.invariant.test.ts)
            get lastHeartbeat() {
              return Date.now();
            },
            setup: '',
          },
        ],
      },
    },
  },
});

test('a chat on a machine has the same menus as one on This Mac: what acts on this Mac is greyed with the machine named, and its folder is a group of its own', async ({
  harness,
}) => {
  const page = harness.page;
  await connectRemote(page, remote, 'claude');
  const machine = await machineName(page);
  await startRemoteChat(page, 'Kimi Code', 'first-menus');
  await expect(page.getByRole('main')).toContainText('fake-claude: first-menus', { timeout: 120_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 90_000 });
  const hint = `On ${machine}`;
  const reason = `This folder is on ${machine}, not on this Mac`;
  const sidebar = page.getByRole('complementary');

  // the row's menu: Open in keeps its split and window items and greys the folder item; nothing lists this Mac's Finder or editors
  const row = sidebar.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]').first();
  await expect(row.getByRole('img', { name: hint, exact: true }).locator('.lucide-square-terminal')).toBeVisible();
  await expect(page.locator('.tb-title').getByRole('img', { name: hint, exact: true }).locator('.lucide-square-terminal')).toBeVisible();
  await row.hover();
  await row.getByRole('button', { name: 'More options', exact: true }).click();
  const menu = page.getByRole('menu');
  for (const name of ['Open in', 'Pin', 'Mark as unread', 'Rename', 'Fork', 'Archive', 'Delete'])
    await expect(menu.getByRole('menuitem', { name: new RegExp(`^${name}`) })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Open in', exact: true }).click();
  const folder = page.getByRole('menuitem', { name: /^Open folder/ });
  await expect(folder).toHaveAttribute('aria-disabled', 'true');
  await expect(folder).toContainText(hint);
  await expect(folder).toHaveAttribute('title', reason);
  await expect(page.getByRole('menuitem', { name: /^Finder/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // the title-bar menu: the resume command and the path are good in a shell on the machine, and say so
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: /^Copy$/ }).click();
  const resume = page.getByRole('menuitem', { name: /^Copy resume command/ });
  await expect(resume).toContainText(hint);
  await expect(page.getByRole('menuitem', { name: /^Copy working directory/ })).toContainText(hint);
  await resume.click();
  await expect(page.locator('.toast', { hasText: `Copied resume command: run it on ${machine}` })).toBeVisible();
  await page.getByRole('button', { name: 'Chat actions' }).click();
  await page.getByRole('menuitem', { name: 'Open in', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /^Open folder/ })).toHaveAttribute('aria-disabled', 'true');
  // project actions need a folder on this Mac: none for a machine's (by design)
  await expect(page.getByRole('menuitem', { name: /^Actions/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // The project shows its terminal and disclosure after its label, with the machine in the hover card and menu.
  const group = sidebar.locator(`.project-row[aria-label="${path.basename(REMOTE_FOLDER)}"]`);
  await expect(group.locator('.side-row-label + .host-mark .lucide-square-terminal')).toBeVisible();
  const disclosure = group.locator('.host-mark + .project-disclosure');
  await expect(disclosure).toBeVisible();
  await expect(group.locator('.side-row-label')).toHaveText(path.basename(REMOTE_FOLDER));
  await sidebar.locator('.sidebar-header').hover();
  const beforeHover = await disclosure.boundingBox();
  await group.hover();
  expect(await disclosure.boundingBox()).toEqual(beforeHover);
  const card = page.locator('.project-card');
  await expect(card.getByText(hint, { exact: true })).toBeVisible();
  await expect(card).not.toContainText(REMOTE_FOLDER);
  await group.click({ button: 'right' });
  const reveal = page.getByRole('menuitem', { name: /^Reveal in Finder/ });
  await expect(reveal).toHaveAttribute('aria-disabled', 'true');
  await expect(reveal).toContainText(hint);
});
