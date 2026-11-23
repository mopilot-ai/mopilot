// The 12-Grid Bench's routine-rerun mode in the VM (#3571, G4): around one task's pass A (which ended by saving its
// steps as a routine, bench/mgb-run.mjs), pass B runs the same task in a new chat on the same instance, is graded the
// same way, and the pair is written as <task>.routine.json; every routine is deleted before pass A and after pass B, so
// no run sees another's. Pure scoring is in lib/mgb/routineRerun.mjs.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appWindow } from './cdp.mjs';
import { mgbTurn, readLedger, expand } from './mgb.mjs';
import { gradeTask } from '../lib/mgb/grade.mjs';
import { ledgerUsage, prepareRun, runEnv, todayFor } from '../lib/mgb/run.mjs';
import { clearRoutines, passBFiles, rerunRecord, routineCalls, taskWindow } from '../lib/mgb/routineRerun.mjs';

/** The instance's tool operation log (Registry OperationLog: userData/capabilities/operations.jsonl). @param {string} userData */
export function readOperations(userData) {
  const file = path.join(expand(userData), 'capabilities', 'operations.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        // a line the app was still writing
        return [];
      }
    });
}

/** Deletes every routine in the column's instance. @param {string} port */
export async function clearInstanceRoutines(port) {
  const app = await appWindow(port);
  try {
    return await clearRoutines(app.evaluate);
  } finally {
    app.close();
  }
}

/**
 * Pass B of one pair, after pass A ran `prompts.length` task messages and the save message in one chat: the pair's
 * record (written next to the task's result), with pass B run only when pass A passed and its routine was saved.
 * @param {{ cfg: any, task: any, column: string, repeat: number, cell: any, tag: string, dir: string, name: string,
 *           a: { turn: any, verdict: string, prompts: number }, server: any, limiter: any, peer: any }} o
 */
export async function routinePassB({ cfg, task, column, repeat, cell, tag, dir, name, a, server, limiter, peer }) {
  const winA = taskWindow(a.turn, a.prompts);
  const usageA = a.turn.startedAt ? ledgerUsage(readLedger(cell.userData), winA) : null;
  const saved = routineCalls(readOperations(cell.userData), { from: winA.to, to: a.turn.endedAt ?? winA.to }).saved;
  const readA = a.turn.startedAt ? ledgerUsage(readLedger(cell.userData), taskWindow(a.turn, 1)) : null;
  const passA = {
    verdict: a.verdict,
    steps: usageA?.requests ?? null,
    readSteps: readA?.requests ?? null,
    tokens: usageA?.tokens ?? null,
    saved,
  };
  /** @type {any} */
  let passB = null;
  if (a.verdict === 'PASS' && saved) {
    const seed = cfg.rerunSeed ?? cfg.seed;
    const env = runEnv({ ...cfg, seed, today: todayFor(cfg, column) }, task, `${tag}-b`, expand('~/mgb-files'));
    const { data, fixtures, prompts } = prepareRun(task, env);
    const out = await mgbTurn({
      task,
      cell,
      port: cell.port,
      fixtures,
      prompts,
      env,
      server,
      timeoutS: cfg.timeoutS,
      shot: path.join(dir, `${name}.b.png`),
      skipChrome: cfg.skipChrome,
      peer,
      data,
      limiter,
      tag: `${tag}-b`,
      userData: cell.userData,
    });
    const grade = gradeTask({ task, data, state: out.state, env, turn: out.turn });
    const w = { from: out.turn.startedAt, to: out.turn.endedAt };
    const usage = out.turn.startedAt ? ledgerUsage(readLedger(cell.userData), w) : null;
    const readB = out.turn.startedAt ? ledgerUsage(readLedger(cell.userData), taskWindow(out.turn, 1)) : null;
    const runs = routineCalls(readOperations(cell.userData), w).runs;
    passB = {
      verdict: grade.verdict,
      steps: usage?.requests ?? null,
      readSteps: readB?.requests ?? null,
      tokens: usage?.tokens ?? null,
      runs,
      violations: grade.violations.length,
    };
    for (const [file, text] of passBFiles(name, { grade, state: out.state, usage, runs })) writeFileSync(path.join(dir, file), text);
  }
  await clearInstanceRoutines(cell.port);
  const record = rerunRecord({ task: task.id, column, repeat, seed: cfg.rerunSeed ?? cfg.seed, a: passA, b: passB });
  writeFileSync(path.join(dir, `${name}.routine.json`), JSON.stringify(record, null, 2));
  return record;
}
