// CUJ chrome-panel-b7-empty-state on Claude Code and Codex, with Google Chrome and MoPilot's real extension (#3046, B7): a new chat's
// panel shows the mark and the tip line over the message box, the line changes every 3 s (leave and enter, 0.2 s), it does not change
// under reduced motion, it stops once a message is sent, and a second new chat runs one cycle, not two.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let site = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Empty page</title><h1>Empty</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const LINES = ['Ask anything', 'Use / for commands', 'Type @ to mention a tab or chat'];

test.describe.configure({ timeout: 300_000 });
for (const kind of ['claude', 'codex'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`chrome-panel-b7-empty-state on ${kind}: the tip cycles over the box, stops with a message, and respects reduced motion`, async ({
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
      await side.inPanel(
        `(() => { const h = document.getElementById('harness'); h.value = ${JSON.stringify(kind)}; h.dispatchEvent(new Event('change')); })()`,
      );
      // the panel is hidden while the app window covers Chrome, and a hidden panel does not cycle: bring Chrome to the front first
      await front.bringToFront();
      const state = () => side.inPanel(`document.visibilityState`);
      await expect.poll(state).toBe('visible');
      // the runner's own setting is not the test's: motion is asked for explicitly
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

      // what the page shows, and the log of what the tip does from now on (its text, and the animation each leave and enter gets)
      await side.inPanel(`(() => {
        window.__tip = { log: [], phases: [] };
        const tip = document.getElementById('tip');
        new MutationObserver((records) => {
          for (const r of records) {
            if (r.type === 'attributes') {
              const phase = tip.dataset.phase;
              if (!phase) continue;
              const cs = getComputedStyle(tip);
              window.__tip.phases.push([phase, cs.animationName, cs.animationDuration, cs.animationTimingFunction, performance.now()]);
            } else window.__tip.log.push([tip.textContent, performance.now()]);
          }
        }).observe(tip, { attributes: true, attributeFilter: ['data-phase'], childList: true });
      })()`);
      const empty = await side.inPanel(`(() => {
        const r = (id) => document.getElementById(id).getBoundingClientRect();
        const mark = document.querySelector('#empty .empty-mark');
        const m = mark.getBoundingClientRect();
        const t = document.getElementById('text');
        const tip = document.getElementById('tip');
        return {
          emptyShown: !document.getElementById('empty').hidden,
          mark: { w: m.width, h: m.height, opacity: getComputedStyle(mark).opacity, cx: m.left + m.width / 2, vw: document.documentElement.clientWidth },
          line: tip.textContent,
          tipHidden: tip.hidden,
          ariaHidden: tip.getAttribute('aria-hidden'),
          events: getComputedStyle(tip).pointerEvents,
          color: getComputedStyle(tip).color,
          placeholder: t.getAttribute('placeholder'),
          label: t.getAttribute('aria-label'),
          box: { l: r('text').left, t: r('text').top, w: r('text').width },
          overlay: { l: r('tip').left, t: r('tip').top, w: r('tip').width },
          nativeHidden: getComputedStyle(t, '::placeholder').color,
        };
      })()`);
      info.annotations.push({ type: 'empty-state', description: JSON.stringify(empty) });
      await side.screenshot(info.outputPath('empty.png'));
      info.annotations.push({
        type: 'layout',
        description: JSON.stringify(
          await side.inPanel(`(() => {
            const t = document.getElementById('text');
            const tip = document.getElementById('tip');
            const w = tip.parentElement;
            const cs = (e) => { const c = getComputedStyle(e); return { display: c.display, position: c.position, margin: c.margin, transform: c.transform, alignSelf: c.alignSelf, gridArea: c.gridArea, height: c.height, top: c.top, lineHeight: c.lineHeight, fontSize: c.fontSize }; };
            const rect = (e) => { const r = e.getBoundingClientRect(); return [r.top, r.height]; };
            return { wrap: cs(w), wrapRect: rect(w), text: cs(t), textRect: rect(t), tip: cs(tip), tipRect: rect(tip), parent: cs(w.parentElement), html: w.outerHTML.slice(0, 400) };
          })()`),
        ),
      });
      expect(empty.emptyShown).toBe(true);
      expect(empty.mark.w).toBe(56);
      expect(empty.mark.h).toBe(56);
      expect(Number(empty.mark.opacity)).toBeCloseTo(0.3, 2);
      expect(Math.abs(empty.mark.cx - empty.mark.vw / 2)).toBeLessThan(2);
      expect(empty.tipHidden).toBe(false);
      expect(empty.line).toBe(LINES[0]);
      expect(empty.ariaHidden).toBe('true');
      expect(empty.events).toBe('none');
      // the box keeps its accessible name and hint; the overlay lies exactly over it, and the box's own placeholder is not drawn twice
      expect(empty.label).toBe('Message');
      expect(empty.placeholder).toBe(LINES[0]);
      expect(Math.abs(empty.overlay.l - empty.box.l)).toBeLessThan(1);
      expect(Math.abs(empty.overlay.t - empty.box.t)).toBeLessThan(1);
      expect(Math.abs(empty.overlay.w - empty.box.w)).toBeLessThan(1);
      expect(empty.nativeHidden).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
      await side.screenshot(info.outputPath('empty.png'));

      // the line changes: the greeting, "Use / for commands", the "@" tip, and round to the greeting
      const changes = async (): Promise<string[]> => {
        const log: [string, number][] = await side.inPanel(`window.__tip.log`);
        return log.map((l) => l[0]).filter((t, i, all) => i === 0 || t !== all[i - 1]);
      };
      await expect
        .poll(async () => (await changes()).join('|'), { timeout: 40_000 })
        .toContain([LINES[1], LINES[2], LINES[0], LINES[1]].join('|'));
      const phases: [string, string, string, string, number][] = await side.inPanel(`window.__tip.phases`);
      info.annotations.push({ type: 'tip-phases', description: JSON.stringify(phases) });
      // each change leaves for 0.2 s (tip-out) and then enters for 0.2 s (tip-in), ease-in-out
      expect(phases.slice(0, 2)).toEqual([
        ['out', 'tip-out', '0.2s', 'ease-in-out', expect.any(Number)],
        ['in', 'tip-in', '0.2s', 'ease-in-out', expect.any(Number)],
      ]);
      // one change every 3 s: the gap between leaves, with a tolerance for the runner
      const leaves = phases.filter((p) => p[0] === 'out').map((p) => p[4]);
      expect(leaves.length).toBeGreaterThanOrEqual(3);
      const gaps = leaves.slice(1).map((t, i) => t - leaves[i]);
      info.annotations.push({ type: 'tip-gaps-ms', description: JSON.stringify(gaps.map(Math.round)) });
      for (const gap of gaps) {
        expect(gap).toBeGreaterThan(2800);
        expect(gap).toBeLessThan(3600);
      }

      // reduced motion: the line still changes, with no leave or enter drawn
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      expect(await side.inPanel(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true);
      // a change already under way when the preference changed finishes first
      await front.waitForTimeout(600);
      const before = {
        phases: (await side.inPanel(`window.__tip.phases.length`)) as number,
        lines: (await changes()).length,
      };
      await expect.poll(async () => (await changes()).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(before.lines + 2);
      expect(await side.inPanel(`window.__tip.phases.length`)).toBe(before.phases);
      expect(await side.inPanel(`document.getElementById('tip').dataset.phase ?? ''`)).toBe('');
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

      // typing stops it; emptying the box starts it again at the greeting
      const type = (value: string) =>
        side.inPanel(
          `(() => { const t = document.getElementById('text'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input')); })()`,
        );
      await type('draft');
      expect(await side.inPanel(`document.getElementById('tip').hidden`)).toBe(true);
      const typed = (await side.inPanel(`window.__tip.log.length`)) as number;
      await front.waitForTimeout(3600);
      expect(await side.inPanel(`window.__tip.log.length`)).toBe(typed);
      await type('');
      expect(await side.inPanel(`document.getElementById('tip').hidden`)).toBe(false);
      expect(await side.inPanel(`document.getElementById('tip').textContent`)).toBe(LINES[0]);

      // a message sent: the chat opens, the tip goes, nothing runs behind it, and the box's own reply line shows
      await type('Say hello');
      await side.inPanel(`document.getElementById('composer').requestSubmit()`);
      await expect.poll(() => side.inPanel(`!document.getElementById('chat').hidden`), { timeout: 60_000 }).toBe(true);
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 90_000 }).toBe('Done');
      expect(await side.inPanel(`document.getElementById('tip').hidden`)).toBe(true);
      expect(await side.inPanel(`document.getElementById('empty').hidden`)).toBe(true);
      expect(await side.inPanel(`document.getElementById('text').getAttribute('placeholder')`)).toBe('Write a message…');
      const open = (await side.inPanel(`window.__tip.log.length`)) as number;
      await front.waitForTimeout(7000);
      expect(await side.inPanel(`window.__tip.log.length`)).toBe(open);
      await side.screenshot(info.outputPath('chat.png'));

      // a new chat again: the empty state is back at the greeting, and it runs one cycle (a leave every 3 s, not two timers)
      await side.inPanel(`document.getElementById('new').click()`);
      await expect.poll(() => side.inPanel(`!document.getElementById('empty').hidden`)).toBe(true);
      expect(await side.inPanel(`document.getElementById('tip').hidden`)).toBe(false);
      expect(await side.inPanel(`document.getElementById('tip').textContent`)).toBe(LINES[0]);
      const leavesBefore = (await side.inPanel(`window.__tip.phases.filter((p) => p[0] === 'out').length`)) as number;
      await front.waitForTimeout(10_000);
      const leavesAfter = (await side.inPanel(`window.__tip.phases.filter((p) => p[0] === 'out').length`)) as number;
      info.annotations.push({ type: 'second-cycle-leaves-in-10s', description: String(leavesAfter - leavesBefore) });
      // 10 s holds three changes of a 3 s cycle; two timers would make six
      expect(leavesAfter - leavesBefore).toBeGreaterThanOrEqual(2);
      expect(leavesAfter - leavesBefore).toBeLessThanOrEqual(4);
      await side.screenshot(info.outputPath('second-empty.png'));
    });
  });
