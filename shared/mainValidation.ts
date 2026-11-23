// Dependency-free main validation contracts and freshness decisions shared by CI, session notices and the deployed web app.
import { counts } from './statusTrust.ts';
export const VALIDATION_WORKFLOW = 'main-validation.yml';
// The least time between automatic cycles. 0: a cycle starts as soon as the previous one ends, back to back, while main has
// commits without a result (docs/unit-coverage.md#main-check); the concurrency group still runs one at a time.
export const VALIDATION_INTERVAL_MINUTES = 0;
export const JOB_TIMEOUT_MINUTES = 35;
export const QUEUE_WARNING_MINUTES = 10;
export const CYCLE_TIMEOUT_MINUTES = 90;
export const FRESHNESS_MINUTES = 30;
export const MAIN_CONTEXTS = ['main-unit-tests', 'main-e2e'] as const;
// A main-e2e result of a cycle that ran only the specs the commits since main's last green run reach says so in its
// description (.github/release-repo/main-e2e.yml, scripts/main-e2e-scope.mjs); any other main-e2e result is a full run.
export { SCOPED_MARK, isScoped } from './mainFailure.mjs';
import { isScoped } from './mainFailure.mjs';
// The full E2E run every night: due once it is past this UTC hour (09:00, 02:00 in Los Angeles) and no full run has
// passed on main in the last 20 hours, so it runs about once a day whichever trigger finds it due first.
export const FULL_E2E_AFTER_UTC_HOUR = 9;
export const FULL_E2E_GAP_MINUTES = 20 * 60;
export const MAIN_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: "refs/heads/main") { target { ... on Commit {
      history(first: 100) { nodes {
        oid committedDate messageHeadline parents(first: 1) { nodes { oid } }
        status { contexts { context state description targetUrl createdAt creator { login __typename } } }
      } }
    } } }
  }
}`;

export type MainStatus = { context: string; state: string; target_url?: string; description?: string; updated_at?: string };
export type MainCommit = { sha: string; date: string; message: string; statuses: MainStatus[] };
export type MainFreshness = { head: string; tested: string | null; behind: number | null; lagMinutes: number; overdue: boolean };
export type ValidationRun = { id: number; status: string; conclusion: string | null; createdAt: string; url: string };
export type ValidationJob = { name: string; status: string; startedAt: string };
export type ValidationView = {
  state: 'queued' | 'running' | 'stalled' | 'passed' | 'cancelled' | 'failed';
  minutes: number;
  detail: string;
  delayed: boolean;
  url: string;
};

/** Status histories are newest first; a pending retry cannot turn an older success into a fresh green. */
export function pairedGreen(statuses: MainStatus[]): boolean {
  return statusesGreen(statuses, MAIN_CONTEXTS);
}

/** Paginated release readers and the main pair use the same latest-status decision for their required contexts. */
export function statusesGreen(statuses: MainStatus[], contexts: readonly string[]): boolean {
  return contexts.every((context) => statuses.find((s) => s.context === context)?.state === 'success');
}

/** Whether the night's full E2E run is due: past FULL_E2E_AFTER_UTC_HOUR, with no full main-e2e pass on these commits in the last FULL_E2E_GAP_MINUTES. */
export function fullE2eDue(commits: MainCommit[], now = Date.now()): boolean {
  if (new Date(now).getUTCHours() < FULL_E2E_AFTER_UTC_HOUR) return false;
  return !commits.some((c) =>
    c.statuses.some(
      (s) =>
        s.context === 'main-e2e' &&
        s.state === 'success' &&
        !isScoped(s.description) &&
        now - Date.parse(s.updated_at ?? '') < FULL_E2E_GAP_MINUTES * 60_000,
    ),
  );
}

/** Every automatic entrypoint honors the newest aggregate's terminal failure, including before child status publication. */
export function failedCycle(statuses: MainStatus[]): boolean {
  return statuses.find((s) => s.context === 'main-validation')?.state === 'failure';
}

/** Keep successful work and permit two automatic attempts per suite and source SHA, including recovered errors. */
export function suitePlan(statuses: MainStatus[]) {
  const plan = MAIN_CONTEXTS.map((context) => {
    const mine = statuses.filter((s) => s.context === context);
    const failures = mine.filter((s) => s.state === 'failure' || s.state === 'error').length;
    return { run: mine[0]?.state !== 'success' && failures < 2, retry: mine[0]?.state !== 'success' && failures === 0 };
  });
  return { unit: plan[0].run, e2e: plan[1].run, retryUnit: plan[0].retry, retryE2e: plan[1].retry };
}

/** Age the oldest change waiting for validation, so a quiet, fully verified main never becomes stale. */
export function freshness(commits: MainCommit[], now = Date.now()): MainFreshness {
  if (!commits.length) throw new Error('Empty main snapshot');
  const at = commits.findIndex((c) => pairedGreen(c.statuses));
  const oldest = commits[at < 0 ? commits.length - 1 : Math.max(0, at - 1)];
  const lagMinutes = at === 0 ? 0 : Math.max(0, Math.floor((now - Date.parse(oldest.date)) / 60_000));
  return {
    head: commits[0].sha,
    tested: at < 0 ? null : commits[at].sha,
    behind: at < 0 ? null : at,
    lagMinutes,
    overdue: lagMinutes >= FRESHNESS_MINUTES,
  };
}

/** Normalize one GraphQL snapshot and follow only main's first parents, never a PR branch's commits. */
export function parseSnapshot(raw: unknown): MainCommit[] {
  const nodes = (raw as { data?: { repository?: { ref?: { target?: { history?: { nodes?: unknown } } } } } })?.data?.repository?.ref?.target
    ?.history?.nodes;
  if (!Array.isArray(nodes) || !nodes.length) throw new Error('Invalid GitHub main snapshot');
  const commits = new Map<string, MainCommit & { parent?: string }>();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid GitHub main snapshot commit');
    const n = node as {
      oid?: unknown;
      committedDate?: unknown;
      messageHeadline?: unknown;
      parents?: { nodes?: { oid?: unknown }[] };
      status?: { contexts?: unknown } | null;
    };
    const contexts = n.status === null ? [] : n.status?.contexts;
    if (
      typeof n.oid !== 'string' ||
      typeof n.committedDate !== 'string' ||
      !Number.isFinite(Date.parse(n.committedDate)) ||
      typeof n.messageHeadline !== 'string' ||
      !Array.isArray(n.parents?.nodes) ||
      !Array.isArray(contexts) ||
      n.parents.nodes.some((p) => !p || typeof p.oid !== 'string') ||
      contexts.some((s) => !s || typeof s.context !== 'string' || !['SUCCESS', 'PENDING', 'FAILURE', 'ERROR'].includes(s.state))
    ) {
      throw new Error('Invalid GitHub main snapshot commit');
    }
    commits.set(n.oid, {
      sha: n.oid,
      date: n.committedDate,
      message: n.messageHeadline,
      parent: n.parents.nodes[0]?.oid as string | undefined,
      // GraphQL serves each context's newest status only: one that does not count leaves the commit without that result
      statuses: contexts
        .filter((s) => counts(s))
        .map((s) => ({
          context: s.context,
          state: s.state.toLowerCase(),
          ...(typeof s.description === 'string' ? { description: s.description } : {}),
          target_url: s.targetUrl,
          updated_at: s.createdAt,
        })),
    });
  }
  const result: MainCommit[] = [];
  let current = nodes[0].oid as string | undefined;
  while (current && commits.has(current)) {
    const { parent, ...commit } = commits.get(current)!;
    commits.delete(current);
    result.push(commit);
    current = parent;
  }
  return result;
}

/** The same queue/execution deadlines and words are used in the web page, watchdog and session notice. */
export function runView(run: ValidationRun, jobs: ValidationJob[], now = Date.now(), outcomes: MainStatus[] = []): ValidationView {
  const live = jobs.filter((j) => j.status === 'in_progress');
  const running = run.status !== 'completed' && live.length > 0;
  const start = running ? Math.min(...live.map((j) => Date.parse(j.startedAt))) : Date.parse(run.createdAt);
  const minutes = Math.max(0, Math.floor((now - start) / 60_000));
  let state: ValidationView['state'];
  const recovered = outcomes.some((s) => s.context === 'main-validation' && s.target_url === run.url && s.state === 'success');
  if (run.status === 'completed')
    state = run.conclusion === 'success' || recovered ? 'passed' : run.conclusion === 'cancelled' ? 'cancelled' : 'failed';
  else state = running ? (minutes >= JOB_TIMEOUT_MINUTES ? 'stalled' : 'running') : 'queued';
  return {
    state,
    minutes,
    detail: running ? live.map((j) => j.name).join(', ') : 'Waiting for a runner',
    delayed: state === 'stalled' || (state === 'queued' && minutes >= QUEUE_WARNING_MINUTES),
    url: run.url,
  };
}

/** Reject unreadable run/job lists rather than treating them as an empty queue and starting competing work. */
export function parseRuns(raw: unknown): ValidationRun[] {
  const runs = (raw as { workflow_runs?: unknown })?.workflow_runs;
  if (
    !Array.isArray(runs) ||
    runs.some(
      (r) =>
        !r ||
        !Number.isSafeInteger(r.id) ||
        r.id < 1 ||
        !['queued', 'pending', 'requested', 'waiting', 'in_progress', 'completed'].includes(r.status) ||
        (r.conclusion !== null && typeof r.conclusion !== 'string') ||
        typeof r.html_url !== 'string' ||
        typeof r.created_at !== 'string' ||
        !Number.isFinite(Date.parse(r.created_at)),
    )
  )
    throw new Error('Invalid GitHub validation runs');
  return runs.map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion, createdAt: r.created_at, url: r.html_url }));
}

export function parseJobs(raw: unknown): ValidationJob[] {
  const jobs = (raw as { jobs?: unknown })?.jobs;
  if (
    !Array.isArray(jobs) ||
    jobs.length >= 100 ||
    jobs.some(
      (j) =>
        !j ||
        typeof j.name !== 'string' ||
        !['queued', 'pending', 'waiting', 'in_progress', 'completed'].includes(j.status) ||
        (j.status === 'in_progress' && (typeof j.started_at !== 'string' || !Number.isFinite(Date.parse(j.started_at)))),
    )
  )
    throw new Error('Invalid GitHub validation jobs');
  return jobs.map((j) => ({ name: j.name, status: j.status, startedAt: j.started_at ?? '' }));
}

/** The matrix entry beside main-e2e.yml's numbered shards that runs the specs taking a runner to themselves (scripts/e2e-own-runner.mjs). */
export const E2E_OWN_SHARD = 'own';
/** The prefix of main-e2e.yml's Linux shards (`linux-1`, …), which run the specs that need no Mac (scripts/e2e-own-runner.mjs). */
export const E2E_LINUX_SHARD = 'linux-';
export type E2eShard = number | typeof E2E_OWN_SHARD | `${typeof E2E_LINUX_SHARD}${number}`;
/**
 * main-e2e.yml's shard matrix when job scope leaves no answer, which tests/mainValidationWorkflow.test.ts keeps equal to
 * the workflow's: the whole suite of 2026-10-29 (215 specs) at scripts/main-e2e-scope.mjs's shardCount. A retry of a try
 * that ran it runs it too (main-e2e.yml's reuse step), since the retry skips the shards that passed by number.
 */
export const E2E_SHARDS = [1, 2, 3, 4, 5, 6, 7, 8, E2E_OWN_SHARD] as const;
export type ShardJob = { name: string; conclusion: string | null };

/**
 * Matrix exclusions for the automatic E2E retry: the shards whose every first-try job (`<scope> / e2e (<n>)`, `(own)` or
 * `(linux-<n>)`) passed. When no shard failed (a pick or report job did instead), nothing is excluded, so the retry still
 * tests the whole suite before it posts `main-e2e`.
 */
export function retryExclusions(jobs: ShardJob[], scope = 'e2e'): { shard: E2eShard }[] {
  const prefix = `${scope} / e2e (`;
  // the shards the first try ran: all of a full run, the first few (and `own`) of a scoped one
  const ran = new Set<E2eShard>(
    jobs.flatMap((j): E2eShard[] => {
      if (!j.name.startsWith(prefix) || !j.name.endsWith(')')) return [];
      const name = j.name.slice(prefix.length, -1);
      if (name === E2E_OWN_SHARD) return [E2E_OWN_SHARD];
      const linux = name.startsWith(E2E_LINUX_SHARD) ? Number(name.slice(E2E_LINUX_SHARD.length)) : Number.NaN;
      if (Number.isInteger(linux) && linux > 0) return [`${E2E_LINUX_SHARD}${linux}`];
      const n = Number(name);
      return Number.isInteger(n) ? [n] : [];
    }),
  );
  // the numbered macOS shards in order, then `own`, then the Linux ones in order
  const order = (shard: E2eShard) =>
    typeof shard === 'number' ? shard : shard === E2E_OWN_SHARD ? 1e6 : 2e6 + Number(shard.slice(E2E_LINUX_SHARD.length));
  const shards = ran.size ? [...ran].sort((a, b) => order(a) - order(b)) : [...E2E_SHARDS];
  const passed = shards.filter((shard) => {
    const tries = jobs.filter((j) => j.name === `${prefix}${shard})`);
    return tries.length > 0 && tries.every((j) => j.conclusion === 'success');
  });
  return passed.length === shards.length ? [] : passed.map((shard) => ({ shard }));
}
