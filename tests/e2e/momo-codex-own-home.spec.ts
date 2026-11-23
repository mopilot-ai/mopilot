// MoMo's Codex chat across an app restart (#2326), on fake Codex: its thread runs on MoMo's own app-server, so its rollout is
// written in MoMo's CODEX_HOME (<userData>/momo/codex-home), never the user's; after the restart the next message resumes
// that thread there and is answered, and nothing of it lands in the user's home.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { goToMomoView, momoChat, momoSeed, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.use({ harnesses: 'codex', env: { MOPILOT_MOMO_DEV: '1', FAKE_CODEX_ROLLOUTS: '1' }, ...momoSeed('codex') });

/** Every rollout file under a Codex home's sessions folder. */
function rollouts(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.startsWith('rollout-')) out.push(f);
    }
  };
  walk(home);
  return out;
}

test('a MoMo Codex chat keeps its rollout in MoMo’s home and still runs after a restart', async ({ page, harness }) => {
  test.setTimeout(240_000);
  const userData = harness.env.MOPILOT_USER_DATA ?? path.join(harness.dir, 'userData');
  const momoHome = path.join(userData, 'momo', 'codex-home');
  const userHome = harness.env.CODEX_HOME ?? path.join(harness.env.HOME ?? harness.dir, '.codex');
  await openMomo(page);
  await goToMomoView(page, 'Chat');
  const first = momoChat(page);
  await first.getByRole('textbox', { name: 'Message', exact: true }).fill('first note for momo');
  await first.getByRole('button', { name: 'Send', exact: true }).click();
  const turns = (text: string) =>
    harness
      .codexLog()
      .filter((e) => e.method === 'turn/start')
      .some((e: any) => JSON.stringify(e.params?.input).includes(text));
  await expect.poll(() => turns('first note for momo'), { timeout: 30_000 }).toBe(true);
  // its thread is recorded in MoMo's home, and the user's holds none of it
  // wherever the fake wrote it (the message names every rollout under the profile if it is not MoMo's home)
  try {
    await expect.poll(() => rollouts(harness.dir).length, { timeout: 20_000 }).toBeGreaterThan(0);
  } catch (error) {
    const starts = harness
      .codexLog()
      .filter((e: any) => /^thread\/(start|resume)$/.test(e.method))
      .map((e: any) => ({ m: e.method, keys: Object.keys(e.params ?? {}), eph: e.params?.ephemeral }));
    const files = (fs.readdirSync(harness.dir, { recursive: true }) as string[]).filter((f) => /codex|sessions|rollout|state/.test(f));
    const turnThreads = harness
      .codexLog()
      .filter((e: any) => e.method === 'turn/start')
      .map((e: any) => e.params?.threadId);
    const saved = fs
      .readdirSync(harness.dir)
      .filter((f) => f.endsWith('.state.json'))
      .map((f) => ({
        f,
        threads: JSON.parse(fs.readFileSync(path.join(harness.dir, f), 'utf8')).map((r: any) => ({
          id: r.thread.id,
          turns: r.turns.length,
        })),
      }));
    throw new Error(
      `no rollout under ${harness.dir}; seen ${JSON.stringify(seen)}; flag ${harness.env.FAKE_CODEX_ROLLOUTS}; starts ${JSON.stringify(starts)}; turn threads ${JSON.stringify(turnThreads)}; saved ${JSON.stringify(saved)}; files ${files.join(' | ')}`,
      { cause: error },
    );
  }
  expect(rollouts(harness.dir).map((f) => path.relative(harness.dir, f))).toEqual(
    rollouts(momoHome).map((f) => path.relative(harness.dir, f)),
  );
  expect(rollouts(userHome)).toEqual([]);

  await harness.quit();
  await harness.relaunch();
  const next = harness.page;
  await openMomo(next);
  await goToMomoView(next, 'Chat');
  const chat = momoChat(next);
  await chat.getByRole('textbox', { name: 'Message', exact: true }).fill('second note for momo');
  await chat.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => turns('second note for momo'), { timeout: 30_000 }).toBe(true);
  await expect(chat.getByText(/no rollout found/i)).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Retry' })).toHaveCount(0);
  expect(rollouts(userHome)).toEqual([]);
});
