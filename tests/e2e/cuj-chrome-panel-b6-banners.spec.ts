// CUJ chrome-panel-b6-banners on Claude Code, Codex and an ACP harness, with Google Chrome and MoPilot's real extension (#3046): an error is a banner above the composer
// (docs/chrome-panel-parity/design.md row 12): danger colours, a 14px top radius, 0.15 s enter and exit, a dismiss X, a Retry link for a
// lost connection that sends the message once, and one banner at a time (the error before the usage limit).
//
// The failure is injected where the panel hands a request to the background: the first send of the follow-up comes back as the background's own answer for a lost
// connection ({ error, code: 'panel_connection' }). Everything after is real: the banner, its animation in Chrome, Retry, and the resend that reaches the app and the fake harness.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';
import { submitNativePanel } from './fixtures/nativePanelSend.mjs';

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

test.describe.configure({ timeout: 300_000 });

const FOLLOW_UP = 'Follow-up after the connection dropped';

/** Per harness: what the fixture launches and the id of its entry in the panel's harness menu. */
const HARNESSES = [
  { label: 'Claude Code', id: 'claude', use: { harnesses: 'claude' as const } },
  { label: 'Codex', id: 'codex', use: { harnesses: 'codex' as const } },
  // no Codex and a signed-out Claude: the only harness that can run a chat is the fake ACP agent
  { label: 'ACP', id: 'acp:opencode', use: { harnesses: 'none' as const, acp: { opencode: {} } } },
];

for (const h of HARNESSES)
  test.describe(h.label, () => {
    test.use(h.use);
    test(`chrome-panel-b6-banners on ${h.label}: an error is a banner with Retry and a dismiss X, it animates in 0.15 s, and it is the only one shown`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);

      // a first turn, so there is a chat to follow up in
      await side.inPanel(`(() => {
    const select = document.getElementById('harness'); select.value = ${JSON.stringify(h.id)}; select.dispatchEvent(new Event('change'));
    const text = document.getElementById('text'); text.value = 'Say hello'; text.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 90_000 }).toBe('Done');

      // the machine's own reduced-motion setting must not decide what is measured: the animation is checked with no preference, the snap with reduce (step 5)
      const motion = (value: 'no-preference' | 'reduce') =>
        side.emulateMedia([
          { name: 'prefers-reduced-motion', value },
          // the banner's colours are read in light
          { name: 'prefers-color-scheme', value: 'light' },
        ]);
      await motion('no-preference');

      // the fault, and a recorder of the banner's frames: opacity and height from the moment it is shown or hidden
      const installed = await side.inPanel(`(() => {
    const real = chrome.runtime.sendMessage.bind(chrome.runtime);
    const wrapper = (m, ...rest) => {
      if (m?.type === 'panel' && m.method === 'send') {
        if (globalThis.__faults > 0) {
          globalThis.__faults--;
          return Promise.resolve({ status: 'connected', error: "MoPilot isn't connected.", code: 'panel_connection' });
        }
        globalThis.__sends.push(m.params.text);
      }
      return real(m, ...rest);
    };
    chrome.runtime.sendMessage = wrapper;
    globalThis.__faults = 0;
    globalThis.__sends = [];
    globalThis.__frames = [];
    const error = document.getElementById('error');
    let was = error.hidden;
    new MutationObserver(() => {
      if (error.hidden === was) return;
      was = error.hidden;
      const started = performance.now();
      const kind = error.hidden ? 'exit' : 'enter';
      const first = error.getAnimations().map((a) => ({ property: a.transitionProperty, duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing }));
      let firstFrame = true;
      const step = () => {
        const s = getComputedStyle(error);
        globalThis.__frames.push({ kind, at: performance.now() - started, opacity: Number(s.opacity), height: parseFloat(s.height) || 0, display: s.display, first: firstFrame ? first : undefined });
        firstFrame = false;
        if (performance.now() - started < 450) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }).observe(error, { attributes: true, attributeFilter: ['hidden'] });
    return chrome.runtime.sendMessage === wrapper;
  })()`);
      expect(installed, 'the panel lets the spec stand in for the transport').toBe(true);
      const typeFollowUp = () => submitNativePanel(side, FOLLOW_UP);
      const settled = () => side.inPanel(`document.getElementById('error').getAnimations().length === 0`);

      // 1. a lost connection: the banner, with the message back in the box
      await side.inPanel(`globalThis.__faults = 1`);
      await typeFollowUp();
      await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`), { timeout: 30_000 }).toBe(false);
      await expect.poll(settled).toBe(true);
      const look = await side.inPanel(`(() => {
    const error = document.getElementById('error');
    const card = document.querySelector('.composer-card');
    const s = getComputedStyle(error);
    const e = error.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const retry = error.querySelector('.banner-retry');
    const x = error.querySelector('.banner-dismiss');
    return {
      text: error.querySelector('p')?.textContent,
      background: s.backgroundColor, color: s.color, fontSize: s.fontSize,
      radius: [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius],
      padding: [s.paddingTop, s.paddingRight, s.paddingLeft],
      transitionDuration: s.transitionDuration, easing: s.transitionTimingFunction, property: s.transitionProperty,
      insideCard: card.contains(error), above: e.top < c.top, overlap: Math.round(e.bottom - c.top),
      retry: retry && { text: retry.textContent, underline: getComputedStyle(retry).textDecorationLine },
      dismiss: x && { label: x.getAttribute('aria-label'), glyph: getComputedStyle(x, '::before').content },
      box: document.getElementById('text').value,
      alert: error.getAttribute('role'),
    };
  })()`);
      expect(look.text).toBe("MoPilot isn't connected.");
      expect(look.background).toBe('rgb(249, 237, 235)');
      expect(look.color).toBe('rgb(201, 51, 42)');
      expect(look.fontSize).toBe('12px');
      expect(look.radius).toEqual(['14px', '14px', '0px']);
      expect(look.padding).toEqual(['8px', '16px', '16px']);
      expect(
        look.transitionDuration.split(', ').every((d: string) => d === '0.15s'),
        look.transitionDuration,
      ).toBe(true);
      expect(
        look.easing.split(', ').every((d: string) => d === 'ease-out'),
        look.easing,
      ).toBe(true);
      expect(look.property).toContain('opacity');
      expect(look.property).toContain('height');
      expect(look.insideCard).toBe(false);
      expect(look.above).toBe(true);
      expect(look.overlap, 'the card overlaps the banner by its 16px corner radius').toBe(16);
      expect(look.retry).toEqual({ text: 'Retry', underline: 'underline' });
      expect(look.dismiss).toMatchObject({ label: 'Dismiss error' });
      expect(look.alert).toBe('alert');
      expect(look.box, 'the refused message is back in the box').toBe(FOLLOW_UP);
      await side.screenshot(info.outputPath('error-banner.png'));

      // the enter animation Chrome ran: opacity and height transitions of 150 ms, easeOut, from nothing to the banner's size
      const enter = await side.inPanel(`globalThis.__frames.filter((f) => f.kind === 'enter')`);
      expect(enter.length, 'frames were recorded while the banner entered').toBeGreaterThan(3);
      const running = enter[0].first as { property: string; duration: number; easing: string }[];
      expect(running.map((a) => a.property).sort(), JSON.stringify(running)).toEqual(expect.arrayContaining(['height', 'opacity']));
      expect(running.every((a) => a.duration === 150 && a.easing === 'ease-out')).toBe(true);
      expect(Math.min(...enter.map((f: any) => f.opacity)), 'it starts transparent').toBeLessThan(0.8);
      expect(Math.min(...enter.map((f: any) => f.height)), 'and short').toBeLessThan(enter.at(-1).height);
      expect(enter.at(-1).opacity).toBe(1);
      const full = enter.at(-1).height;
      const reachedAt = enter.find((f: any) => f.opacity === 1 && f.height === full)?.at;
      expect(reachedAt, JSON.stringify(enter)).toBeGreaterThan(80);
      // No wall-clock upper bound: the animation's own 150 ms duration and easing are asserted above and it must be settled,
      // while the frame times here also include any stall of a loaded runner (a 439 ms first-to-full gap failed in main-e2e, #3797).

      // 2. one banner at a time: a usage limit arrives (the data the chat's read carries) while the error shows, and waits behind it
      await side.inPanel(`(() => {
    const chat = document.getElementById('chat');
    chat.dataset.limitKey = 'b6'; chat.dataset.limitText = 'Usage limit reached on this account.';
  })()`);
      await expect.poll(() => side.inPanel(`document.getElementById('usage').hidden`)).toBe(false);
      await expect.poll(() => side.inPanel(`document.getElementById('usage').hasAttribute('data-yielded')`)).toBe(true);
      // (its display flips to none when its 0.15 s fade ends)
      await expect
        .poll(() => side.inPanel(`getComputedStyle(document.getElementById('usage')).display`), {
          message: 'the usage banner yields to the error',
        })
        .toBe('none');
      expect(await side.inPanel(`getComputedStyle(document.getElementById('error')).display`)).not.toBe('none');
      await side.screenshot(info.outputPath('error-over-usage.png'));

      // 3. Retry: the banner goes, the message is sent again once (the first send never reached the app), and the reply comes
      await side.click('#error .banner-retry');
      await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 90_000 }).toBe('Done');
      await expect
        .poll(
          () =>
            side.inPanel(
              `[...document.querySelectorAll('#rows .you')].filter((r) => r.textContent.includes(${JSON.stringify(FOLLOW_UP)})).length`,
            ),
          { timeout: 30_000 },
        )
        .toBe(1);
      await expect
        .poll(() => side.inPanel(`document.querySelectorAll('#rows .reply').length`), {
          timeout: 90_000,
          message: 'the harness answered the second message',
        })
        .toBeGreaterThanOrEqual(2);
      expect(await side.inPanel(`globalThis.__sends`), 'Retry sent the message once').toEqual([FOLLOW_UP]);
      expect(await side.inPanel(`document.getElementById('text').value`)).toBe('');
      // (a hidden panel draws no transition: Chrome is in front before the banner is read)
      await front.bringToFront();
      // the usage banner, no longer waiting behind an error, shows
      // (the chat's next read may clear the limit data again, so each look sets it first and the banner is read one fade later)
      const setLimit = `(() => {
        const chat = document.getElementById('chat');
        chat.dataset.limitKey = 'b6-again'; chat.dataset.limitText = 'Usage limit reached on this account.';
      })()`;
      try {
        await expect
          .poll(
            async () => {
              await side.inPanel(setLimit);
              return side.inPanel(
                `(() => { const u = document.getElementById('usage'); const s = getComputedStyle(u); return [u.hasAttribute('data-yielded'), s.display !== 'none', s.opacity].join(); })()`,
              );
            },
            { intervals: [400], timeout: 20_000 },
          )
          .toBe('false,true,1');
      } catch (e) {
        // what the banner was doing instead, for the run's report
        await info.attach('usage-state', {
          body: JSON.stringify(
            await side.inPanel(`(() => {
              const u = document.getElementById('usage'); const s = getComputedStyle(u);
              return { visibility: document.visibilityState, focus: document.hasFocus(), hidden: u.hidden, yielded: u.hasAttribute('data-yielded'), cls: u.className, style: u.getAttribute('style'),
                display: s.display, opacity: s.opacity, height: s.height, animations: u.getAnimations().map((a) => [a.transitionProperty, a.playState, a.currentTime]), limit: [document.getElementById('chat').dataset.limitKey, document.getElementById('chat').dataset.limitText] };
            })()`),
            null,
            2,
          ),
        });
        throw e;
      }
      const usage = await side.inPanel(`(() => {
    const s = getComputedStyle(document.getElementById('usage'));
    return { text: document.getElementById('usage-text').textContent, radius: [s.borderTopLeftRadius, s.borderBottomLeftRadius], padding: [s.paddingTop, s.paddingLeft] };
  })()`);
      expect(usage).toEqual({ text: 'Usage limit reached on this account.', radius: ['14px', '0px'], padding: ['8px', '16px'] });
      await side.screenshot(info.outputPath('usage-banner.png'));
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await side.inPanel(`globalThis.__sends.length`), 'nothing was sent again afterwards').toBe(1);

      // the exit Chrome ran: opacity back to 0 and the banner's height gone, then display none
      const exit = await side.inPanel(`globalThis.__frames.filter((f) => f.kind === 'exit')`);
      expect(exit.length).toBeGreaterThan(3);
      expect(exit[0].first.map((a: any) => a.duration)).toContain(150);
      expect(Math.min(...exit.map((f: any) => f.opacity)), 'it fades out').toBe(0);
      expect(exit.at(-1)).toMatchObject({ opacity: 0, display: 'none' });

      // 4. the dismiss X: another lost connection, then the X clears the banner and leaves the message in the box
      await side.inPanel(
        `(() => { globalThis.__faults = 1; document.getElementById('chat').dataset.limitKey = ''; document.getElementById('chat').dataset.limitText = ''; })()`,
      );
      await typeFollowUp();
      await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`), { timeout: 30_000 }).toBe(false);
      await expect.poll(settled).toBe(true);
      await side.click('#error .banner-dismiss');
      await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`)).toBe(true);
      expect(await side.inPanel(`document.getElementById('error').textContent`)).toBe('');
      expect(await side.inPanel(`document.getElementById('text').value`)).toBe(FOLLOW_UP);
      expect(await side.inPanel(`globalThis.__sends.length`), 'the X sent nothing').toBe(1);

      // 5. reduced motion: the same banner appears at once, with no transition
      await motion('reduce');
      await side.inPanel(`globalThis.__frames = []; globalThis.__faults = 1`);
      await typeFollowUp();
      await expect.poll(() => side.inPanel(`document.getElementById('error').hidden`), { timeout: 30_000 }).toBe(false);
      // (frames of the earlier banner may still be arriving: this banner's frames start at the one that carries its animations)
      const entering = `(() => { const all = globalThis.__frames.filter((f) => f.kind === 'enter'); return all.slice(all.findLastIndex((f) => f.first)); })()`;
      await expect.poll(() => side.inPanel(`${entering}.length`)).toBeGreaterThan(3);
      const snap = await side.inPanel(
        `({ frames: ${entering}.slice(0, 4), duration: getComputedStyle(document.getElementById('error')).transitionDuration })`,
      );
      expect(snap.duration).toBe('0s');
      expect(snap.frames[0].first.filter((a: any) => a.property === 'opacity' || a.property === 'height')).toEqual([]);
      expect(snap.frames.map((f: any) => f.opacity)).toEqual([1, 1, 1, 1]);
    });
  });
