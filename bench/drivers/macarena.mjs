// Runs MacArena task scripts in the VM's GUI session (osascript needs it): a task's reset with its files copied in,
// and its weighted graders.
import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { macScore } from '../lib/grading.mjs';
import { resetScripts, uploads } from '../lib/macarena.mjs';
import { bashAsUser, sleep } from './gui.mjs';

/** Resets a task and waits the delay it asks for before the agent starts. @param {any} t @param {string} macarenaRoot */
export function reset(t, macarenaRoot) {
  for (const f of uploads(t, macarenaRoot, homedir())) {
    mkdirSync(path.dirname(f.to), { recursive: true });
    copyFileSync(f.from, f.to);
  }
  const outs = resetScripts(t).map((s) => bashAsUser(s));
  sleep((t.before_action_delay_seconds ?? 2) * 1000);
  return outs;
}

/** Waits the task's grading delay, then runs its graders. @param {any} t */
export function grade(t) {
  sleep((t.before_grading_delay_seconds ?? 2) * 1000);
  const outs = t.evaluator.map(([script]) => bashAsUser(script));
  return { score: macScore(t.evaluator, outs), outs };
}
