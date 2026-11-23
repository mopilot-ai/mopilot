// A dictation that fails keeps its recording, says why on a row of its own above the composer's controls, and leaves
// those controls on their single row: in the real app against a fake MoPilot gateway that refuses the clip and a
// synthetic microphone. Before, the note wrapped the footer: the model, the note and the mic and send each took a row.
import http from 'node:http';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const GATEWAY_PORT = 39_824;
const REFUSAL = 'The test gateway refused this clip';

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const mic = (page: Page) => page.locator('.composer button[aria-label="Dictate"]');

/** A test tone as the microphone (Dictation.tsx reads window.__voiceTestStream instead of getUserMedia). */
async function syntheticMicrophone(page: Page) {
  await page.evaluate(() => {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const out = ctx.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    (window as any).__voiceTestStream = out.stream;
  });
}

const signedInWithCredits = {
  userData: {
    'mopilot-auth.json': {
      v: 1,
      enc: 'plain',
      data: Buffer.from(
        JSON.stringify({ refreshToken: 'r', gatewayKey: 'gw-test', user: { email: 'credits@example.test' }, deviceId: 'd' }),
      ).toString('base64'),
    },
  },
  // MoPilot credits alone, so the clip goes nowhere else
  uiState: { prefs: { dictationEngine: 'credits' } },
};

/** Each control's box in the composer's footer and the note's, as the window lays them out. */
const boxes = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const r = document.querySelector(`.composer ${selector}`)?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, left: r.left, right: r.right, mid: (r.top + r.bottom) / 2 } : null;
    };
    return {
      footer: box('.composer-footer'),
      left: box('.composer-left'),
      model: box('.model-btn'),
      mic: box('button[aria-label="Dictate"]'),
      note: box('.dictation-note'),
      editor: box('.composer-editor'),
    };
  });

test.describe('a dictation the service refuses', () => {
  test.use({ harnesses: 'codex', seed: signedInWithCredits, env: { MOPILOT_API: `http://127.0.0.1:${GATEWAY_PORT}` } });
  let gateway: http.Server;
  test.beforeAll(async () => {
    gateway = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url?.startsWith('/v1/audio/transcriptions')) {
        req.resume();
        return void res.writeHead(400).end(JSON.stringify({ error: { message: REFUSAL } }));
      }
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));
  });
  test.afterAll(() => new Promise<void>((r) => gateway.close(() => r())));

  test('keeps the recording, says why above the controls, and keeps the controls on one row', async ({ page }) => {
    await expect(composer(page)).toBeVisible();
    await syntheticMicrophone(page);
    await expect(mic(page)).toBeVisible();
    const before = await boxes(page);
    await mic(page).click();
    await expect(mic(page)).toHaveClass(/recording/);
    await page.waitForTimeout(600);
    await mic(page).click();
    const note = page.locator('.composer .dictation-note');
    await expect(note).toContainText(`Recording retained. ${REFUSAL}`, { timeout: 20_000 });
    await expect(note.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(note.getByRole('button', { name: 'Discard' })).toBeVisible();
    const after = await boxes(page);
    console.log(JSON.stringify({ before, after }));
    const { footer, left, model, mic: button, note: row, editor } = after;
    if (!footer || !left || !model || !button || !row || !editor || !before.footer) throw new Error('a control is missing');
    // one row: the left group, the model and the mic share the footer's line, and the footer is as tall as before
    for (const control of [left, model, button]) expect(Math.abs(control.mid - footer.mid)).toBeLessThan(6);
    expect(footer.bottom - footer.top).toBeLessThan(before.footer.bottom - before.footer.top + 4);
    // the note is above the footer, below the editor, inside the composer
    expect(row.bottom).toBeLessThanOrEqual(footer.top + 1);
    expect(row.top).toBeGreaterThanOrEqual(editor.top);
    await page.screenshot({ path: test.info().outputPath('retained-note.png') });
    // Discard puts the composer back as it was
    await note.getByRole('button', { name: 'Discard' }).click();
    await expect(note).toHaveCount(0);
    const back = await boxes(page);
    expect(back.footer?.top).toBeCloseTo(before.footer.top, 0);
  });
});
