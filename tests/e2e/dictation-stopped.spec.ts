// A dictation service that never answers is stopped once the composer stops waiting for it, in the real app against a
// fake MoPilot gateway and a synthetic microphone: the upload's connection closes when the wait ends, rather than
// staying open (and, for MoPilot credits, billable) after the composer has given up on it.
import http from 'node:http';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';

const GATEWAY_PORT = 39_823;
/** How long the composer waits for its last service (shared/speech.mjs SPEECH_WAIT_MS). */
const WAIT_MS = 180_000;

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

test.describe('a dictation service that never answers', () => {
  test.use({ harnesses: 'codex', seed: signedInWithCredits, env: { MOPILOT_API: `http://127.0.0.1:${GATEWAY_PORT}` } });
  const uploads: { at: number; closed?: number }[] = [];
  let gateway: http.Server;
  test.beforeAll(async () => {
    gateway = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/audio/transcriptions')) {
        // read the clip, then never answer: only the app ends this request
        const upload: { at: number; closed?: number } = { at: Date.now() };
        uploads.push(upload);
        req.resume();
        res.on('close', () => {
          upload.closed = Date.now();
        });
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => gateway.listen(GATEWAY_PORT, '127.0.0.1', r));
  });
  test.afterAll(() => new Promise<void>((r) => gateway.close(() => r())));

  test('the upload is closed when the composer stops waiting, and sent once', async ({ page }) => {
    test.setTimeout(WAIT_MS + 90_000);
    await expect(composer(page)).toBeVisible();
    await syntheticMicrophone(page);
    await expect(mic(page)).toBeVisible();
    await mic(page).click();
    await expect(mic(page)).toHaveClass(/recording/);
    await page.waitForTimeout(600);
    await mic(page).click();
    await expect.poll(() => uploads.length, { timeout: 15_000 }).toBe(1);
    // the composer gives up after its wait and keeps the recording to retry; main closes the upload with it
    await expect(page.getByText('Recording retained.')).toBeVisible({ timeout: WAIT_MS + 20_000 });
    await expect.poll(() => uploads[0].closed, { timeout: 10_000 }).toBeTruthy();
    const openFor = (uploads[0].closed as number) - uploads[0].at;
    console.log(`upload open for ${Math.round(openFor / 1000)} s`);
    expect(openFor).toBeGreaterThan(WAIT_MS - 5_000);
    expect(openFor).toBeLessThan(WAIT_MS + 15_000);
    expect(uploads).toHaveLength(1);
  });
});
