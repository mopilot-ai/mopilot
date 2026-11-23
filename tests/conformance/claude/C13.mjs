// '/init' and '/code-review' run headless; local commands answer without a model turn.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { open, brief, systemOf } from '../lib/claude.mjs';

export const id = 'C13';
export const title = "'/init' and '/code-review' headless";
export const timeoutMs = 900000;

const human = { origin: { kind: 'human' } };
const bypass = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };

export default async function run(ctx) {
  const o = {};
  {
    const cwd = ctx.cwd('init');
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'tiny', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2),
    );
    fs.writeFileSync(path.join(cwd, 'index.js'), 'module.exports = (a, b) => a + b;\n');
    const s = open(ctx, 'init', { cwd, ...bypass });
    o.init = { result: brief(await s.turn('/init', human, 300000)), claudeMd: fs.existsSync(path.join(cwd, 'CLAUDE.md')) };
    await s.close();
  }
  {
    const cwd = ctx.cwd('review');
    execSync('git init -q && git config user.email t@example.invalid && git config user.name t', { cwd });
    fs.writeFileSync(path.join(cwd, 'calc.js'), 'function div(a, b) { return a / b; }\nmodule.exports = { div };\n');
    execSync('git add -A && git commit -qm init', { cwd });
    fs.writeFileSync(path.join(cwd, 'calc.js'), 'function div(a, b) { return a * b; } // divide\nmodule.exports = { div };\n');
    const s = open(ctx, 'review', { cwd, ...bypass });
    const r = await s.turn('/code-review low', human, 420000);
    o.codeReview = { result: brief(r), taskStarted: systemOf(s.msgs, /^task_started$/).length };
    await s.close();
  }
  {
    const s = open(ctx, 'local');
    await s.turn('Reply with just ok.', {}, 120000);
    o.local = {};
    for (const cmd of ['/context', '/usage', '/mcp', '/output-style', '/effort']) {
      const r = await s.turn(cmd, human, 60000).catch(() => null);
      o.local[cmd] = r ? { num_turns: r.num_turns, is_error: r.is_error } : 'timeout';
      if (!r) await s.q.interrupt().catch(() => {});
    }
    await s.close();
  }
  return ctx.result(o, {
    '/init writes CLAUDE.md headless': o.init.claudeMd,
    '/code-review runs headless as a background task': o.codeReview.result?.subtype === 'success' && o.codeReview.taskStarted > 0,
    'local commands answer with num_turns 0': Object.values(o.local).every((r) => r !== 'timeout' && r.num_turns === 0),
  });
}
