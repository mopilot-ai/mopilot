// CUJ chrome-panel-b3-timeline on Claude Code, Codex and an ACP harness, with Google Chrome and MoPilot's real extension (#3046, B3): a turn that works through several
// steps reads each step in its state (running while it waits for the user's OK, failed for a call that errors), shows only its last three steps
// while it runs, shimmers the working line, enters each new step with a 430ms motion, draws none of it under
// prefers-reduced-motion, and ends in a check. The fake harness is the one the worked-for spec uses; the colours and the look of the shimmer
// are not measured here, only that the stylesheet's durations are what the real panel computes.
// The same journey and assertions run on every harness; only how each fake is asked to call a tool differs (HARNESSES below).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let other: http.Server;
let site = '';
let otherSite = '';
let otherHost = '';
test.beforeAll(async () => {
  server = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Timeline page</title><h1>Timeline</h1>'),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  // a site the tab is not on: going there is what needs the user's OK, so the first step stays running until it is given
  other = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Other page</title><h1>Other</h1>'),
  );
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  otherSite = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`;
  otherHost = new URL(otherSite).host;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
  other.closeAllConnections();
  other.close();
});

test.describe.configure({ timeout: 300_000 });

/** opencode's session mode as ACP lists it (acp-composer-layout.spec.ts): mopilot-ask is "Ask for approval", mopilot-full "Full access". */
const ACP_MODE = {
  id: 'mode',
  name: 'Session Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'mopilot-full',
  options: [
    { value: 'mopilot-ask', name: 'mopilot-ask' },
    { value: 'mopilot-full', name: 'mopilot-full' },
  ],
};

/**
 * Per harness: what the fixture launches, the id of its entry in the panel's harness menu, and how its fake is asked to call one of
 * MoPilot's Chrome tools (each harness names it as its own CLI does; an ACP fake joins the server and the tool as opencode does).
 */
const HARNESSES = [
  {
    label: 'Claude Code',
    id: 'claude',
    use: { harnesses: 'claude' as const },
    call: (name: string, args: object) => `CUCALL mcp__mopilot_chrome__${name} ${JSON.stringify(args)}`,
  },
  {
    label: 'Codex',
    id: 'codex',
    use: { harnesses: 'codex' as const },
    call: (name: string, args: object) => `CUCALL chrome_${name} ${JSON.stringify(args)}`,
  },
  {
    label: 'ACP',
    id: 'acp:opencode',
    // no Codex and a signed-out Claude: the only harness that can run a chat is the fake ACP agent
    // (opencode's session modes are what its panel offers as permissions: the panel starts in Full access, the test asks for approval)
    use: { harnesses: 'none' as const, acp: { opencode: { configOptions: [ACP_MODE] } } },
    call: (name: string, args: object) => `MCPTOOL chrome_${name} ${JSON.stringify(args)}`,
  },
];

for (const h of HARNESSES)
  test.describe(h.label, () => {
    test.use(h.use);
    test(`chrome-panel-b3-timeline on ${h.label}: step states, a window of three, shimmer, enter motion, reduced motion, a check at the end`, async ({
      page,
      launchChrome,
      harness,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(site);
      const side = await chrome.sidePanel(welcome, front);
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
      await side.inPanel(
        `(() => { const h = document.getElementById('harness'); h.value = ${JSON.stringify(h.id)}; h.dispatchEvent(new Event('change')); })()`,
      );
      expect(await side.inPanel(`document.getElementById('harness').value`), 'the harness under test is the one chosen').toBe(h.id);
      const tabId = await welcome.evaluate(
        async (url) => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url).id,
        site,
      );
      // asking before acting: the first step waits for the user's OK, so it is seen running
      await expect
        .poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`))
        .toBe(true);
      await side.click('#perm');
      await expect
        .poll(() =>
          side.inPanel(`[...document.querySelectorAll('#perm-menu button')].some((b) => b.textContent.startsWith('Ask for approval'))`),
        )
        .toBe(true);
      const askIndex = await side.inPanel(
        `[...document.querySelectorAll('#perm-menu button')].findIndex((b) => b.textContent.startsWith('Ask for approval')) + 1`,
      );
      expect(askIndex).toBeGreaterThan(0);
      await side.click(`#perm-menu button:nth-of-type(${askIndex})`);

      // the runner's own setting is not the test's: motion is asked for explicitly (a Mac set to reduce motion would draw none)
      info.annotations.push({
        type: 'runner-reduced-motion',
        description: String(await side.inPanel(`matchMedia('(prefers-reduced-motion: reduce)').matches`)),
      });
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      expect(await side.inPanel(`matchMedia('(prefers-reduced-motion: no-preference)').matches`)).toBe(true);

      // what the panel draws as rows enter: a mark and the animation the real stylesheet gives it, read as each row is added
      await side.inPanel(`(() => {
    window.__motion = [];
    const note = (el) => {
      if (!el.dataset?.motion) return;
      const cs = getComputedStyle(el);
      window.__motion.push([el.dataset.motion, cs.animationName, cs.animationDuration]);
    };
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) { note(n); n.querySelectorAll?.('[data-motion]').forEach(note); }
    }).observe(document.getElementById('rows'), { subtree: true, childList: true });
  })()`);

      const call = h.call;
      const send = (text: string) =>
        side.inPanel(`(() => {
      const t = document.getElementById('text');
      t.value = ${JSON.stringify(text)};
      t.dispatchEvent(new Event('input'));
      document.getElementById('composer').requestSubmit();
    })()`);
      const text = (id: string) => side.inPanel(`document.getElementById('${id}')?.textContent ?? ''`);
      /** the lines of the steps (a step with a body is a <details>, its line the summary) */
      const stepLines = () =>
        side.inPanel(
          `[...document.querySelectorAll('#rows .step[data-label], #rows details.steps > .step[data-label]')].map((e) => [(e.querySelector('summary') ?? e).textContent, e.dataset.state ?? 'done'])`,
        );
      const visibleSteps = () =>
        side.inPanel(
          `[...document.querySelectorAll('#rows details.steps > .step:not(summary)')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().height > 0).length`,
        );
      const progressStyle = () =>
        side.inPanel(
          `(() => { const cs = getComputedStyle(document.getElementById('progress-text')); return [cs.animationName, cs.animationDuration, cs.animationTimingFunction]; })()`,
        );

      // five calls, the first of which waits for the user, one of which errors (a tab that is not there); SLOW keeps the turn running after them
      await send(
        [
          'CUSTEPS SLOW HOLDREPLY',
          call('navigate', { tabId, url: otherSite }),
          call('read_page', { tabId, filter: 'all' }),
          call('computer', { tabId, action: 'screenshot' }),
          call('read_page', { tabId: 987654, filter: 'all' }),
          call('read_page', { tabId, filter: 'all' }),
        ].join('\n'),
      );
      await expect
        .poll(() => side.inPanel(`document.getElementById('cards').textContent`), { timeout: 60_000 })
        .toContain('Allow in this chat');

      // waiting for the user: the step is running in the present tense, the panel is not shimmering (it waits on the user, not working)
      try {
        await expect.poll(() => stepLines(), { timeout: 30_000 }).toEqual([[`Opening ${otherHost}`, 'running']]);
      } catch (e) {
        // what the panel drew instead, for the run's report
        // the wire the fake agent saw and sent (an ACP agent's log: every JSON-RPC message and MCP call), for the run's report
        const wire = path.join(harness.dir, 'fake-acp-opencode.jsonl');
        if (fs.existsSync(wire)) await info.attach('acp-wire', { body: fs.readFileSync(wire, 'utf8').split('\n').slice(-120).join('\n') });
        await info.attach('panel-state', {
          body: JSON.stringify(
            await side.inPanel(
              `({ turn: document.getElementById('chat').dataset.turn, progress: document.getElementById('progress-text').textContent, rows: document.getElementById('rows').innerText, cards: document.getElementById('cards').innerText, error: document.getElementById('error').innerText, steps: [...document.querySelectorAll('#rows .step')].map((e) => e.outerHTML.slice(0, 600)) })`,
            ),
            null,
            2,
          ),
        });
        throw e;
      }
      expect(await side.inPanel(`document.getElementById('chat').dataset.turn`)).toBe('waiting');
      expect((await progressStyle())[0]).toBe('none');
      await side.screenshot(info.outputPath('waiting.png'));

      // the OK: the steps run through, then the turn goes on (it is held until stopped)
      await side.click('#cards button[data-choice="chat"]');
      // (the steps are on the user's Chrome, so the line says so)
      await expect.poll(() => text('progress-text'), { timeout: 90_000 }).toMatch(/^(Working…|Using your Chrome)$/);
      await expect
        .poll(() => side.inPanel(`document.querySelectorAll('#rows details.steps > .step:not(summary)').length`), { timeout: 90_000 })
        .toBe(5);
      expect(await side.inPanel(`document.getElementById('chat').dataset.turn`)).toBe('running');
      // each in the state it ended in: done in the past tense, the one that errored failed in Claude's words
      // (the fifth step's row exists before its result lands, so the lines are polled to their final states, not read once: #4171)
      const ended = [
        [`Opened ${otherHost}`, 'done'],
        ['Read the page', 'done'],
        ['Took a screenshot', 'done'],
        ['Couldn’t read the page', 'failed'],
        ['Read the page', 'done'],
      ];
      try {
        await expect.poll(() => stepLines(), { timeout: 30_000 }).toEqual(ended);
      } finally {
        info.annotations.push({ type: 'step-lines', description: JSON.stringify(await stepLines()) });
      }
      // the fold names the count and the latest; of its five steps only the last three show while the turn runs
      expect(await side.inPanel(`document.querySelector('#rows details.steps > summary').textContent`)).toBe('5 steps · Read the page');
      const visible = await visibleSteps();
      info.annotations.push({ type: 'visible-steps', description: `${visible} of 5 steps visible while running` });
      expect(visible).toBe(3);
      // opened, the fold shows all five
      await side.click('#rows details.steps > summary');
      await expect.poll(() => visibleSteps()).toBe(5);
      await side.click('#rows details.steps > summary');
      await expect.poll(() => visibleSteps()).toBe(3);
      await side.screenshot(info.outputPath('running.png'));

      // the working line shimmers: 3s
      const shimmer = await progressStyle();
      info.annotations.push({ type: 'shimmer', description: JSON.stringify(shimmer) });
      expect(shimmer.slice(0, 2)).toEqual(['shimmer-text', '3s']);
      // each step that came while the turn ran entered over 430ms
      const motion: string[][] = await side.inPanel(`window.__motion`);
      info.annotations.push({ type: 'enter-motion', description: JSON.stringify(motion) });
      expect(motion).toContainEqual(['enter', 'step-enter', '0.43s']);

      // under prefers-reduced-motion nothing animates
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      expect(await side.inPanel(`matchMedia('(prefers-reduced-motion: reduce)').matches`)).toBe(true);
      expect((await progressStyle())[0]).toBe('none');
      await side.emulateMedia([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
      await expect.poll(async () => (await progressStyle())[0]).toBe('shimmer-text');

      // Stop: the turn ended by the user, so the window ends with it (the closed fold shows its summary alone)
      await expect.poll(() => side.inPanel(`!document.getElementById('stop').hidden`)).toBe(true);
      await side.click('#stop');
      await expect.poll(() => text('progress-text'), { timeout: 60_000 }).toBe('Stopped');
      expect(await side.inPanel(`document.getElementById('chat').dataset.turn`)).toBe('idle');
      expect(await visibleSteps()).toBe(0);
      expect((await progressStyle())[0]).toBe('none');

      // the next turn finishes: a check circle at its end
      await send('Say hello');
      await expect.poll(() => text('progress-text'), { timeout: 90_000 }).toBe('Done');
      const check = await side.inPanel(
        `(() => { const cs = getComputedStyle(document.querySelector('#progress-dot')); return [document.getElementById('progress-dot').className, cs.width, cs.maskImage.slice(0, 12)]; })()`,
      );
      info.annotations.push({ type: 'check', description: JSON.stringify(check) });
      expect(check).toEqual(['dot ok', '14px', 'url("data:im']);
      await side.screenshot(info.outputPath('done.png'));
    });
  });
