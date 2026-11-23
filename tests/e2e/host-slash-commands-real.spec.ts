// e2e-runner: bench
// #4915, with REAL Claude Code, Codex and opencode behind a real-ssh Host: what typing "/" lists in a chat on the machine (the machine's own commands and skills, from its own folder and agent), recorded per agent with a picture, and one command or skill of the machine run from the menu. Observation first: what is listed is the machine's, so it is recorded, and only the things that must hold are asserted (nothing says "Reading…" or "Update Host…" once the machine answered, the machine's rows say where they come from, a row sends what a chat of that agent sends).
// VM only (MOPILOT_ACCEPT_VM=1, the machine's own agents signed in, never a developer's Mac): `scripts/vm-exec.sh --vm mopilot-work …` with the VM lock taken first. Named on the command line only.
import { test, expect } from './fixtures/app';
import { send } from './fixtures/mm3Journey';
import { AGENTS, REAL_USE, declareRealHost, evidence, main, nonce, startOn, stopButton, untilIdle } from './fixtures/realJourney';

test.skip(process.platform !== 'darwin', 'a basic harness is admitted only with sage-mcp, which builds only on macOS');
test.skip(!process.env.MOPILOT_ACCEPT_VM, 'the isolated VM only: it uses the real agents of the machine it runs on');

declareRealHost();
test.beforeEach(() => {
  test.skip(test.info().config.shard !== null, 'a bench: run it alone');
});
test.use({
  ...REAL_USE,
  seed: {
    userData: {
      'host-registry.json': {
        version: 1,
        hosts: [
          {
            // the VM's user is `admin`
            id: 'ssh:admin@localhost',
            name: 'localhost',
            address: 'admin@localhost',
            // where startRemoteHost puts the Host's socket (fixtures/remoteHost.ts REMOTE_SOCKET)
            socketPath: '/tmp/mm-remote-host/data/host.sock',
            capabilities: { shell: true },
            // the name this row was given: without it the machine takes its Host's computer name (#4930)
            renamed: true,
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

const composer = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: 'Message', exact: true });

const queued = (page: import('@playwright/test').Page) => page.getByRole('list', { name: 'Queued messages' });

/** The `/` menu on an empty message, once the machine has answered (the row that says it is reading is gone), as its rows' text. */
async function openMenu(page: import('@playwright/test').Page) {
  await composer(page).fill('');
  await composer(page).pressSequentially('/');
  const panel = page.locator('.slash-panel');
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText(/Reading /, { timeout: 60_000 });
  return panel.locator('.add-panel-item');
}

for (const agent of AGENTS) {
  test(`${agent.label} (real) on a real-ssh Host: "/" lists what the machine's agent offers, and one row runs`, async ({
    harness,
  }, testInfo) => {
    test.skip(!agent.bin, `no ${agent.id} on this machine`);
    const page = harness.page;
    await startOn(harness, agent, `Reply with exactly ACK-${agent.id}-${nonce} and nothing else.`);
    await expect(main(page)).toContainText(`ACK-${agent.id}-${nonce}`, { timeout: 240_000 });
    await untilIdle(page, 'the first turn');

    const rows = await openMenu(page);
    const all = await rows.evaluateAll((els) =>
      els.map((el) => ({
        title: el.querySelector('.add-panel-title')?.textContent ?? '',
        desc: el.querySelector('.add-panel-desc')?.textContent ?? '',
        scope: el.querySelector('.add-panel-scope')?.textContent ?? '',
        disabled: el.getAttribute('aria-disabled') === 'true',
      })),
    );
    const machines = all.filter((r) => /^on /.test(r.scope));
    console.log(
      `SC-RESULT ${agent.id} rows=${all.length} machineRows=${machines.length} :: ${all
        .map((r) => `${r.title}${r.scope ? ` [${r.scope}]` : ''}${r.disabled ? ' (disabled)' : ''}`)
        .join(' | ')
        .slice(0, 1500)}`,
    );
    await page.screenshot({ path: testInfo.outputPath(`${agent.id}-menu.png`) });
    await testInfo.attach(`${agent.id}-menu`, { path: testInfo.outputPath(`${agent.id}-menu.png`), contentType: 'image/png' });
    // once the machine answered, no row says it is still being read or that the Host cannot list
    await expect(page.locator('.slash-panel')).not.toContainText(/Update Host on|Could not reach/);

    if (agent.id === 'claude') {
      // Claude Code's catalog is the CLI's own: its commands are listed, from the machine
      expect(machines.length, 'the machine lists its Claude Code commands').toBeGreaterThan(0);
      const compact = rows.filter({ has: page.locator('.add-panel-title', { hasText: /^\/compact$/ }) });
      if (await compact.count()) {
        await compact.first().click();
        await expect(composer(page)).toHaveText('/compact ');
        await send(page, '/compact');
        // the machine took it: the message does not wait in the queue as a refusal
        await expect(queued(page), 'the message was refused, not run')
          .toHaveCount(0, { timeout: 60_000 })
          .catch(async (error) => {
            throw new Error(
              `/compact stayed in the queue: ${(
                await queued(page)
                  .innerText()
                  .catch(() => '')
              ).replaceAll('\n', ' | ')} / ${String(error).slice(0, 120)}`,
            );
          });
        await untilIdle(page, '/compact', 300_000);
        await evidence(page, 'claude-compact');
        await expect(page.locator('.turn-error')).toHaveCount(0);
      }
    } else if (agent.id === 'codex') {
      // Codex lists the skills of the folder; the VM may have none: then the menu has only the app's own rows
      const skill = machines.find((r) => !disabledOrApp(r));
      if (skill) {
        await rows
          .filter({ has: page.locator('.add-panel-title', { hasText: new RegExp(`^${skill.title}$`) }) })
          .first()
          .click();
        await expect(composer(page)).toHaveText(new RegExp(`^\\$${skill.title} $`));
        await send(page, `$${skill.title} Reply with exactly SKILL-${nonce} and nothing else.`);
        await expect(queued(page), 'the message was refused, not run').toHaveCount(0, { timeout: 60_000 });
        await untilIdle(page, 'the skill turn', 300_000);
        const shown = await evidence(page, 'codex-skill');
        // the message once, and the agent's answer to it
        expect(shown.split(`SKILL-${nonce}`).length - 1, 'the skill ran: the agent answered it').toBeGreaterThanOrEqual(2);
        await expect(page.locator('.turn-error')).toHaveCount(0);
      }
    }
    await page.keyboard.press('Escape');
    await expect(stopButton(page)).toHaveCount(0);
  });
}

const disabledOrApp = (r: { disabled: boolean; scope: string }) => r.disabled || !r.scope;
