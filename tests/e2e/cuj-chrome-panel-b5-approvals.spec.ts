// CUJ chrome-panel-b5-approvals (#3046), with Google Chrome and MoPilot's real extension: the plan-approval card shows the plan (folded past 12 lines, opened with Show more) and the site permission card has its wording and keys (Allow once on Enter, Decline on Esc), answered with real key presses in the native side panel.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import type { ExtensionChrome, NativePanel } from './fixtures/extensionChrome';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

let server: http.Server;
let other: http.Server;
let site = '';
let otherSite = '';
let thirdSite = '';
let third: http.Server;
const listen = async (title: string) => {
  const s = http.createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>${title}</title><h1>${title}</h1>`),
  );
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/` };
};
test.beforeAll(async () => {
  const a = await listen('B5 page');
  server = a.s;
  site = a.url;
  // a site the tab is not on: going there is what needs the user's OK
  const b = await listen('B5 other page');
  other = b.s;
  otherSite = b.url;
  const c = await listen('B5 third page');
  third = c.s;
  thirdSite = c.url;
});
test.afterAll(() => {
  for (const s of [server, other, third]) {
    s.closeAllConnections();
    s.close();
  }
});

test.describe.configure({ timeout: 240_000 });

/** Chrome with the extension paired and its side panel open on a tab at `site`, asking before acting. */
async function openPanel(page: Page, chrome: ExtensionChrome, kind: string) {
  const welcome = await pairWithAllow(page, chrome);
  const front = await chrome.context.newPage();
  await front.goto(site);
  const side = await chrome.sidePanel(welcome, front);
  await completePanelFirstRun(side);
  await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
  await side.inPanel(
    `(() => { const h=document.getElementById('harness'); h.value=${JSON.stringify(kind)}; h.dispatchEvent(new Event('change')); })()`,
  );
  const tabId = await welcome.evaluate(
    async (url) => (await (globalThis as any).chrome.tabs.query({})).find((t: any) => t.url === url).id,
    site,
  );
  // Full access is the default and asks for nothing: pick "Ask for approval" first (a closed menu's rows can't be clicked)
  await expect.poll(() => side.inPanel(`!document.getElementById('perm').hidden && !document.getElementById('perm').disabled`)).toBe(true);
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
  await expect.poll(() => side.inPanel(`document.getElementById('perm-menu').hidden`)).toBe(true);
  return { front, side, tabId };
}

const send = (side: NativePanel, text: string) =>
  side.inPanel(`(() => {
    const t = document.getElementById('text');
    t.value = ${JSON.stringify(text)};
    t.dispatchEvent(new Event('input'));
    document.getElementById('composer').requestSubmit();
  })()`);
const cards = (side: NativePanel) => side.inPanel(`document.getElementById('cards').textContent`);

for (const kind of ['codex', 'claude'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`chrome-panel-b5-approvals on ${kind}: the site card says "MoPilot needs your OK"; Escape declines, Enter allows this action`, async ({
      page,
      launchChrome,
    }, info) => {
      const { front, side, tabId } = await openPanel(page, await launchChrome(), kind);
      const navigate = `CUCALL ${kind === 'claude' ? 'mcp__mopilot_chrome__navigate' : 'chrome_navigate'} ${JSON.stringify({ tabId, url: otherSite })}`;
      await send(side, navigate);
      await expect.poll(() => cards(side), { timeout: 60_000 }).toContain('Allow once');
      const shown = await side.inPanel(`(() => {
        const card = document.querySelector('#cards .card');
        const label = (b) => [...b.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
        return {
          heading: card.querySelector('.kicker')?.textContent,
          note: card.querySelector('.note')?.textContent,
          choices: [...card.querySelectorAll('.choices button')].map((b) => b.dataset.choice + ':' + label(b) + ':' + (b.querySelector('kbd')?.textContent ?? '')),
        };
      })()`);
      expect(shown.heading).toBe('MoPilot needs your OK');
      expect(shown.note).toContain('before it buys anything, creates an account, or gets past a CAPTCHA');
      // the same choices as before under Claude's words: "Allow in this chat" stays (a local site has no standing grant)
      expect(shown.choices).toEqual(expect.arrayContaining(['once:Allow once:↵', 'chat:Allow in this chat:', 'deny:Decline:Esc']));
      await side.screenshot(info.outputPath('permission-card.png'));
      // Escape declines: the card goes, the tab stays where it was
      await side.inPanel(`document.activeElement?.blur?.()`);
      await side.press('Escape');
      await expect.poll(() => cards(side), { timeout: 30_000 }).toBe('');
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 60_000 }).toBe('Done');
      expect(front.url()).toBe(site);
      // another new site asks too, and Enter allows this action: the tab goes there (the declined site may stay declined for the chat)
      await send(side, navigate.replace(otherSite, thirdSite));
      await expect.poll(() => cards(side), { timeout: 60_000 }).toContain('Allow once');
      await side.inPanel(`document.activeElement?.blur?.()`);
      await side.press('Enter');
      await expect.poll(() => front.url(), { timeout: 60_000 }).toBe(thirdSite);
      await expect.poll(() => cards(side), { timeout: 30_000 }).toBe('');
      expect(await side.inPanel(`document.getElementById('error').textContent`)).toBe('');
    });
  });

test.describe('claude plan', () => {
  test.use({ harnesses: 'claude' });
  test('chrome-panel-b5-approvals on claude: the plan card shows the plan, folds past 12 wrapped lines and opens with Show more, and Approve plan answers it', async ({
    page,
    harness,
    launchChrome,
  }, info) => {
    const { front, side } = await openPanel(page, await launchChrome(), 'claude');
    // a first turn makes the chat, and the app's Plan mode chip (which the panel has no control for) puts it in plan mode
    await send(side, 'warm up');
    await expect
      .poll(() => side.inPanel(`document.getElementById('rows').textContent`), { timeout: 60_000 })
      .toMatch(/fake-claude:[\s\S]*warm up/);
    await expect.poll(() => side.inPanel(`document.getElementById('progress-text').textContent`), { timeout: 60_000 }).toBe('Done');
    await side.click('#more');
    await side.click('#app');
    await expect(page.getByRole('main')).toContainText(/fake-claude:[\s\S]*warm up/, { timeout: 30_000 });
    await page.getByRole('button', { name: 'Add files and more' }).click();
    await page.locator('.add-panel').getByText('Plan mode', { exact: true }).click();
    await expect(page.locator('.plan-chip')).toBeVisible();

    // plan mode is the app composer's chip (a panel send carries no plan flag), so the app sends this turn; the panel shows its plan card.
    // One long line wraps past 12 lines in the narrow panel, which is what the fold measures
    const filler = Array.from({ length: 160 }, (_, i) => `word${i + 1}`).join(' ');
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill(`PLAN add a hello file ${filler} ZEBRAEND`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    // sending from the app put its window over Chrome's, and a hidden panel gets no resize callbacks, so the fold would not measure
    await front.bringToFront();
    await expect.poll(() => cards(side), { timeout: 60_000 }).toContain('Look at the request: PLAN add a hello file');
    const plan = () =>
      side.inPanel(`(() => {
        const body = document.querySelector('#cards .plan');
        const more = document.querySelector('#cards .plan-more');
        // the card is rebuilt as the chat's state arrives: a read between two builds sees none
        if (!body || !more) return null;
        return {
          title: document.querySelector('#cards .q').textContent,
          text: body.textContent,
          first: body.querySelector('ol li')?.textContent,
          file: document.querySelector('#cards .plan-file')?.textContent,
          buttons: [...document.querySelectorAll('#cards .choices button')].map((b) => b.textContent),
          fold: more.hidden ? null : more.textContent,
          open: body.classList.contains('open'),
          shown: body.clientHeight,
          whole: body.scrollHeight,
          overflowY: getComputedStyle(body).overflowY,
          visibility: document.visibilityState,
          width: body.clientWidth,
        };
      })()`);
    // the fold button reads `want` (the card is rebuilt as the chat's state arrives, so a read may find none for a moment). When it
    // never does, the error says what the panel showed: the plan box's measures and what was in the cards
    const foldReads = async (want: string, timeout: number) => {
      try {
        await expect.poll(async () => (await plan())?.fold, { timeout }).toBe(want);
      } catch (error) {
        const shown = await side.inPanel(`({
          box: (() => { const b = document.querySelector('#cards .plan'); return b && { shown: b.clientHeight, whole: b.scrollHeight, width: b.clientWidth, open: b.classList.contains('open'), hiddenMore: document.querySelector('#cards .plan-more')?.hidden }; })(),
          cards: document.getElementById('cards').innerText.slice(0, 300),
          progress: document.getElementById('progress-text').textContent,
          visibility: document.visibilityState,
        })`);
        throw new Error(`the plan fold never read "${want}": ${JSON.stringify(shown)}\n${error}`);
      }
    };
    // the box is measured once it is on screen: more than 12 lines folds
    await expect.poll(() => side.inPanel(`document.visibilityState`), { timeout: 10_000 }).toBe('visible');
    await foldReads('Show more', 30_000);
    const folded = await plan();
    expect(folded.title).toBe('Ready to start on this plan?');
    expect(folded.first).toContain('Look at the request: PLAN add a hello file');
    expect(folded.file).toBe('Saved as fake-plan.md');
    expect(folded.buttons).toEqual(['Approve plan', 'Deny']);
    expect(folded.open).toBe(false);
    expect(folded.whole).toBeGreaterThan(folded.shown);
    await side.screenshot(info.outputPath('plan-folded.png'));
    await side.click('#cards .plan-more');
    await foldReads('Show less', 10_000);
    const opened = await plan();
    expect(opened.open).toBe(true);
    expect(opened.shown).toBeGreaterThan(folded.shown);
    expect(opened.overflowY).toBe('auto');
    expect(opened.text).toContain('ZEBRAEND');
    await side.screenshot(info.outputPath('plan-open.png'));
    await side.click('#cards .plan-more');
    await foldReads('Show more', 10_000);
    // Approve plan still answers the card
    await side.click('#cards button[data-choice="once"]');
    await expect.poll(() => side.inPanel(`document.getElementById('rows').textContent`), { timeout: 60_000 }).toContain('plan approved');
    await expect.poll(() => cards(side), { timeout: 30_000 }).toBe('');
    const answer = harness.claudeLog().find((e: any) => e.kind === 'plan') as any;
    expect(answer.response.behavior).toBe('allow');
  });
});
