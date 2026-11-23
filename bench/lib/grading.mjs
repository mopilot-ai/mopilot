// Grading: WebGames (the password in the answer and the page's own completion record), MacArena (weighted shell
// graders) and REAL (the site's /finish state through the upstream grader), plus the per-task result record.

/** Parses JSON lines, skipping blank or broken ones. @param {string} text */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a half-written line from a server still appending
    }
  }
  return out;
}

/**
 * A WebGames verdict: the password must be in the agent's answer AND the page must have logged its own completion
 * since the task started (bench/webgames-serve.mjs), so neither guessing nor reading the bundle passes.
 * @param {{ task: { id: string, path: string, password: string }, answer: string, completions: any[], since: number }} o
 */
export function gradeWebGames({ task, answer, completions, since }) {
  const passwordInAnswer = answer.includes(task.password);
  const pageCompleted = completions.some((c) => c.at >= since && (c.taskId === task.id || String(c.url ?? '').includes(`/${task.path}`)));
  return {
    success: passwordInAnswer && pageCompleted,
    passwordInAnswer,
    pageCompleted,
    notes: `password ${passwordInAnswer ? 'in' : 'not in'} answer; page completion ${pageCompleted ? 'logged' : 'not logged'}`,
  };
}

/**
 * A MacArena score (0..100): each grader's weight counts when the last line of its output says true.
 * @param {[string, number][]} evaluator @param {string[]} outputs
 */
export function macScore(evaluator, outputs) {
  let score = 0;
  evaluator.forEach(([, weight], i) => {
    if (/true/i.test(String((outputs[i] ?? '').split('\n').pop()))) score += weight;
  });
  return score;
}

/**
 * A REAL verdict: gradable only when /finish gave JSON; a pass when the upstream grader printed SUCCESS.
 * @param {string} finish the /finish page's JSON text @param {string} graderOut
 */
export function realVerdict(finish, graderOut) {
  let gradable = false;
  try {
    JSON.parse(finish);
    gradable = true;
  } catch {
    // no state to grade: the tab was gone, or the page never loaded
  }
  return { gradable, success: gradable && /SUCCESS/.test(graderOut) };
}

/**
 * Whether an agent stepped outside the GUI-only rules, from its tool names.
 * `script` is page JavaScript through a browser tool (MoPilot's browser_script, a `javascript` or `evaluate` tool);
 * Codex's `js` tool is its computer-use API, not page script, so it does not count.
 * @param {string[]} names
 */
export function ruleBreaks(names) {
  return {
    shellUsed: names.some((n) => /^bash$|shell|terminal|exec_command/i.test(n)),
    scriptUsed: names.some((n) => /browser_script|javascript|evaluate/i.test(n)),
  };
}

/** Whether a turn ran out of time: not finished, no driver error, and not stopped for reaching outside the app. */
export const timedOut = (/** @type {Record<string, any>} */ r) => !r.ok && !r.error && !r.outsideBrowser;

/**
 * The target to read a REAL task's /finish from: a site target the agent opened during the turn (absent from
 * `before`), else the setup target when it is still on the site, else one that was already open, which the note
 * flags because it may hold an earlier task's state.
 * @param {{ id: string }[]} onSite @param {Set<string>} before @param {string | null} setupId
 */
export function pickSiteTarget(onSite, before, setupId) {
  const opened = onSite.find((t) => !before.has(t.id));
  if (opened) return { target: opened, note: 'finish read from the tab the agent opened' };
  const setup = onSite.find((t) => t.id === setupId);
  if (setup) return { target: setup, note: 'finish read from the setup tab (the agent used it)' };
  if (onSite.length) return { target: onSite[0], note: `finish read from a tab open before the turn (${onSite.length} on the site)` };
  return { target: null, note: 'no site tab after the run' };
}

const tail = (/** @type {string | undefined} */ s, n) => (s ?? '').slice(-n);

/**
 * The per-task record every arm writes (results/<run>/<arm>/<task>.json); bench/lib/report.mjs reads these fields.
 * @param {Record<string, any>} r
 */
export function resultRecord(r) {
  return {
    task: r.task,
    arm: r.arm,
    bench: r.bench,
    run: r.run,
    success: !!r.success,
    gradable: r.gradable !== false,
    unsupported: !!r.unsupported,
    score: r.score ?? null,
    wallMs: r.wallMs ?? null,
    timeout: !!r.timeout,
    steps: r.steps ?? null,
    shellUsed: r.shellUsed ?? null,
    scriptUsed: r.scriptUsed ?? null,
    approvals: r.approvals ?? 0,
    model: r.model ?? null,
    error: r.error ?? null,
    notes: r.notes ?? '',
    tag: r.tag ?? null,
    answerTail: tail(r.answer, 1500),
  };
}
