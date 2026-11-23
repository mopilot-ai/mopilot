// Goals: feature off, ephemeral threads, auto-run on set, pause mid-turn, token budget, clear.
import fs from 'node:fs';
import { open, errMsg, sleep } from '../lib/codex.mjs';

export const id = 'X2';
export const title = 'Goals: set/get/pause/resume/clear, flag off, ephemeral';
export const timeoutMs = 900000;

const TERMINAL = ['complete', 'blocked', 'usageLimited', 'budgetLimited'];

export default async function run(ctx) {
  const o = {};
  // goals disabled per process
  {
    const c = await open(ctx, 'disabled', { args: ['--disable', 'goals'] });
    const tid = (await c.startThread()).result?.thread?.id;
    o.disabled = {
      set: errMsg(await c.request('thread/goal/set', { threadId: tid, objective: 'x' })),
      get: errMsg(await c.request('thread/goal/get', { threadId: tid })),
      clear: errMsg(await c.request('thread/goal/clear', { threadId: tid })),
    };
    await c.close();
  }
  const c = await open(ctx, 'goals');
  const goalNotes = (tid, from = 0) => c.notes.slice(from).filter((n) => n.params?.threadId === tid && n.method.startsWith('thread/goal'));
  // ephemeral threads reject goals
  {
    const tid = (await c.startThread({ ephemeral: true })).result?.thread?.id;
    o.ephemeral = {
      set: errMsg(await c.request('thread/goal/set', { threadId: tid, objective: 'say hi' })),
      get: errMsg(await c.request('thread/goal/get', { threadId: tid })),
    };
  }
  // set on a fresh thread starts work by itself and runs to complete; unknown appendTranscriptItem is ignored
  {
    const cwd = ctx.cwd('autorun');
    const tid = (await c.startThread({ cwd })).result.thread.id;
    const set = await c.request('thread/goal/set', {
      threadId: tid,
      objective: 'The current working directory contains a.txt, b.txt and c.txt, each with exactly one line of text.',
      appendTranscriptItem: false,
    });
    const done = await c.waitFor(
      (n) => n.method === 'thread/goal/updated' && n.params?.threadId === tid && TERMINAL.includes(n.params?.goal?.status),
      300000,
    );
    await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 60000);
    const items = c.items(0, tid);
    o.autorun = {
      setError: errMsg(set),
      terminal: done?.params?.goal?.status ?? null,
      turns: c.notes.filter((n) => n.method === 'turn/started' && n.params?.threadId === tid).length,
      itemTypes: [...new Set(items.map((i) => i.type))],
      files: ['a.txt', 'b.txt', 'c.txt'].every((f) => fs.existsSync(`${cwd}/${f}`)),
    };
    const clear = await c.request('thread/goal/clear', { threadId: tid });
    await sleep(1000);
    o.clear = {
      result: clear.result ?? errMsg(clear),
      clearedNote: goalNotes(tid).some((n) => n.method === 'thread/goal/cleared'),
      getAfter: (await c.request('thread/goal/get', { threadId: tid })).result?.goal ?? null,
    };
  }
  // pausing does not stop the running turn, and no new turn starts while paused
  {
    const cwd = ctx.cwd('pause');
    const tid = (await c.startThread({ cwd })).result.thread.id;
    await c.request('thread/goal/set', {
      threadId: tid,
      objective:
        'First run the shell command `sleep 15` (it must actually run), then create d.txt in the current directory containing one line. The goal is complete only when d.txt exists.',
    });
    await c.waitFor((n) => n.method === 'turn/started' && n.params?.threadId === tid, 30000);
    await sleep(5000);
    await c.request('thread/goal/set', { threadId: tid, status: 'paused' });
    const tc = await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 120000);
    await sleep(8000);
    o.pause = {
      firstTurn: tc?.params?.turn?.status ?? null,
      turns: c.notes.filter((n) => n.method === 'turn/started' && n.params?.threadId === tid).length,
      statuses: goalNotes(tid)
        .map((n) => n.params.goal?.status)
        .filter(Boolean),
      fileWritten: fs.existsSync(`${cwd}/d.txt`),
    };
  }
  // a tiny token budget ends as budgetLimited without starting another turn
  {
    const tid = (await c.startThread()).result.thread.id;
    await c.request('thread/goal/set', { threadId: tid, objective: 'Create e.txt with one line.', tokenBudget: 100 });
    const bl = await c.waitFor(
      (n) => n.method === 'thread/goal/updated' && n.params?.threadId === tid && TERMINAL.includes(n.params.goal.status),
      120000,
    );
    await c.waitFor((n) => n.method === 'turn/completed' && n.params?.threadId === tid, 60000);
    await sleep(3000);
    o.budget = {
      status: bl?.params?.goal?.status ?? null,
      turns: c.notes.filter((n) => n.method === 'turn/started' && n.params?.threadId === tid).length,
    };
  }
  return ctx.result(o, {
    'goals off: set/get/clear say the feature is disabled': Object.values(o.disabled).every((m) =>
      /goals feature is disabled/.test(m ?? ''),
    ),
    'ephemeral threads reject goals': [o.ephemeral.set, o.ephemeral.get].every((m) =>
      /ephemeral thread does not support goals/.test(m ?? ''),
    ),
    'appendTranscriptItem is silently ignored': o.autorun.setError === null,
    'set on a fresh thread runs to complete': o.autorun.terminal === 'complete' && o.autorun.turns >= 1 && o.autorun.files,
    'the goal turn has no userMessage item': !o.autorun.itemTypes.includes('userMessage'),
    'clear returns cleared and emits thread/goal/cleared':
      o.clear.result?.cleared === true && o.clear.clearedNote && o.clear.getAfter === null,
    'pause does not stop the running turn': o.pause.firstTurn === 'completed' && o.pause.turns === 1,
    'tiny tokenBudget ends budgetLimited in one turn': o.budget.status === 'budgetLimited' && o.budget.turns === 1,
  });
}
