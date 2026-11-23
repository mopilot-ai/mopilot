// Sage sends no systemPrompt (the SDK then sends ""); compare with the claude_code preset.
import { open, brief } from '../lib/claude.mjs';

export const id = 'C2';
export const title = 'systemPrompt preset vs Sage default (no preset)';
export const timeoutMs = 300000;

const ASK =
  'Do not use tools. Answer in one short line: according to your system instructions, what product or CLI are you running inside, and what is your current working directory? If your instructions do not say, answer UNKNOWN.';

export default async function run(ctx) {
  const out = {};
  for (const [label, systemPrompt] of [
    ['none', undefined],
    ['preset', { type: 'preset', preset: 'claude_code', append: 'Sage marker: end every reply with the token ZEBRA.' }],
  ]) {
    const s = open(ctx, label, { cwd: ctx.cwd(label), ...(systemPrompt ? { systemPrompt } : {}) });
    const r = await s.turn(ASK, {}, 120000);
    const usage = await s.q.getContextUsage({ detail: 'summary' });
    out[label] = { answer: brief(r).result, systemPromptTokens: usage.categories.find((c) => c.name === 'System prompt')?.tokens ?? null };
    await s.close();
  }
  return ctx.result(out, {
    'preset system prompt is much larger than none': out.preset.systemPromptTokens > 5 * (out.none.systemPromptTokens ?? Infinity),
    'preset append is applied': /ZEBRA/.test(out.preset.answer),
    'no-preset session still knows it is Claude Code': /claude/i.test(out.none.answer),
  });
}
