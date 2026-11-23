// e2e-runner: bench
// MM3, multi-agent: four chats of the Mac app running at once across three backends, the same fake ACP agent behind each (This Mac: the app runs it; This Mac · keeps running: the launch agent the app installs; a real Host over real ssh: a second Host process on this runner, two chats). All four are mid-turn together; the app switches between them while they stream and each shows only its own words and says where it runs; then each raises its own approval card, and every card is answered in the chat that raised it, with only that chat's reply following.
// It installs a launch agent and turns on the runner's sshd, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/mm3-four-chats.spec.ts`.
// e2e-covers: src/components/sidebar/ThreadRow.tsx src/components/ui/HostMark.tsx
import fs from 'node:fs';
import os from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';
import { installThisMac, removeHostFiles, startChatOnThisMac } from './fixtures/hostLocal';
import { send } from './fixtures/mm3Journey';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './fixtures/remoteHost';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.GITHUB_ACTIONS, 'a runner only: it turns on sshd and installs a launch agent');

const HOME = os.homedir();
let remote: RemoteHost;

test.beforeAll(async () => {
  fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
  sshToSelf();
  remote = await startRemoteHost({ agents: 'acp' });
});
test.afterAll(() => {
  remote?.stop();
  fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
});
test.afterEach(removeHostFiles);

test.setTimeout(15 * 60_000);
test.use({
  harnesses: 'codex',
  acp: { kimi: {} },
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.local=1', HOME },
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

const transcript = (page: Page) => page.getByRole('main');
const stop = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });
/** The chats in Recents (a chat in a project is listed there too, by design), by the id the app gave each. */
const row = (page: Page, id: string) => page.locator(`[data-shortcut-recents] [data-sidebar-chat="${id}"]`);
const newestId = (page: Page) =>
  page.locator('[data-shortcut-recents] [data-sidebar-chat^="acp:"]').first().getAttribute('data-sidebar-chat');

interface Chat {
  word: string;
  where: string;
  chip: RegExp;
  id?: string;
}

test('four chats at once across This Mac, This Mac · keeps running and a real Host over ssh: each keeps its words, its place and its card', async ({
  harness,
}) => {
  const page = harness.page;
  await installThisMac(harness);
  await connectRemote(page, remote, 'fake');
  const chats: Chat[] = [
    { word: 'alpha', where: 'This computer', chip: /This computer/ },
    { word: 'bravo', where: 'This Mac · keeps running', chip: /This Mac · keeps running/ },
    { word: 'charlie', where: 'localhost', chip: /localhost/ },
    { word: 'delta', where: 'localhost', chip: /localhost/ },
  ];
  const starters = [
    async (m: string) => {
      await openHarnessList(page);
      await page.locator('.hp-harnesses .hp-row', { hasText: 'Kimi Code' }).click();
      await send(page, m);
    },
    (m: string) => startChatOnThisMac(harness, m, { another: true }),
    (m: string) => startRemoteChat(page, 'Kimi Code', m, true),
    (m: string) => startRemoteChat(page, 'Kimi Code', m, true),
  ];

  // all four start and stream a first chunk, then wait (SLOW): four turns running together
  for (const [i, chat] of chats.entries()) {
    await starters[i](`SLOW ${chat.word}`);
    await expect(transcript(page).getByText(`fake-acp: SLOW ${chat.word}`, { exact: true })).toBeVisible({ timeout: 90_000 });
    chat.id = (await newestId(page)) ?? undefined;
    expect(chat.id, `the id of ${chat.word}`).toBeTruthy();
  }
  expect(new Set(chats.map((c) => c.id)).size, 'four different chats').toBe(4);

  // switching while they stream: each shows only its own words, its turn still running, and the chip says where it runs
  const switches: number[] = [];
  for (const chat of [...chats, ...chats.slice().reverse()]) {
    const from = Date.now();
    await row(page, chat.id!).click();
    await expect(transcript(page).getByText(`fake-acp: SLOW ${chat.word}`, { exact: true })).toBeVisible({ timeout: 30_000 });
    switches.push(Date.now() - from);
    for (const other of chats.filter((c) => c !== chat))
      await expect(transcript(page).getByText(`fake-acp: SLOW ${other.word}`)).toHaveCount(0);
    await expect(stop(page)).toBeVisible();
    await expect(page.getByRole('main').getByText(chat.chip).first()).toBeVisible();
  }
  console.log(`MM3-TIMING ${JSON.stringify({ backend: 'four at once', switchMs: switches })}`);

  // each chat: Stop its turn, then ask for an approval of its own
  for (const chat of chats) {
    await row(page, chat.id!).click();
    await stop(page).click();
    await expect(stop(page)).toHaveCount(0, { timeout: 30_000 });
    await send(page, `PERMIT ${chat.word}`);
    await expect(page.locator('.approval-card')).toBeVisible({ timeout: 60_000 });
  }
  // every card is answered in the chat that raised it, in another order: the open chat shows one card, and only its own reply follows
  for (const chat of chats.slice().reverse()) {
    await row(page, chat.id!).click();
    await expect(page.locator('.approval-card')).toHaveCount(1);
    await page.keyboard.press('1');
    await expect(transcript(page).getByText(`fake-acp: PERMIT ${chat.word}`, { exact: true })).toBeVisible({ timeout: 60_000 });
    for (const other of chats.filter((c) => c !== chat))
      await expect(transcript(page).getByText(`fake-acp: PERMIT ${other.word}`)).toHaveCount(0);
  }
  for (const chat of chats) {
    const mark = row(page, chat.id!).getByRole('img', { name: `On ${chat.where}`, exact: true });
    if (chat.where === 'This computer') await expect(row(page, chat.id!).locator('.host-mark')).toHaveCount(0);
    else await expect(mark.locator(chat.where === 'localhost' ? '.lucide-square-terminal' : '.lucide-laptop')).toBeVisible();
    await expect(row(page, chat.id!).locator('.side-row-sub')).toHaveCount(0);
  }
  await page.evaluate(() => window.native.host.removeLocal());
});
