// MoMo's replies run at the effort picked on its brain chip (#2139), on fake Claude Code and fake Codex: More in the chip's
// menu opens the model picker's effort panel, an arrow key moves the effort one level, the chip names it, and the next
// turn MoMo's main chat runs carries it (the CLI's effort on Claude Code, turn/start's on Codex), through a window reload.
import { test, expect } from './fixtures/app';
import { codexCliLogin } from './fixtures/codexAccounts';
import { momoChatSession, momoReply, openMomo } from './fixtures/momo';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

/** The effort each Claude Code turn whose text has `text` ran at: its CLI's --effort, as a later apply_flag_settings left it. */
function claudeEfforts(log: any[], text: string) {
  const now = new Map<number, string | null>();
  const out: (string | null)[] = [];
  for (const e of log) {
    if (e.kind === 'argv' && Array.isArray(e.argv)) {
      const i = e.argv.indexOf('--effort');
      now.set(e.pid, i >= 0 ? e.argv[i + 1] : null);
    }
    const level = e.kind === 'in' && e.msg?.request?.subtype === 'apply_flag_settings' ? e.msg.request.settings?.effortLevel : undefined;
    if (level !== undefined) now.set(e.pid, level);
    if (e.kind === 'turn' && String(e.text).includes(text)) out.push(now.get(e.pid) ?? null);
  }
  return out;
}

/** The effort each Codex turn/start whose input has `text` asked for. */
const codexEfforts = (log: any[], text: string) =>
  log.filter((e) => e.method === 'turn/start' && JSON.stringify(e.params?.input).includes(text)).map((e) => e.params?.effort ?? null);

function journey(harnesses: 'claude' | 'codex') {
  const fake = harnesses === 'claude' ? 'fake-claude' : 'fake-codex';
  // the fakes' models: Claude Code's Opus offers low, medium and high (default high); Codex's model one low and medium (default medium)
  const [from, to] = harnesses === 'claude' ? ['High', 'Medium'] : ['Medium', 'Low'];
  test.describe(`on ${harnesses === 'claude' ? 'Claude Code' : 'Codex'}`, () => {
    test.use({ harnesses, env: { MOPILOT_MOMO_DEV: '1' }, seed: { files: (d) => codexCliLogin(d) } });

    test('an effort picked on the brain chip is the one MoMo’s next turn runs at, after a reload too', async ({ page, harness }) => {
      test.setTimeout(240_000);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      const say = async (text: string) => {
        await send(text);
        await expect(chat.getByText(momoReply(fake, text))).toBeVisible({ timeout: 30_000 });
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      };
      // MoMo's greeting has ended (its composer takes focus back when a turn ends)
      await expect(chat.getByText(new RegExp(`${fake}: `)).first()).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      const chip = chat.getByRole('button', { name: "MoMo's brain" });
      await expect(chip).toContainText(from);
      await chip.click();
      // the harness list ends with More, which names the effort now
      const more = page.locator('.hp-more-row');
      await expect(more).toContainText(from);
      await more.click();
      const panel = page.locator('.effort-pop');
      await expect(panel.locator('.effort-name')).toHaveText(from);
      await expect(panel).toContainText("For MoMo's replies. Background work stays on Low.");
      // from the keyboard: an arrow on the panel moves one level down
      await panel.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(panel.locator('.effort-name')).toHaveText(to);
      await expect(chip).toContainText(to);
      await page.keyboard.press('Escape');
      await say('effort before the reload');

      await page.reload();
      await openMomo(page);
      await momoChatSession(page);
      await expect(chat.getByRole('button', { name: "MoMo's brain" })).toContainText(to);
      await say('effort after the reload');

      const want = to.toLowerCase();
      const ran = (text: string) =>
        harnesses === 'claude' ? claudeEfforts(harness.claudeLog(), text) : codexEfforts(harness.codexLog(), text);
      expect(ran('effort before the reload')).toEqual([want]);
      expect(ran('effort after the reload')).toEqual([want]);
      await page.screenshot({ path: test.info().outputPath(`momo-brain-effort-${harnesses}.png`) });
    });

    test('a message sent right after each pick runs at that pick, six times over (#3907)', async ({ page, harness }) => {
      test.setTimeout(300_000);
      await openMomo(page);
      const { chat, send } = await momoChatSession(page);
      await expect(chat.getByText(new RegExp(`${fake}: `)).first()).toBeVisible({ timeout: 30_000 });
      await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
      const chip = chat.getByRole('button', { name: "MoMo's brain" });
      const picked: [string, string][] = [];
      for (let i = 0; i < 6; i++) {
        // alternate between the two levels; the chip moves at once, and the message goes the moment it does
        const level = i % 2 === 0 ? to : from;
        await chip.click();
        await page.locator('.hp-more-row').click();
        const panel = page.locator('.effort-pop');
        await panel.focus();
        await page.keyboard.press(i % 2 === 0 ? 'ArrowLeft' : 'ArrowRight');
        await expect(chip).toContainText(level);
        await page.keyboard.press('Escape');
        const text = `rapid pick ${i}`;
        await send(text);
        await expect(chat.getByText(momoReply(fake, text))).toBeVisible({ timeout: 30_000 });
        await expect(chat.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 30_000 });
        picked.push([text, level.toLowerCase()]);
      }
      for (const [text, level] of picked) {
        const ran = harnesses === 'claude' ? claudeEfforts(harness.claudeLog(), text) : codexEfforts(harness.codexLog(), text);
        expect(ran, text).toEqual([level]);
      }
    });
  });
}

journey('claude');
journey('codex');
