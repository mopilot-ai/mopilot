// Background tasks: background_tasks_changed, stopTask(id), and what interrupt() stops with and
// without perTaskStopAffordance (shells survive either way; subagents only with the affordance).
import { execSync } from 'node:child_process';
import { open, sleep } from '../lib/claude.mjs';

export const id = 'C8';
export const title = 'Background tasks, stopTask, perTaskStopAffordance';
export const timeoutMs = 900000;

const alive = (secs) => execSync(`pgrep -f "^sleep ${secs}$" || true`).toString().trim().split('\n').filter(Boolean).length;
const kill = (secs) => execSync(`pkill -f "^sleep ${secs}$" || true`);
const bgSet = (s) => [...s.msgs].reverse().find((m) => m.subtype === 'background_tasks_changed')?.tasks ?? [];
const startTurn = async (s) => {
  const i = s.msgs.length;
  const r = s.nextResult(60000).catch(() => null);
  s.send('Write the numbers 1 to 30 in words, one per line.');
  await s.waitFor((m) => m.type === 'system' && m.subtype === 'init', 60000, 'init', i).catch(() => {});
  await sleep(1000);
  await s.q.interrupt();
  await r;
  await sleep(3000);
};

export default async function run(ctx) {
  const o = {};
  const base = { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true };

  // shells, with and without the affordance
  for (const affordance of [true, false]) {
    const A = 600 + Math.floor(Math.random() * 300);
    const B = A + 1;
    const s = open(ctx, `bash-${affordance ? 'affordance' : 'none'}`, { ...base, ...(affordance ? { perTaskStopAffordance: true } : {}) });
    ctx.defer(() => (kill(A), kill(B)));
    const r = {};
    await s.turn(
      `Use the Bash tool twice with run_in_background set to true: first run \`sleep ${A}\`, then run \`sleep ${B}\`. Do not wait for them. Then reply with just: started`,
      {},
      180000,
    );
    await sleep(2000);
    r.backgroundTypes = bgSet(s).map((t) => t.task_type);
    r.alive = alive(A) + alive(B);
    const ids = s.msgs.filter((m) => m.subtype === 'task_started').map((m) => m.task_id);
    if (affordance && ids.length) {
      await s.q.stopTask(ids[0]);
      await sleep(3000);
      r.aliveAfterStopTask = alive(A) + alive(B);
      r.backgroundAfterStopTask = bgSet(s).length;
    }
    const before = alive(A) + alive(B);
    await startTurn(s);
    r.shellsSurviveInterrupt = alive(A) + alive(B) === before && before > 0;
    await s.close();
    await sleep(1500);
    r.aliveAfterClose = alive(A) + alive(B);
    o[`bash_${affordance ? 'affordance' : 'none'}`] = r;
  }

  // a background subagent, with and without the affordance
  for (const affordance of [true, false]) {
    const s = open(ctx, `agent-${affordance ? 'affordance' : 'none'}`, { ...base, ...(affordance ? { perTaskStopAffordance: true } : {}) });
    const r = {};
    await s.turn(
      'Launch ONE background subagent (Agent/Task tool with run_in_background true, subagent_type general-purpose) whose prompt is: "Run the Bash command `sleep 75`, then reply done." Do not wait for it. Then reply with just: launched',
      {},
      180000,
    );
    await s.waitFor((m) => m.subtype === 'task_started' && m.task_type === 'local_agent', 60000, 'agent task').catch(() => {});
    await sleep(3000);
    r.before = bgSet(s).map((t) => t.task_type);
    await startTurn(s);
    r.after = bgSet(s).map((t) => t.task_type);
    await s.close();
    o[`agent_${affordance ? 'affordance' : 'none'}`] = r;
  }

  const { bash_affordance: ba, bash_none: bn, agent_affordance: aa, agent_none: an } = o;
  return ctx.result(o, {
    'background shells appear as local_bash tasks': ba.backgroundTypes.includes('local_bash'),
    'stopTask stops only that task': ba.aliveAfterStopTask === ba.alive - 1,
    'shells survive interrupt with the affordance': ba.shellsSurviveInterrupt,
    'shells survive interrupt without the affordance': bn.shellsSurviveInterrupt,
    'closing the query kills the remaining shells': ba.aliveAfterClose === 0 && bn.aliveAfterClose === 0,
    'subagent survives interrupt with the affordance': aa.before.includes('local_agent') && aa.after.includes('local_agent'),
    'subagent is stopped by interrupt without the affordance': an.before.includes('local_agent') && !an.after.includes('local_agent'),
  });
}
