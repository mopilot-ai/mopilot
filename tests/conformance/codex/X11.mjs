// skills/list, account/rateLimits/read, mcpServerStatus/list, feedback/upload (existence only). No model call.
import { open, errMsg } from '../lib/codex.mjs';

export const id = 'X11';
export const title = 'skills/list, rateLimits, mcpServerStatus/list, feedback/upload';
export const timeoutMs = 120000;

export default async function run(ctx) {
  const c = await open(ctx, 'session');
  const skills = await c.request('skills/list', { cwds: [ctx.cwd('skills')] });
  const limits = await c.request('account/rateLimits/read', {});
  const mcp = await c.request('mcpServerStatus/list', {});
  // An invalid body proves the method exists without uploading anything.
  const feedback = await c.request('feedback/upload', { notAField: true });
  const o = {
    skills: skills.error ? errMsg(skills) : (skills.result?.data ?? []).reduce((a, e) => a + (e.skills?.length ?? 0), 0),
    rateLimitKeys: limits.error ? errMsg(limits) : Object.keys(limits.result ?? {}).sort(),
    mcpServers: mcp.error ? errMsg(mcp) : (mcp.result?.data ?? []).map((s) => s.name),
    feedbackError: errMsg(feedback),
  };
  return ctx.result(o, {
    'skills/list answers': !skills.error,
    'rateLimits/read returns rateLimits': !limits.error && 'rateLimits' in (limits.result ?? {}),
    'mcpServerStatus/list answers': !mcp.error,
    'feedback/upload exists (rejects a bad body)': /classification/.test(o.feedbackError ?? ''),
  });
}
