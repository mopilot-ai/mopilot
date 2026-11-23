// Does a thread MoPilot starts leave the user's config.toml alone (#1346)? A writable thread in a folder with no
// trust entry makes the app-server write `[projects."<folder>"] trust_level = "trusted"`; the same start carrying that
// trust in its own config does not. Runs in a throwaway CODEX_HOME. No model call.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { open, tempHome } from '../lib/codex.mjs';

export const id = 'X18';
export const title = 'per-thread folder trust keeps ~/.codex/config.toml unwritten';
export const timeoutMs = 120000;

export default async function run(ctx) {
  const o = {};
  for (const v of [
    { name: 'plain', trust: false, sandbox: 'workspace-write' },
    { name: 'carried', trust: true, sandbox: 'workspace-write' },
    { name: 'carried_full', trust: true, sandbox: 'danger-full-access' },
    { name: 'read_only', trust: false, sandbox: 'read-only' },
  ]) {
    const env = tempHome(ctx, `codex-home-${v.name}`);
    const cwd = ctx.cwd(`trust-${v.name}`);
    execSync('git init -q', { cwd });
    const file = path.join(env.CODEX_HOME, 'config.toml');
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const c = await open(ctx, v.name, { env });
    const config = v.trust ? { projects: { [cwd]: { trust_level: 'trusted' } } } : undefined;
    const t = await c.startThread({ cwd, sandbox: v.sandbox, approvalPolicy: 'on-request', ...(config ? { config } : {}) });
    await new Promise((r) => setTimeout(r, 1500));
    const after = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    o[v.name] = { error: t.error?.message ?? null, wrote: after !== before && after.includes(cwd) };
    await c.close();
  }
  return ctx.result(o, {
    'a writable thread with no trust entry makes the app-server write one': o.plain.wrote === true,
    'the same start carrying its trust writes nothing': o.carried.wrote === false && !o.carried.error,
    'also with danger-full-access': o.carried_full.wrote === false && !o.carried_full.error,
    'a read-only thread never writes one': o.read_only.wrote === false,
  });
}
