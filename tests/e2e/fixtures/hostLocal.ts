// What the specs of This Mac's background Host share (host-local-*.spec.ts): the Host installed for the signed-in user from a dev build with host.local on, the repo's fake ACP agent as its agent, a chat started on it from the folder menu, and the launchd facts to read and clean up. Only for a CI runner or an isolated VM: it installs a launch agent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, FAKE_ACP, type Harness } from './app';
import { openHarnessList } from './harnessPicker';

/**
 * The Host is the launch agent of the signed-in user, so it and the app must agree on whose home it is: a spec keeps the user's HOME (`env: { HOME }`) and removes what it wrote there
 * afterwards (`removeHostFiles`; a runner or a VM is disposable). The app's data (userData, the harness homes) stays isolated.
 */
export const HOME = os.homedir();
export const LABEL = 'ai.mopilot.host';
export const THIS_MAC = 'This Mac · keeps running';
const PROJECT = 's11-proj';
const HOST_FILES = [
  'Library/LaunchAgents/ai.mopilot.host.plist',
  'Library/Application Support/mopilot-host',
  '.mopilot-host',
  '.config/mopilot-host',
  PROJECT,
];

/** The Host's process, from launchd; null while it is not running. */
export function hostPid(): string | null {
  try {
    return /"PID" = (\d+);/.exec(execFileSync('launchctl', ['list', LABEL], { encoding: 'utf8' }))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether the fake agent's process is alive on this machine (a bracketed first letter: the pattern never matches this line). */
export function agentRuns(): boolean {
  try {
    return execFileSync('pgrep', ['-f', '[f]ake-acp-agent.mjs'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
}

/** What main reports as ignored (a failure it survives) goes to the test output, where a run on a runner can be read. */
export const showIgnored = (h: Harness) =>
  h.app.process().stdout?.on('data', (d: Buffer) => {
    for (const line of String(d).split('\n')) if (line.includes('[ignored]')) console.log(line);
  });

/** The agent the Host runs for this app's chats: the repo's fake ACP agent, defined before the Host first starts (its harnesses.json) and known to be signed in (host/src/signedIn.mjs). */
function defineFakeAgent(h: Harness) {
  const data = path.join(HOME, 'Library', 'Application Support', 'mopilot-host');
  fs.mkdirSync(data, { recursive: true });
  const harnesses = {
    fake: { label: 'Fake', bin: process.execPath, args: [FAKE_ACP], env: { FAKE_ACP_STATE: path.join(h.dir, 'fake-acp-host-state') } },
  };
  fs.writeFileSync(path.join(data, 'harnesses.json'), JSON.stringify(harnesses));
  fs.writeFileSync(path.join(data, 'signed-in.json'), JSON.stringify({ fake: true }));
}

/** This Mac's row as the window lists it, or null. */
export const thisMacRow = (h: Harness) =>
  h.page.evaluate(() => window.native.host.machines().then((r) => r.machines.find((m) => m.id === 'this-mac-host') ?? null));

/** Install the Host for this user from the app, and wait until its row is online with the fake agent on it. */
export async function installThisMac(h: Harness) {
  defineFakeAgent(h);
  const added = await h.page.evaluate(() => window.native.host.addLocal());
  expect(added, JSON.stringify(added)).toMatchObject({ ok: true, paired: true });
  await expect.poll(() => hostPid(), { timeout: 60_000 }).not.toBeNull();
  // the row's JSON is what a failure prints; the folder menu lists the machines that are online
  await expect.poll(async () => JSON.stringify(await thisMacRow(h)), { timeout: 60_000 }).toContain('"status":"online"');
  await expect.poll(async () => JSON.stringify(await thisMacRow(h)), { timeout: 60_000 }).toContain('"fake"');
}

/** A new chat on This Mac's Host in a folder of its own (the picked harness is not ready there, so it starts on the Fake agent), and its first message. */
export async function startChatOnThisMac(
  h: Harness,
  message: string,
  { another = false, localRow = 'Kimi Code', beforeSend }: { another?: boolean; localRow?: string; beforeSend?: () => Promise<void> } = {},
) {
  const page = h.page;
  if (another) await page.getByRole('button', { name: 'New chat' }).first().click();
  const folder = path.join(HOME, PROJECT);
  fs.mkdirSync(folder, { recursive: true });
  await openHarnessList(page);
  await page.locator('.hp-harnesses .hp-row', { hasText: localRow }).click();
  // (a harness that has models opens its list: it is closed before the folder menu)
  await page.keyboard.press('Escape');
  await expect(page.locator('.popover-layer .menu-title')).toHaveCount(0);
  await page.locator('.ctxbar .ctx-btn').first().click();
  await page.getByText(`Folder on ${THIS_MAC}…`).click({ timeout: 45_000 });
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.host-picker-path')).toBeVisible({ timeout: 45_000 });
  if ((await dialog.locator('.host-picker-path').textContent()) !== folder)
    await dialog.locator('.host-picker-open', { hasText: PROJECT }).click();
  await expect(dialog.locator('.host-picker-path')).toHaveText(folder);
  await dialog.getByRole('button', { name: 'Use this folder' }).click();
  // (a chat's model is chosen before its first message)
  await beforeSend?.();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill(message);
  await expect(composer).toHaveText(message);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

/**
 * A second client of This Mac's Host, paired under `name` ("Pocket iPhone"), answers the card that waits on `chatId`, as a phone does through the Host's own protocol.
 * It runs in a plain Node process: the Host's modules read import.meta, which Playwright's loader does not take.
 */
export function answerAsSecondClient(h: Harness, name: string, chatId: string, kind: 'allow' | 'deny', key: string) {
  const registry = JSON.parse(fs.readFileSync(path.join(h.dir, 'userData', 'host-registry.json'), 'utf8'));
  const socketPath = registry.hosts.find((m: { id: string }) => m.id === 'this-mac-host').socketPath;
  const script = path.join(__dirname, 'hostSecondClient.mjs');
  return execFileSync(process.execPath, [script, socketPath, path.join(h.dir, 'second-client-key.json'), name, chatId, kind, key], {
    encoding: 'utf8',
    env: { ...process.env, HOME },
    timeout: 120_000,
  });
}

/** A failed run leaves no agent behind (removeLocal does this when the run got that far), and nothing in the user's home. */
export function removeHostFiles() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // not loaded
  }
  // (the Host may still be writing as launchd stops it)
  for (const f of HOST_FILES) fs.rmSync(path.join(HOME, f), { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
}
