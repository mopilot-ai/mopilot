// Answers the check a new OpenAI API key gets (GET <base>/models, electron/identity/accounts/providers.cjs) inside a
// launched app, so a spec never reaches the real api.openai.com, and reads back the keys it was asked about.
import type { Harness } from './app';

/** From now on, the key check answers `status` (401 refuses the key); other requests go out as usual. */
export async function answerKeyCheck(h: Harness, status: number) {
  await h.app.evaluate((_electron, answer) => {
    const g = globalThis as any;
    g.__keyChecks ??= [];
    g.__realFetch ??= g.fetch;
    g.fetch = async (url: unknown, init?: { headers?: Record<string, string> }) => {
      if (!/^https:\/\/api\.openai\.com\/v1\/models$/.test(String(url))) return g.__realFetch(url, init);
      g.__keyChecks.push(String(init?.headers?.Authorization ?? '').replace(/^Bearer /, ''));
      return new Response('{}', { status: answer });
    };
  }, status);
  return () => h.app.evaluate(() => (globalThis as any).__keyChecks as string[]);
}
