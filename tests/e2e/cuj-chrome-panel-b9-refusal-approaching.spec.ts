// CUJ chrome-panel-b9-refusal-approaching on Claude Code, Codex and a basic (ACP) harness, with Google Chrome and MoPilot's real extension (#3046, B9): the refusal
// card ("Stopped by a safety check") and the usage banner's "approaching" state, above the composer (docs/chrome-panel-parity/design.md rows 12-13).
//
// The signals are MOCKED by the fake harnesses, not read from an exhausted account or a real refusal (tests/e2e/fixtures/fake-claude-limits.mjs, fake-codex-trouble.mjs,
// tests/fixtures/fake-acp-agent.mjs): "WARN" / "WARN7D" / "WARNCLEAR" in a message make the fake Claude CLI send an allowed_warning rate_limit_event (an allowed one per window to clear it) and
// the fake Codex app-server an account/rateLimits/updated; "REFUSE" ends the turn on the model's refusal (stop reason refusal; codexErrorInfo cyberPolicy; an ACP stopReason refusal).
// From there it is real: main reads each harness's own words, the chat's read carries `limitWarning` and a refusal note row, and the panel draws them. A basic harness has no
// usage-window signal: its chat shows no "approaching" banner, which is what this checks for it.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';
import { submitNativePanel } from './fixtures/nativePanelSend.mjs';
import { codexCliLogin } from './fixtures/codexAccounts';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Banner page</title><h1>Banner</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe.configure({ timeout: 360_000 });
for (const kind of ['claude', 'codex', 'acp'] as const)
  test.describe(kind, () => {
    // Codex's windows are the account pool's for the login serving the chat, so the pool needs the login a real Codex sign-in leaves behind (auth.json)
    test.use(
      kind === 'acp'
        ? { harnesses: 'claude', acp: { kimi: {} } }
        : kind === 'codex'
          ? { harnesses: 'codex', seed: { files: (d: Parameters<typeof codexCliLogin>[0]) => codexCliLogin(d) } }
          : { harnesses: 'claude' },
    );
    const harnessId = kind === 'acp' ? 'acp:kimi' : kind;
    // a basic harness gives no usage-window signal, so it cannot warn
    const warns = kind !== 'acp';

    test(`chrome-panel-b9-refusal-approaching on ${kind}: the approaching banner, the safety-check card, their priority and dismissal`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`[...document.getElementById('harness').options].map((o) => o.value)`)).toContain(harnessId);
      await side.inPanel(
        `(() => { const h = document.getElementById('harness'); h.value = ${JSON.stringify(harnessId)}; h.dispatchEvent(new Event('change')); })()`,
      );
      // the light colours are Claude's reference values; the runner's own reduced-motion setting must not decide the motion that is read
      await side.emulateMedia([
        { name: 'prefers-reduced-motion', value: 'no-preference' },
        { name: 'prefers-color-scheme', value: 'light' },
      ]);
      const send = (text: string) => submitNativePanel(side, text);
      const text = (id: string) => side.inPanel(`document.getElementById('${id}')?.textContent ?? ''`).catch(() => '');
      const hidden = (id: string) => side.inPanel(`document.getElementById('${id}').hidden`).catch(() => null);
      const yielded = (id: string) => side.inPanel(`document.getElementById('${id}').hasAttribute('data-yielded')`).catch(() => null);
      const line = () => text('progress-text');
      /** Sends a message and waits for its turn to end on `ends`. */
      const turn = async (message: string, ends: string) => {
        await send(message);
        try {
          await expect.poll(line, { timeout: 90_000, message: message }).toBe(ends);
        } catch (error) {
          // what the panel looked like, so a stuck line says why
          const seen = await side
            .inPanel(
              `JSON.stringify({ box: document.getElementById('text').value, sendDisabled: document.getElementById('send').disabled, error: document.getElementById('error').textContent, data: { ...document.getElementById('chat').dataset }, rows: document.getElementById('rows').innerText.slice(-700) })`,
            )
            .catch(() => 'unreadable');
          throw new Error(`${message}: line stayed "${await line()}" (wanted "${ends}"): ${seen}`, { cause: error });
        }
      };
      /** The composer stays open under a banner: with a message typed, the box and Send take it (Send is off while the box is empty). */
      const composerOpen = () =>
        side.inPanel(`(() => {
          const t = document.getElementById('text');
          t.value = 'a message typed under the banner'; t.dispatchEvent(new Event('input'));
          const open = !t.disabled && !document.getElementById('send').disabled && !document.getElementById('send').hidden;
          t.value = ''; t.dispatchEvent(new Event('input'));
          return open;
        })()`);

      // 1. nothing to say yet: no banner, no card
      await turn('Say hello', 'Done');
      expect(await hidden('usage')).toBe(true);
      expect(await hidden('refusal')).toBe(true);

      // 2. a window nearly used up: the info banner in Claude's words, the composer still open
      await turn('Say hello WARN', 'Done');
      if (!warns) {
        await front.waitForTimeout(2_000);
        expect(await hidden('usage'), 'a harness with no usage-window signal shows no approaching banner').toBe(true);
      } else {
        await expect.poll(() => hidden('usage'), { timeout: 30_000 }).toBe(false);
        expect(await text('usage-text')).toBe('5-hour limit almost used up');
        expect(await side.inPanel(`document.getElementById('usage').dataset.kind`)).toBe('approaching');
        expect(await side.inPanel(`document.getElementById('usage').getAttribute('role')`)).toBe('status');
        await expect.poll(composerOpen, { message: 'approaching does not block the composer', timeout: 30_000 }).toBe(true);
        expect(
          await side.inPanel(
            `getComputedStyle(document.getElementById('usage')).transitionDuration.split(', ').every((d) => d === '0.15s')`,
          ),
        ).toBe(true);
        await side.screenshot(info.outputPath('approaching-5h.png'));
        // dismissed with the X: gone, and it stays gone for this window through later turns
        await side.click('#usage-off');
        await expect.poll(() => hidden('usage')).toBe(true);
        await turn('Say hello', 'Done');
        expect(await hidden('usage')).toBe(true);

        // 3. the weekly window warns on its own, even after the five-hour one was dismissed
        await turn('Say hello WARN7D', 'Done');
        await expect.poll(() => hidden('usage'), { timeout: 30_000 }).toBe(false);
        expect(await text('usage-text')).toBe('Weekly limit almost used up');
        // the panel opened again with the warning standing: it reads it with the chat, though it saw no event
        await side.inPanel(`setTimeout(() => location.reload(), 0)`);
        await expect
          .poll(async () => (await hidden('usage')) === false && (await text('usage-text')), { timeout: 60_000 })
          .toBe('Weekly limit almost used up');
      }

      // 4. a refusal: "Stopped by a safety check" in the harness-neutral words, above the usage banner, the composer still open
      await turn('Please REFUSE this request', 'Stopped by a safety check');
      await expect.poll(() => hidden('refusal'), { timeout: 30_000 }).toBe(false);
      const card = await side.inPanel(`(() => {
        const el = document.getElementById('refusal');
        const s = getComputedStyle(el);
        return {
          title: el.querySelector('.refusal-title').textContent,
          body: el.querySelector('.refusal-body').textContent,
          background: s.backgroundColor, color: s.color, fontSize: s.fontSize,
          radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius],
          durations: s.transitionDuration, dismiss: document.getElementById('refusal-off').getAttribute('aria-label'),
          dot: document.getElementById('progress-dot').className,
        };
      })()`);
      expect(card.title).toBe('Stopped by a safety check');
      expect(card.body).toMatch(/^The agent's safety check stopped this chat\./);
      expect(card.background).toBe('rgb(249, 237, 235)');
      expect(card.color).toBe('rgb(201, 51, 42)');
      expect(card.fontSize).toBe('12px');
      expect(card.radius).toEqual(['14px', '14px', '0px']);
      expect(card.durations.split(', ').every((d: string) => d === '0.15s')).toBe(true);
      expect(card.dismiss).toBe('Dismiss notice');
      expect(card.dot).toBe('dot error');
      await expect.poll(composerOpen, { message: 'the refusal card does not block the composer', timeout: 30_000 }).toBe(true);
      // one banner at a time: the refusal takes the slot; the weekly warning waits behind it
      if (warns) {
        expect(await hidden('usage')).toBe(false);
        expect(await yielded('usage'), 'the refusal card is above the usage banner').toBe(true);
        await expect.poll(() => side.inPanel(`getComputedStyle(document.getElementById('usage')).display`)).toBe('none');
        expect(await yielded('refusal')).toBe(false);
      }
      await side.screenshot(info.outputPath('chat-paused.png'));

      // 5. the X dismisses the card; the warning behind it, if any, shows
      await side.inPanel(`(() => {
        const button = document.getElementById('refusal-off');
        const r = button.getBoundingClientRect();
        globalThis.__refusalDismissProbe = {
          before: { ...document.getElementById('chat').dataset },
          hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.outerHTML,
          clicks: []
        };
        document.addEventListener('click', (e) => {
          globalThis.__refusalDismissProbe.clicks.push({ target: e.target?.outerHTML, chat: { ...document.getElementById('chat').dataset } });
        }, { capture: true, once: true });
      })()`);
      await side.click('#refusal-off');
      try {
        await expect.poll(() => hidden('refusal')).toBe(true);
      } catch (error) {
        const observed = await side.inPanel(
          `JSON.stringify({ ...globalThis.__refusalDismissProbe, after: { ...document.getElementById('chat').dataset }, hidden: document.getElementById('refusal').hidden })`,
        );
        throw new Error(`The refusal dismissal did not persist: ${observed}`, { cause: error });
      }
      if (warns) {
        await expect.poll(() => yielded('usage')).toBe(false);
        expect(await text('usage-text')).toBe('Weekly limit almost used up');
        await side.screenshot(info.outputPath('approaching-7d.png'));
      }
      expect(await line(), 'the progress line still says the chat is paused').toBe('Stopped by a safety check');

      // 6. a new message: the card is for the refused turn only, the line is Done again
      await turn('Say hello', 'Done');
      expect(await hidden('refusal')).toBe(true);
      expect(await side.inPanel(`document.getElementById('chat').dataset.refusalKey`)).toBe('');
      // a second refusal shows its card again (the first was dismissed, not this one)
      await turn('REFUSE again', 'Stopped by a safety check');
      await expect.poll(() => hidden('refusal')).toBe(false);
      await turn('Say hello', 'Done');
      expect(await hidden('refusal')).toBe(true);

      // 7. the harness says the window is fine again: the banner goes without any message of ours about it
      if (warns) {
        await turn('Say hello WARNCLEAR', 'Done');
        await expect.poll(() => hidden('usage'), { timeout: 30_000 }).toBe(true);
      }
    });
  });
