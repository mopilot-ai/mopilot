// The actual native Chrome panel keeps earlier history when a later native turn exceeds the old reference budget, and renders Markdown within the narrow panel.
import { test, expect, pairWithAllow } from './fixtures/chromePairing';
import { completePanelFirstRun } from './fixtures/nativePanelWelcome';

// needs a Mac, so the PR check runs it on its macOS runner (scripts/e2e-select.mjs MAC_ONLY_SPEC)
test.skip(process.platform !== 'darwin', 'the harness reaches MoPilot’s tools through sage-mcp, which builds only on macOS');

test.describe.configure({ timeout: 240_000 });
for (const kind of ['codex', 'claude'] as const)
  test.describe(kind, () => {
    test.use({ harnesses: kind });
    test(`native panel readability on ${kind}: long native history retains earlier replies, tables and numbered lists`, async ({
      page,
      launchChrome,
    }, info) => {
      const chrome = await launchChrome();
      const welcome = await pairWithAllow(page, chrome);
      const front = await chrome.context.newPage();
      await front.goto(`data:text/html,<title>Panel readability ${kind}</title><h1>Readability fixture</h1>`);
      const side = await chrome.sidePanel(welcome, front);
      // Never call side.panel(): all reads and input below stay in the real side-panel target.
      await completePanelFirstRun(side);
      await expect.poll(() => side.inPanel(`document.getElementById('harness')?.options.length`)).toBeGreaterThan(0);
      await side.inPanel(
        `(() => { const h=document.getElementById('harness'); h.value=${JSON.stringify(kind)}; h.dispatchEvent(new Event('change')); })()`,
      );
      const send = (text: string) =>
        side.inPanel(`(() => {
        const text=document.getElementById('text'); text.value=${JSON.stringify(text)};
        text.dispatchEvent(new Event('input')); document.getElementById('composer').requestSubmit();
      })()`);
      await send('Earlier conversation marker');
      await expect
        .poll(() => side.inPanel(`[...document.querySelectorAll('#rows .reply')].map(e => e.textContent).join(' ')`), { timeout: 30_000 })
        .toContain('Earlier conversation marker');
      await expect.poll(() => side.inPanel(`document.getElementById('progress-text')?.textContent`)).toBe('Done');
      await send(
        'Formatting sample\n\n1. First\n\n2. Second\n\n3. Third\n\n| Item | Value |\n| --- | --- |\n| Cancel | Free |\n\n```text\n' +
          'x'.repeat(40_000) +
          '\n```',
      );
      const snapshot = () =>
        side.inPanel(`(() => {
        const rows=document.getElementById('rows'); const reply=[...rows.querySelectorAll('.reply')].at(-1);
        const chat=document.getElementById('chat');
        return { earlier: rows.textContent.includes('Earlier conversation marker'),
          tables: reply?.querySelectorAll('table').length ?? 0,
          items: [...(reply?.querySelectorAll('ol > li') ?? [])].map(e => e.textContent),
          values: [...(reply?.querySelectorAll('table td') ?? [])].map(e => e.textContent),
          horizontalOverflow: chat.scrollWidth > chat.clientWidth,
          nativeExcerpt: rows.textContent.includes('Native turn excerpt') };
      })()`);
      // Claude's real fixture streams eight characters every 15 ms: this 40k reply takes over 75 seconds.
      await expect.poll(snapshot, { timeout: 120_000 }).toEqual({
        earlier: true,
        tables: 1,
        items: ['First', 'Second', 'Third'],
        values: ['Cancel', 'Free'],
        horizontalOverflow: false,
        nativeExcerpt: false,
      });
      await info.attach('native-panel-readability.json', { body: JSON.stringify(await snapshot()), contentType: 'application/json' });
    });
  });
