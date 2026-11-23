// What the real-agent specs share (host-remote-real-journey, host-remote-real-cells): the machine's own agents, the Host a spec starts, the helpers that drive the app and read the transcript, and the pieces that watch the Host's processes. VM only (MOPILOT_ACCEPT_VM=1).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type Harness } from './app';
import { cheapModel } from './realAgents';
import { REMOTE_FOLDER, type RemoteHost, connectRemote, sshToSelf, startRemoteChat, startRemoteHost } from './remoteHost';

let current: RemoteHost | undefined;
/** The Host the spec started (a stand-in that reads the live one, so a spec can use it as `remote.pid()` after a restart too). */
export const remote = new Proxy({} as RemoteHost, { get: (_t, key) => (current as unknown as Record<string | symbol, unknown>)[key] });

export const where = (name: string) => {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
export const HOME = os.homedir();
export const nonce = `n${Date.now().toString(36)}`;

export type Agent = { id: 'claude' | 'codex' | 'opencode'; label: string; row: string; bin: string; model: RegExp };
export const AGENTS: Agent[] = [
  { id: 'claude', label: 'Claude Code', row: 'Kimi Code', bin: where('claude'), model: /sonnet/i },
  { id: 'codex', label: 'Codex', row: 'Codex', bin: where('codex'), model: /5\.6-Luna/i },
  { id: 'opencode', label: 'opencode', row: 'Kimi Code', bin: where('opencode'), model: /free/i },
];

/** Which journey steps run (JR_STEPS=1,5,6; step 1 always runs): to find which earlier step leaves state that step 6 trips on (#4811). */
export const stepOn = (n: number) => !process.env.JR_STEPS || process.env.JR_STEPS.split(',').includes(String(n));

/** JR_CODEX_TAP=1: a `codex` in front of the machine's own on the Host's PATH that passes everything through and logs every line in both directions with the time (VM /tmp/codex-tap), to see which side loses a command. */
export const TAP_DIR = '/tmp/codex-tap';
export const TAP = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const log = fs.createWriteStream('${TAP_DIR}/tap-' + process.pid + '.jsonl', { flags: 'a' });
const w = (dir, data) => log.write(JSON.stringify({ t: Date.now(), dir, pid: process.pid, data: String(data).slice(0, 6000) }) + '\\n');
w('argv', process.argv.slice(2).join(' '));
const child = spawn('${where('codex')}', process.argv.slice(2), { stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.on('data', (d) => (w('in', d), child.stdin.write(d)));
process.stdin.on('end', () => (w('stdin-end', ''), child.stdin.end()));
child.stdout.on('data', (d) => (w('out', d), process.stdout.write(d)));
child.stderr.on('data', (d) => (w('err', d), process.stderr.write(d)));
child.on('exit', (c, sig) => (w('exit', c + ' ' + sig), log.end(() => process.exit(c ?? 1))));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => (w('signal', sig), child.kill(sig)));
`;

/** The settings every real-agent spec runs with (its own seed of the machine is written in the spec). */
export const REAL_USE = {
  harnesses: 'codex' as const,
  acp: { kimi: {} },
  shellPath: AGENTS.map((a) => a.bin)
    .filter(Boolean)
    .map((file) => path.dirname(file)),
  env: { MOPILOT_HOST_DEV: '1', HOME },
};

/** Serial tests, a long timeout, and the Host started once for the file (beforeAll) and stopped after it. */
export function declareRealHost() {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(40 * 60_000);
  // what the Host wrote, for a test that failed: the probe lines ("[ignored] probe whether … runs without a sign-in") say why an agent read as not ready
  test.afterEach(async ({}, info) => {
    if (info.status === info.expectedStatus || !current) return;
    const log = fs.existsSync(current.hostLog) ? fs.readFileSync(current.hostLog, 'utf8').slice(-6000) : '(none)';
    console.log(`JR-HOSTLOG ${info.title.slice(0, 60)} :: ${log.replaceAll('\n', ' ⏎ ')}`);
  });
  test.beforeAll(async () => {
    fs.mkdirSync(REMOTE_FOLDER, { recursive: true });
    if (process.env.JR_CODEX_TAP && where('codex')) {
      fs.rmSync(TAP_DIR, { recursive: true, force: true });
      fs.mkdirSync(TAP_DIR, { recursive: true });
      fs.writeFileSync(path.join(TAP_DIR, 'codex'), TAP, { mode: 0o755 });
      process.env.PATH = `${TAP_DIR}:${process.env.PATH}`;
    }
    sshToSelf();
    // opencode keeps no credential (its free models need none): the Host reads it as ready by itself since #4815; JR_OPENCODE_RECORD=1 marks it signed in in the scratch Host's own record instead (what the first run needed)
    current = await startRemoteHost({ agents: { signedIn: process.env.JR_OPENCODE_RECORD ? ['opencode'] : [] } });
  });
  test.afterAll(() => {
    current?.stop();
    fs.rmSync(REMOTE_FOLDER, { recursive: true, force: true });
  });
}

export const main = (page: Page) => page.getByRole('main');
export const stopButton = (page: Page) => page.getByRole('button', { name: 'Stop', exact: true });

/** The transcript as text, printed and attached for the evidence of each step. */
export async function evidence(page: Page, what: string) {
  const text = await main(page).innerText();
  console.log(`JR-TRANSCRIPT ${what} :: ${text.replaceAll('\n', ' ⏎ ').slice(0, 3000)}`);
  await test.info().attach(`${what}.txt`, { body: text, contentType: 'text/plain' });
  return text;
}

/** Waits for the turn to end, allowing every approval the agent asks for; how many were allowed. */
export async function untilIdle(page: Page, what: string, ms = 240_000) {
  let allowed = 0;
  const end = Date.now() + ms;
  // the turn has to have started: Stop (or an approval card) is there before "no Stop" means it is over
  await page
    .locator('.approval-card:has(button:enabled)')
    .first()
    .or(stopButton(page))
    .first()
    .waitFor({ timeout: 45_000 })
    .catch(() => undefined);
  for (;;) {
    if (
      await page
        .locator('.approval-card:has(button:enabled)')
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      allowed += 1;
      await page.keyboard.press('1');
      await page.waitForTimeout(500);
      continue;
    }
    if ((await stopButton(page).count()) === 0) {
      await page.waitForTimeout(1500);
      if (
        (await stopButton(page).count()) === 0 &&
        !(await page
          .locator('.approval-card:has(button:enabled)')
          .first()
          .isVisible()
          .catch(() => false))
      )
        return allowed;
    }
    if (Date.now() > end) throw new Error(`${what}: the turn did not end: ${(await main(page).innerText()).slice(0, 900)}`);
    await page.waitForTimeout(700);
  }
}

/** The model picker's list of the machine's agents, open (a chat on a machine). */
export async function openList(page: Page) {
  await page.getByRole('button', { name: 'Select model' }).click();
  const toList = page.getByRole('button', { name: 'Select harness and model' });
  if (await toList.isVisible().catch(() => false)) await toList.click();
  await expect(page.locator('.hp-harnesses')).toBeVisible();
}

/** A new chat on the machine's `agent`, its first message sent, on that agent's cheap model. */
export async function startOn(harness: Harness, agent: Agent, text: string, another = false) {
  const page = harness.page;
  if (!another) await connectRemote(page, remote, agent.id);
  await startRemoteChat(page, agent.row, text, another, async () => {
    if (agent.id === 'opencode') {
      await openList(page);
      // the picker is This Mac's two-level one: point at the agent's row, its models are beside the list
      await page.locator('.hp-row', { has: page.locator('.hp-title', { hasText: /^opencode$/i }) }).hover();
      await page.getByRole('menuitemradio', { name: agent.model }).first().click();
      await page.keyboard.press('Escape');
    } else await cheapModel(page, agent.model);
  });
}

/** Every process below the Host's: the agents it runs. */
export function agentPids(hostPid: number) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
  const below = new Set([hostPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (below.has(r.ppid) && !below.has(r.pid)) below.add(r.pid), (grew = true);
  }
  return rows.filter((r) => below.has(r.pid) && r.pid !== hostPid && !/\bps\b/.test(r.command) && !/mopilot-host\.mjs/.test(r.command));
}

/** The turn is running (an approval, if one is asked, is allowed first). */
export async function untilIdleOrRunning(page: Page) {
  const until = Date.now() + 120_000;
  while (Date.now() < until) {
    if (
      await page
        .locator('.approval-card:has(button:enabled)')
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      await page.keyboard.press('1');
      await page.waitForTimeout(800);
    } else if ((await stopButton(page).count()) > 0) {
      await page.waitForTimeout(8000);
      return;
    } else await page.waitForTimeout(500);
  }
}

export const tunnelPids = () =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(ssh -N .*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2].includes(`${os.userInfo().username}@localhost`))
    .map((m) => Number(m[1]));
