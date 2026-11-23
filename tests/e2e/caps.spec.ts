// What a chat can do (WP7-1): main resolves it from the chat's segment and what the fake harnesses
// negotiated; read here through the IPC the useCaps hook sits on (window.native.session.caps).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/app';
import { openHarnessList } from './fixtures/harnessPicker';

const home = (page: Page) => page.getByRole('heading', { name: 'What should we build?' });
const composer = (page: Page) => page.getByRole('textbox', { name: 'Message', exact: true });
const transcript = (page: Page) => page.getByRole('main');

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await expect(composer(page)).toHaveText(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
}

const caps = (page: Page, chatId: string | null, hint?: object) =>
  page.evaluate(([id, h]) => (window as any).native.session.caps(id, h), [chatId, hint ?? null] as const);

/** The id of the only chat the app has. */
async function onlyChat(page: Page): Promise<string> {
  let ids: string[] = [];
  await expect
    .poll(async () => {
      ids = Object.keys((await page.evaluate(() => (window as any).native.chats.snapshot())).chats);
      return ids.length;
    })
    .toBe(1);
  return ids[0];
}

test.describe('Codex chat', () => {
  test('caps come from the app-server: its version, its models, the binding of each semantic', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await send(page, 'hello caps');
    await expect(transcript(page).getByText('fake-codex: hello caps', { exact: true })).toBeVisible();
    const id = await onlyChat(page);

    const r = await caps(page, id);
    expect(r).toMatchObject({ kind: 'codex', tier: 'first' });
    expect(r.caps.goal).toEqual({ state: 'native', via: 'rpc' });
    expect(r.caps.review).toEqual({ state: 'native', via: 'rpc' });
    // Codex has no /init: Sage polyfills it
    expect(r.caps.init).toEqual({ state: 'sage', via: 'polyfill', engine: 'init' });
    expect(r.caps.shell.via).toBe('rpc');
    // the fake's first model offers the priority tier, so Fast is available on it
    expect(r.caps.speed.state).toBe('native');
    // computer use is the macOS helper's, off in a Windows build (shared/flagDefs.mjs NOT_ON_WINDOWS)
    expect(r.caps.computerUse.state).toBe(process.platform === 'win32' ? 'disabled' : 'sage');
    // a hint names the model the chat is about to use: the fake's second model has no Fast tier
    const other = await caps(page, id, { model: 'fake-model-2' });
    expect(other.caps.speed).toMatchObject({ state: 'disabled', why: { layer: 'model', code: 'model.noFast' } });

    // another app running the chat greys out what can't change under it
    const running = await caps(page, id, { elsewhere: true });
    expect(running.caps.goal.state).toBe('disabled');
    expect(running.caps.goal.why).toMatchObject({ layer: 'session', code: 'session.runningElsewhere' });
    // a chat that hasn't started: the harness comes from the hint
    expect((await caps(page, null, { kind: 'claude' })).kind).toBe('claude');
    expect(await caps(page, null)).toBeNull();
  });
});

test.describe('Claude chat', () => {
  test.use({ harnesses: 'claude' });

  test('caps come from the Claude probe: passthrough goals, Sage shell, Fast off on an account without it', async ({ page }) => {
    await expect(home(page)).toBeVisible();
    await openHarnessList(page);
    await page.locator('.hp-harnesses .hp-row', { hasText: 'Claude Code' }).click();
    await page.locator('.hp-models .menu-item', { hasText: 'Fake Sonnet' }).click();
    await send(page, 'hello caps');
    await expect(transcript(page).getByText('fake-claude: hello caps', { exact: true })).toBeVisible();
    const id = await onlyChat(page);

    const r = await caps(page, id);
    expect(r).toMatchObject({ kind: 'claude', tier: 'first' });
    expect(r.caps.goal).toEqual({ state: 'native', via: 'passthrough', template: '/goal {args}' });
    expect(r.caps.shell).toMatchObject({ state: 'sage', engine: 'shell' });
    expect(r.caps.archive.state).toBe('sage');
    // Native voice conversation is unavailable; shared dictation stays in this chat.
    expect(r.caps.feedback).toMatchObject({ state: 'absent', why: { layer: 'harness' } });
    expect(r.caps.voiceChat).toMatchObject({ state: 'absent', via: 'none' });
    // the fake's account has extra usage off, which outranks its models having no Fast mode
    expect(r.caps.speed).toMatchObject({ state: 'disabled', why: { layer: 'account', code: 'account.noFast.extra_usage_disabled' } });
  });
});
