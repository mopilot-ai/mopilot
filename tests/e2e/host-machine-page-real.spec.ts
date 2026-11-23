// e2e-runner: bench
// A machine's page (X2, host.machinePage) in the real Mac app against a real Host process over real ssh (this runner's sshd and the app's ssh tunnel): every control of the page is clicked and what the Host kept is read back. Status (the connection choice), Devices (a second Mac and a phone the Host knows; Remove takes the Mac off the Host), Rules (each of the six controls), Spending (both limits, read back from the Host's own status), Activity (the audit lines the Host wrote, and Export), and, in a second test, Managed from a root-owned policy file the Host reads, with its locked controls. Remove asks first (Cancel keeps the device, Remove takes it). Every section is also shot in light and dark for the owner's visual pass (machine-page-<section>-<theme>.png in the results). Not pressed: Update from the page (an out-of-date Host is the rig's own state, and host-update-remove.spec.ts presses the row's Update), the phone's "Use from" switch (needs a phone paired with this Mac: tests/phoneMachinePage.test.ts) and Relay as the connection choice (this runner has no relay path).
// It turns on sshd and writes the user's ssh config, so it runs only on a CI runner. Named on the command line only: `node scripts/ci-cuj.mjs --spec tests/e2e/host-machine-page-real.spec.ts`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openConnections } from './fixtures/settings';
import { SYSTEM_THEME, shootBoth } from './fixtures/shoot';
import { REMOTE_FOLDER, REMOTE_ID, type RemoteHost, connectRemote, machineName, sshToSelf, startRemoteHost } from './fixtures/remoteHost';

const HOME = os.homedir();
/** The name the seed gives the machine; once paired the app lists it by the name the machine gives itself (`machineName`). */
const SEED_NAME = 'localhost';
const UP = /Online|Host is out of date|Host differs from this app/;
let remote: RemoteHost;

test.setTimeout(10 * 60_000);
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
  harnesses: 'claude',
  env: { MOPILOT_HOST_DEV: '1', MOPILOT_FLAGS: 'host.machinePage=1', HOME },
  seed: {
    uiState: { prefs: SYSTEM_THEME.prefs },
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            id: 'ssh:runner@localhost',
            name: SEED_NAME,
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

/** The machine's page, opened from its row in Settings › My machines. */
async function openPage(page: Page) {
  const mine = page.getByRole('region', { name: 'Machines' });
  // Settings stays open when the page closes
  if (!(await mine.isVisible())) await openConnections(page);
  const name = await machineName(page);
  const row = mine.locator('.machine-item', { has: page.locator('.machine-name', { hasText: name }) });
  // the rig's Host is built from this checkout, so the app may call it out of date (the page then offers Update)
  await expect(row.locator('.machine-status')).toContainText(UP, { timeout: 45_000 });
  await row.getByRole('button', { name: `${name}, open its page` }).click();
  const dialog = page.locator('.dialog');
  await expect(dialog.locator('.dialog-head')).toContainText(name);
  return dialog;
}

/** A Select by its label: opens it and takes the option. */
async function choose(page: Page, label: string, option: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.locator('[role=menu]').getByText(option, { exact: true }).click();
}

/** What this Mac kept (the owner's document) and what the Host says of itself now. */
const kept = (page: Page) => page.evaluate(() => window.native.host.ownerPolicy());
const hostSays = (page: Page) => page.evaluate((id) => window.native.host.hostStatus(id) as Promise<any>, REMOTE_ID);

/** What went wrong on the Host's side of a check, named, so one run shows every such problem and the rest of the page still gets its turn. */
const problems: string[] = [];
const softly = async (name: string, check: () => Promise<unknown>) => {
  try {
    await check();
  } catch (error) {
    problems.push(
      `${name}: ${String((error as Error).message)
        .split('\n')
        .slice(0, 3)
        .join(' ')}`,
    );
  }
};

test('every control of a machine’s page does its work on a real Host, and the Host keeps it', async ({ page, harness }) => {
  await connectRemote(page, remote, 'claude');
  // a second Mac and a phone the Host knows besides this app
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-page-client-'));
  const made = JSON.parse(
    execFileSync(
      process.execPath,
      [
        path.join(__dirname, 'fixtures', 'hostPairClient.mjs'),
        remote.socketPath,
        path.join(dir, 'identity.json'),
        'Studio Mac',
        remote.code(),
        'Pocket iPhone',
      ],
      { encoding: 'utf8' },
    ),
  );
  expect(made.phone).toMatch(/^[0-9a-f]{64}$/);

  const dialog = await openPage(page);

  await test.step('the page opens at Status, with nothing cut off under the title', async () => {
    const head = (await dialog.locator('.dialog-head').boundingBox())!;
    const status = dialog.locator('.settings-group-title', { hasText: 'Status' });
    await expect(status).toBeInViewport();
    const first = (await status.boundingBox())!;
    expect(first.y, 'the Status title sits below the dialog title').toBeGreaterThanOrEqual(head.y + head.height);
    await shootBoth(page, harness.app, 'machine-page-open');
  });

  await test.step('the sections the Host has data for, in order', async () => {
    try {
      await expect(dialog.locator('.settings-group-title')).toHaveText(['Status', 'Devices', 'Rules', 'Spending', 'Activity']);
    } catch (error) {
      // what each read answered, so a missing section says which one
      for (const name of ['clients', 'audit', 'hostStatus'] as const) {
        const said = await page.evaluate(
          ([n, id]) =>
            (window.native.host as any)[n](id).then(
              (v: unknown) => JSON.stringify(v),
              (e: Error) => `refused: ${e.message}`,
            ),
          [name, REMOTE_ID],
        );
        await test.info().attach(`${name}.json`, { body: String(said).slice(0, 4000), contentType: 'application/json' });
        console.log(`PAGE-READ ${name} :: ${String(said).slice(0, 600)}`);
      }
      throw error;
    }
    await expect(dialog).toContainText(UP);
  });

  await test.step('Status: the connection choice, which is offered only where this Mac has a relay path', async () => {
    const select = page.getByRole('button', { name: 'Connection', exact: true });
    if ((await select.count()) === 0) {
      test
        .info()
        .annotations.push({ type: 'not-shown', description: 'Connection: no relay path on this runner, so the page offers no choice' });
      return;
    }
    const mode = () =>
      page.evaluate((id) => window.native.host.machines().then((r) => r.machines.find((m) => m.id === id)?.path?.mode), REMOTE_ID);
    await choose(page, 'Connection', 'SSH');
    await expect.poll(mode).toBe('ssh');
    await choose(page, 'Connection', 'Automatic');
    await expect.poll(mode).toBe('auto');
  });

  await test.step('Devices: this Mac, the second Mac and the phone; Remove takes the second Mac off the Host', async () => {
    const devices = dialog.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: 'Devices' }) });
    await expect(devices).toContainText('this Mac');
    await expect(devices).toContainText('Studio Mac · added');
    await expect(devices).toContainText('Pocket iPhone · added');
    await expect(devices.getByRole('button', { name: /^Remove / })).toHaveCount(2);
    await expect(devices.getByRole('switch')).toHaveCount(0);
    // Remove asks first, naming the device and the machine: Cancel keeps it, Remove takes it
    await devices.getByRole('button', { name: 'Remove Studio Mac' }).click();
    // the sheet is a second dialog on top of the machine's page
    const sure = page.locator('.dialog').last();
    await expect(sure.locator('.dialog-head')).toContainText('Remove Studio Mac');
    await expect(sure).toContainText(`Studio Mac loses its access to ${await machineName(page)} now`);
    await expect(sure).toContainText('new pairing code');
    await shootBoth(page, harness.app, 'machine-page-remove-sheet', { clip: (await sure.boundingBox())! });
    await sure.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.dialog')).toHaveCount(1);
    await expect(devices).toContainText('Studio Mac · added');
    expect((await page.evaluate((id) => window.native.host.clients(id), REMOTE_ID)).clients.map((c) => c.name)).toContain('Studio Mac');
    await devices.getByRole('button', { name: 'Remove Studio Mac' }).click();
    await sure.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(devices).not.toContainText('Studio Mac');
    await expect
      .poll(async () => (await page.evaluate((id) => window.native.host.clients(id), REMOTE_ID)).clients.map((c) => c.name).sort())
      .toEqual(expect.not.arrayContaining(['Studio Mac']));
    const after = (await page.evaluate((id) => window.native.host.clients(id), REMOTE_ID)).clients;
    expect(after.map((c) => c.name)).toContain('Pocket iPhone');
    expect(after.filter((c) => c.self)).toHaveLength(1);
  });

  await test.step('Rules: each control writes the owner’s document, which the Host takes', async () => {
    const generation = async () => (await hostSays(page)).policy.generation as string;
    const before = await generation();
    await choose(page, 'Most a chat may do', 'Ask first');
    await expect.poll(async () => (await kept(page)).permissionMax).toBe('default');
    await choose(page, 'Pause a run after', '10 min');
    await expect.poll(async () => (await kept(page)).approvals.pauseMinutes).toBe(10);
    for (const [label, key] of [
      ['Notify when a chat needs you', 'needsYou'],
      ['Notify when a run is done', 'done'],
      ['Notify when a run pauses', 'paused'],
    ] as const) {
      const was = (await kept(page)).notify[key];
      await dialog.getByRole('switch', { name: label }).click();
      await expect.poll(async () => (await kept(page)).notify[key]).toBe(!was);
    }
    await choose(page, 'Show in notifications', 'Full');
    await expect.poll(async () => (await kept(page)).notify.detail).toBe('full');
    await dialog.getByRole('switch', { name: 'Quiet hours' }).click();
    await expect.poll(async () => (await kept(page)).notify.quiet).toMatchObject({ start: '22:00', end: '07:00' });
    // the Host took the last document: this Mac's push reached it (what it answered is printed), and its policy generation moved
    const sent = await page.evaluate(async (id) => {
      const doc = await window.native.host.ownerPolicy();
      return (await window.native.host.setOwnerPolicy(doc)).machines.find((m) => m.id === id);
    }, REMOTE_ID);
    console.log(`PUSH ${JSON.stringify(sent)}`);
    test.info().annotations.push({ type: 'push-answer', description: JSON.stringify(sent) });
    await softly('the Host’s policy generation moved', () => expect.poll(generation).not.toBe(before));
  });

  await test.step('Spending: both limits, and the Host’s own total and limit', async () => {
    await choose(page, 'Daily limit', '$5');
    await expect.poll(async () => (await kept(page)).spend?.dayUsd).toBe(5);
    await softly('the Host’s daily limit is 5', () => expect.poll(async () => (await hostSays(page)).spend.dayLimitUsd).toBe(5));
    await choose(page, 'Limit per chat', '$10');
    await expect.poll(async () => (await kept(page)).spend?.chatUsd).toBe(10);
    await expect(dialog.getByRole('meter', { name: 'Spent today' })).toBeVisible();
    await choose(page, 'Daily limit', 'None');
    await softly('the Host’s daily limit is none', () => expect.poll(async () => (await hostSays(page)).spend.dayLimitUsd).toBeNull());
  });

  await test.step('Activity: the Host’s audit lines, and Export saves them', async () => {
    await page.keyboard.press('Escape');
    const again = await openPage(page);
    const activity = again.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: 'Activity' }) });
    // plain words, with who where the Host says; repeats within a minute are one row
    await expect(activity).toContainText('Device removed: Studio Mac');
    await expect(activity).toContainText('Phone added: Pocket iPhone');
    await expect(activity).toContainText(/Rules changed( · \d+ times)?/);
    // the Host names no one for a rules change, only the kind of client
    await expect(activity).toContainText('from a computer');
    await expect(activity).not.toContainText('policy.changed');
    await page.evaluate(() => {
      const w = window as any;
      w.__saved = { blobs: [] as Blob[], names: [] as string[] };
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (b: Blob) => (w.__saved.blobs.push(b), create(b));
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        w.__saved.names.push(this.download);
        return click.call(this);
      };
    });
    await activity.getByRole('button', { name: 'Export' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__saved.names)).toEqual([`${await machineName(page)}-activity.txt`]);
    const text = await page.evaluate(() => (window as any).__saved.blobs[0].text() as Promise<string>);
    expect(text).toContain('policy.changed');
    expect(text).toContain('client.removed');
    // what was set stays set when the page is opened again
    await expect(again.getByRole('button', { name: 'Most a chat may do', exact: true })).toContainText('Ask first');
    await expect(again.locator('.settings-group-title')).toHaveText(['Status', 'Devices', 'Rules', 'Spending', 'Activity']);
  });

  await test.step('Visual pass: every section, light and dark', async () => {
    await choose(page, 'Daily limit', '$20');
    await expect.poll(async () => (await hostSays(page)).spend.dayLimitUsd).toBe(20);
    for (const title of ['Status', 'Devices', 'Rules', 'Spending', 'Activity']) {
      const group = dialog.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: title }) });
      await group.scrollIntoViewIfNeeded();
      const clip = (await group.boundingBox())!;
      await shootBoth(page, harness.app, `machine-page-${title.toLowerCase()}`, { clip });
    }
    await page.keyboard.press('Escape');
    await openPage(page);
  });

  await test.step('Reconnect: the Host restarts and the page finds it again', async () => {
    await page.keyboard.press('Escape');
    await remote.restart();
    await expect
      .poll(
        () => page.evaluate((id) => window.native.host.machines().then((r) => r.machines.find((m) => m.id === id)?.status), REMOTE_ID),
        { timeout: 120_000 },
      )
      .toBe('online');
    const back = await openPage(page);
    await expect(back.locator('.settings-group-title')).toHaveText(['Status', 'Devices', 'Rules', 'Spending', 'Activity']);
    await expect(back).toContainText(UP);
  });

  expect(problems, 'what the Host did not take').toEqual([]);
});

const MANAGED_DIR = process.platform === 'darwin' ? '/Library/Application Support/MoPilot Host' : '/etc/mopilot-host';
const MANAGED_FILE = path.join(MANAGED_DIR, 'managed-policy.json');
const sudo = (...args: string[]) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' });
const hadManagedDir = fs.existsSync(MANAGED_DIR);
test.afterAll(() => {
  // the stand-in policy goes whatever the test did
  try {
    sudo('rm', '-f', MANAGED_FILE);
    if (!hadManagedDir) sudo('rmdir', MANAGED_DIR);
  } catch {
    // no sudo here: nothing was installed
  }
});

test('Managed: an organization’s policy file the Host reads shows its name, locks the controls it fixes, and says so in the page', async ({
  page,
  harness,
}) => {
  // a stand-in organization: root owns the file, as the Host trusts only that
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-managed-'));
  const file = path.join(dir, 'managed-policy.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      organization: 'Acme',
      permission: { max: 'default' },
      spend: { dayUsdMax: 20 },
      hosts: { approvals: { pauseMinutesMax: 60 } },
    }),
  );
  const group = process.platform === 'darwin' ? 'wheel' : 'root';
  sudo('install', '-d', '-m', '755', '-o', 'root', '-g', group, MANAGED_DIR);
  sudo('install', '-m', '644', '-o', 'root', '-g', group, file, MANAGED_FILE);
  fs.rmSync(dir, { recursive: true, force: true });
  // the Host reads the file as it starts
  await remote.restart();
  await connectRemote(page, remote, 'claude');
  const dialog = await openPage(page);
  await expect(dialog.locator('.settings-group-title')).toHaveText(['Status', 'Devices', 'Rules', 'Spending', 'Activity', 'Managed']);
  const managed = dialog.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: 'Managed' }) });
  await expect(managed).toContainText('Managed by Acme');
  await expect(managed).toContainText('Most a chat may do');
  await expect(managed).toContainText('Spending limits');
  // each locked control says who locks it, and a change to one is refused by the Host's rules, not taken
  const rules = dialog.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: 'Rules' }) });
  await expect(rules.locator('.settings-row', { hasText: 'Most a chat may do' })).toContainText('Managed by Acme');
  await expect(rules.locator('.settings-row', { hasText: 'Pause a run after' })).toContainText('Managed by Acme');
  const spending = dialog.locator('.settings-group', { has: page.locator('.settings-group-title', { hasText: 'Spending' }) });
  await expect(spending.locator('.settings-row', { hasText: 'Daily limit' })).toContainText('Managed by Acme');
  await expect.poll(async () => ((await hostSays(page)).policy as any).organization).toBe('Acme');
  await managed.scrollIntoViewIfNeeded();
  await shootBoth(page, harness.app, 'machine-page-managed', { clip: (await managed.boundingBox())! });
  await rules.scrollIntoViewIfNeeded();
  await shootBoth(page, harness.app, 'machine-page-rules-managed', { clip: (await rules.boundingBox())! });
});
