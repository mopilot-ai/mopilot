// Static contradictions with the design that need no model turn: undeclared getSettings(),
// the --no-chrome flag, and no rewind slash command.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO } from '../lib/common.mjs';
import { open, cleanEnv } from '../lib/claude.mjs';

export const id = 'C15';
export const title = 'Other contradictions with the design';
export const timeoutMs = 120000;

export default async function run(ctx) {
  const dts = fs.readFileSync(path.join(REPO, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts'), 'utf8');
  const help = execFileSync(ctx.bin, ['--help'], { env: cleanEnv(), timeout: 15000 }).toString();
  const s = open(ctx, 'session');
  const init = await s.q.initializationResult();
  const o = {
    getSettingsDeclared: /\bgetSettings\s*\(/.test(dts),
    getSettingsAtRuntime: typeof s.q.getSettings === 'function',
    noChromeFlag: /--no-chrome\b/.test(help),
    rewindCommand: (init.commands ?? []).some((c) => c.name === 'rewind'),
  };
  await s.close();
  return ctx.result(o, {
    'getSettings() exists at runtime but is undeclared in sdk.d.ts': o.getSettingsAtRuntime && !o.getSettingsDeclared,
    '--no-chrome is a CLI flag': o.noChromeFlag,
    'no rewind slash command (control API only)': !o.rewindCommand,
  });
}
