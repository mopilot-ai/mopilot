// A chat's pull request: validating PR links, reading older attachments and the throttled status reader for the sidebar.

import type { ThreadAttachmentListResponse } from '../protocol/v2/ThreadAttachmentListResponse';
import { noteIgnored } from './ignored';
import {
  historicalPullRequestUrl,
  isMopilotPullRequestUrl,
  movedMopilotPullRequestUrl,
  pullRequestUrl,
} from '../../shared/pullRequest.mjs';
import { pullRequestReplies, responsePullRequests, type ResponseTurn } from './responsePullRequest';
import { GATE_STATUS, pullRequestDetails, type PullRequestDetails } from './pullRequestIndicator';
import { findVerifiedMergeUrls, githubMergeOid, type MergeCandidate } from './verifiedMergeReport';
export { pullRequestUrl } from '../../shared/pullRequest.mjs';

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown';
export interface ThreadPullRequest {
  url: string;
  number: number;
  state: PullRequestState;
  title?: string;
  source?: 'response';
  details?: PullRequestDetails;
  /** lines the PR adds and removes, as GitHub counts them */
  additions?: number;
  deletions?: number;
  /** when a merged PR merged (ms epoch), as GitHub reports it */
  mergedAt?: number;
  /** every PR of the chat, this one first, when it has more than one (the badge shows their count, #1581) */
  entries?: ThreadPullRequest[];
}
const TTL = 60_000;
/** A folder's branch read is shared only while it is in flight: the rows the shared minute timer refreshes together read
 * it once between them (a git spawn each), and a read after it settles asks git again, so a switch shows at once. */
const HEAD_TTL = 0;
/** The most PRs a chat's badge reads and lists. */
export const MAX_ENTRIES = 10;
/** The most PRs one chat lists in the PR inbox, latest first: a coordinating chat can land far more than a badge shows. */
export const MAX_LISTED = 50;
const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : undefined);

/** Codex desktop's older PR attachments, newest first. */
export function legacyPullRequests(text: string | null): Record<string, string[]> {
  try {
    const records = JSON.parse(text ?? '{}')?.['electron-persisted-atom-state']?.['pull-request-attachment-records-v3'];
    const result: Record<string, string[]> = Object.create(null);
    if (!Array.isArray(records)) return result;
    for (const record of records) {
      if (record?.hostId !== 'local' || typeof record.conversationId !== 'string' || !Array.isArray(record.attachments)) continue;
      const attachments = record.attachments
        .filter((a: { url?: unknown } | null) => pullRequestUrl(a?.url))
        .sort((a: { touchedAt?: number }, b: { touchedAt?: number }) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0))
        .map((a: { url: string; touchedAt?: number }) => historicalPullRequestUrl(pullRequestUrl(a.url)!, a.touchedAt));
      if (attachments.length) result[record.conversationId] = [...new Set<string>(attachments)];
    }
    return result;
  } catch {
    return {};
  }
}

interface Dependencies {
  attachments(id: string, cursor: string | null): Promise<ThreadAttachmentListResponse>;
  legacy(): Promise<string | null>;
  head(cwd: string): Promise<string | null>;
  gh(url: string | null, cwd: string, head?: string): Promise<{ ok: boolean; stdout: string; stderr?: string }>;
  now?: () => number;
  responses?(id: string, version?: string): Promise<readonly ResponseTurn[]>;
  /** the PR the chat's monitor is bound to (set_pr_monitor or the Changes card), on every harness; null when unbound */
  monitored?(id: string): Promise<string | null>;
  /** the signed-in GitHub login, for review requests (read once); null when unknown */
  viewer?(): Promise<string | null>;
  /** a PR head's merge-gate status with its words (src/lib/pullRequestIndicator.ts GATE_STATUS), or null */
  gateStatus?(url: string, head: string): Promise<Record<string, unknown> | null>;
}

/** A chat's history version: a newer update or another native session (a switched harness) means other saved replies. */
export const historyVersion = (updatedAt: number, nativeId: string) => JSON.stringify([updatedAt, nativeId]);

/** Whether any chat's own history read is under way (the sidebar badges' reads wait for it). */
export const anyChatLoading = (runtime: Record<string, { loading: boolean }> | undefined) =>
  Object.values(runtime ?? {}).some((r) => r.loading);

/**
 * How many chats' histories the sidebar badges ask main for at once, how long a read may hold its place, and how long one
 * waits for a chat to open. One: main parses a read's whole transcript in its own heap, at two to three times the file's
 * size, and the newest chats on screen are often the longest, so two at once doubled main's peak for no gain once only
 * the rows on screen read (src/lib/onScreen.ts).
 */
const READ_SLOTS = 1;
const READ_SLOT_MS = 30_000;
const YIELD_RETRY_MS = 100;
const YIELD_MAX_MS = 5_000;

/**
 * Runs reads `slots` at a time, in the order asked. Every row on screen reads its chat's whole history when the sidebar
 * fills, and main parses each on its one loop, so all of them at once kept a click's own read waiting behind the lot
 * (#2963); one at a time leaves at most one ahead of it, and none starts while `opening()` says a chat's own read is under way
 * (for at most YIELD_MAX_MS, so a stuck open cannot starve the badges). A read that never settles gives its place up
 * after READ_SLOT_MS.
 */
function readSlots(opening: () => boolean, slots: number) {
  let active = 0;
  let retrying = false;
  const waiting: {
    start: () => void;
    queuedAt: number;
    reuse?: () => Promise<unknown> | undefined;
    answer: (p: Promise<unknown>) => void;
  }[] = [];
  const pump = () => {
    while (waiting.length) {
      // a read another one has replaced answers with that one's, taking no place and reading nothing
      const replacement = waiting[0].reuse?.();
      if (replacement !== undefined) {
        waiting.shift()!.answer(replacement);
        continue;
      }
      if (active >= slots) return;
      if (opening() && Date.now() - waiting[0].queuedAt < YIELD_MAX_MS) {
        if (!retrying) {
          retrying = true;
          setTimeout(() => {
            retrying = false;
            pump();
          }, YIELD_RETRY_MS);
        }
        return;
      }
      waiting.shift()!.start();
    }
  };
  return <T>(task: () => Promise<T>, reuse?: () => Promise<T> | undefined): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          active--;
          pump();
        };
        const timer = setTimeout(release, READ_SLOT_MS);
        Promise.resolve().then(task).then(resolve, reject).finally(release);
      };
      waiting.push({ start, queuedAt: Date.now(), reuse, answer: (p) => resolve(p as Promise<T>) });
      pump();
    });
}

/** Where a chat's PR replies outlive the app (main's store, electron/app/ipc/pullRequestReplies.cjs), by chat and version. */
export interface RepliesStore {
  get(id: string, version: string): Promise<readonly ResponseTurn[] | null>;
  put(id: string, version: string, replies: readonly ResponseTurn[]): Promise<unknown>;
}

/** Names how pullRequestReplies picks the replies a store keeps: a change to what it keeps makes every saved chat read again. */
// 4: retain parsed merge withdrawals, including replies with a code-formatted PR number.
const REPLIES_FORMAT = 4;

/**
 * A chat's saved replies, kept while its version (historyVersion) stays the same: every visible row refreshes
 * its pull request each minute, and reading every chat's whole history again each time made main allocate about half a
 * gigabyte a minute while idle. Only the few replies that bear on a PR are kept (pullRequestReplies), so every row of
 * a long sidebar fits; past `limit` the chat read longest ago goes. A read without a version, or one that failed, is not kept.
 * With a `store`, a chat's replies are also saved there and looked up before its history is read, so a launch reads no
 * unchanged chat's history again.
 */
export function savedReplies(
  read: (id: string) => Promise<readonly ResponseTurn[]>,
  {
    limit = 2000,
    opening = () => false,
    slots = READ_SLOTS,
    store,
  }: { limit?: number; opening?: () => boolean; slots?: number; store?: RepliesStore } = {},
) {
  const slot = readSlots(opening, slots);
  const entries = new Map<string, { version: string; value: Promise<readonly ResponseTurn[]> }>();
  return (id: string, version?: string): Promise<readonly ResponseTurn[]> => {
    if (version === undefined) return read(id);
    const kept = entries.get(id);
    if (kept?.version === version) return kept.value;
    const stored = JSON.stringify([REPLIES_FORMAT, version]);
    let readHistory = false;
    // a read still queued when a newer version of the chat replaced it answers with that version's replies instead of parsing the history again
    let mine: Promise<readonly ResponseTurn[]> | undefined;
    const fromHistory = () =>
      slot(
        () => ((readHistory = true), read(id)),
        () => {
          const current = entries.get(id)?.value;
          return mine && current && current !== mine ? current : undefined;
        },
      ).then(pullRequestReplies);
    const value = store
      ? store
          .get(id, stored)
          .catch((error) => {
            // a store that cannot answer only costs the history read it would have saved
            noteIgnored("look up a chat's saved PR replies", error);
            return null;
          })
          .then((saved) => saved ?? fromHistory())
      : fromHistory();
    mine = value;
    entries.delete(id);
    entries.set(id, { version, value });
    if (entries.size > limit) entries.delete(entries.keys().next().value!);
    void Promise.allSettled([value]).then(([result]) => {
      const current = entries.get(id)?.value === value;
      // the caller gets the rejection; only the entry goes, so the next refresh reads again
      if (result.status === 'rejected') {
        if (current) entries.delete(id);
        return;
      }
      // what this version's own history read found, while it is still the chat's latest: a newer version saves its own
      if (store && readHistory && current)
        store.put(id, stored, result.value).catch((error) => noteIgnored("save a chat's PR replies", error));
    });
    return value;
  };
}

/** Shared across sidebar rows: coalesce reads and limit GitHub processes to three at once. */
export function createPullRequestReader(deps: Dependencies) {
  const now = deps.now ?? Date.now;
  /** `final`: a settled value that never changes again (a merged PR), kept for good, even for a fresh read. */
  function cache<T>(read: (key: string) => Promise<T>, final: (value: T) => boolean = () => false, ttl = TTL) {
    const entries = new Map<string, { until: number; value: Promise<T> }>();
    return (key: string, fresh = false) => {
      const entry = entries.get(key);
      if (entry && (entry.until === Infinity || (!fresh && entry.until > now()))) return entry.value;
      const next = { until: Infinity, value: Promise.resolve().then(() => read(key)) };
      entries.set(key, next);
      // the entry expires a TTL after it settles either way; callers get its rejection from next.value
      void next.value.then(
        (value) => {
          next.until = final(value) ? Infinity : now() + ttl;
        },
        () => {
          next.until = now() + ttl;
        },
      );
      return next.value;
    };
  }
  const legacy = cache(async () => legacyPullRequests(await deps.legacy()));
  // the login never changes while the app runs; an unknown one (gh signed out) is asked again after the TTL
  const login = cache(
    async () => (await deps.viewer!()) ?? null,
    (v) => v !== null,
  );
  // a login gh can't give leaves review requests unread, never the PR: noted, and read as no login
  const viewer = () => login('viewer').catch((error) => (noteIgnored('read the GitHub login', error), null));
  let active = 0;
  const waiting: (() => void)[] = [];
  const missing = new WeakSet<ThreadPullRequest>();
  const mergeCommits = new WeakMap<ThreadPullRequest, string>();
  const read = async (url: string | null, cwd: string, head?: string): Promise<ThreadPullRequest | null> => {
    const unavailable = url ? { url, number: Number(url.split('/').at(-1)), state: 'unknown' as const } : null;
    try {
      const response = await deps.gh(url, cwd, head);
      if (!response.ok) {
        if (
          unavailable &&
          response.stderr?.trim() ===
            `GraphQL: Could not resolve to a PullRequest with the number of ${unavailable.url.split('/').at(-1)}. (repository.pullRequest)`
        )
          missing.add(unavailable);
        return unavailable;
      }
      const pr = JSON.parse(response.stdout);
      if (!pr || typeof pr !== 'object' || Array.isArray(pr)) return unavailable;
      const answeredUrl = pullRequestUrl(pr.url);
      const link = url ?? answeredUrl;
      if (!link) return null;
      // Both MoPilot names can name distinct PRs. Verify the response before caching its status.
      if (isMopilotPullRequestUrl(link) && answeredUrl !== link) return unavailable;
      const state =
        typeof pr.state === 'string' && (pr.isDraft === undefined || typeof pr.isDraft === 'boolean') ? pr.state.toUpperCase() : '';
      const result: ThreadPullRequest = {
        url: link,
        number: Number(link.split('/').at(-1)),
        state:
          state === 'MERGED'
            ? 'merged'
            : state === 'CLOSED'
              ? 'closed'
              : state === 'OPEN'
                ? pr.isDraft === true
                  ? 'draft'
                  : 'open'
                : 'unknown',
      };
      if (typeof pr.title === 'string') result.title = pr.title;
      const additions = count(pr.additions);
      const deletions = count(pr.deletions);
      if (additions !== undefined && deletions !== undefined) Object.assign(result, { additions, deletions });
      const mergedAt = result.state === 'merged' && typeof pr.mergedAt === 'string' ? Date.parse(pr.mergedAt) : NaN;
      if (Number.isFinite(mergedAt)) result.mergedAt = mergedAt;
      const mergeOid = githubMergeOid(pr.mergeCommit?.oid);
      if (answeredUrl === link && mergeOid) mergeCommits.set(result, mergeOid);
      const open = result.state === 'open' || result.state === 'draft';
      // the gate's words only while its status on this head is unsettled (a green one has nothing to say): one more
      // read, for this repository's PRs alone
      const gated =
        open &&
        Array.isArray(pr.statusCheckRollup) &&
        pr.statusCheckRollup.some(
          (c: { context?: unknown; state?: unknown } | null) => c?.context === GATE_STATUS && c.state !== 'SUCCESS',
        );
      // words gh couldn't give leave the PR read, marked so a reader keeps the place it last knew (prLastAnswer.ts)
      let gateUnread = false;
      const gateStatus =
        gated && deps.gateStatus && typeof pr.headRefOid === 'string'
          ? await deps.gateStatus(link, pr.headRefOid).catch((error) => {
              noteIgnored("read a PR's merge-gate status", error);
              gateUnread = true;
              return null;
            })
          : null;
      const details = open ? pullRequestDetails(pr, { viewer: deps.viewer ? await viewer() : null, gateStatus, gateUnread }) : undefined;
      if (details) result.details = details;
      return result;
    } catch {
      return unavailable;
    }
  };
  const limitedRead = async (url: string | null, cwd: string, head?: string) => {
    if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await read(url, cwd, head);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
  // A merged PR stays cached once GitHub has supplied the commit needed for verification.
  const status = cache(
    (url) => limitedRead(url, ''),
    (pr) => pr?.state === 'merged' && mergeCommits.has(pr),
  );
  const headOf = cache((cwd) => deps.head(cwd), undefined, HEAD_TTL);
  // Resolve the branch again on each refresh: a worktree can change branches between turns.
  const knownBranches = new Map<string, ThreadPullRequest>();
  const branch = cache(async (key) => {
    const [cwd, head] = JSON.parse(key) as [string, string];
    const result = await limitedRead(null, cwd, head);
    // gh resolves upstream/fork ownership itself. Discard a snapshot if checkout changed meanwhile.
    if ((await deps.head(cwd)) !== head) return null;
    if (result) knownBranches.set(key, result);
    const known = knownBranches.get(key);
    return result ?? (known ? { url: known.url, number: known.number, state: 'unknown' as const } : null);
  });
  /** When GitHub couldn't give a status, use the reply about this exact PR. */
  const withReport = (result: ThreadPullRequest | null, reports: readonly ThreadPullRequest[]) => {
    if (result?.state !== 'unknown') return result;
    const reported = reports.find((report) => report.url === result.url);
    return reported ? { ...result, ...reported } : result;
  };
  /** `primary` with the chat's other PRs (`urls`, latest first) as its entries, when there are any. */
  const withEntries = async (
    primary: ThreadPullRequest,
    urls: string[],
    reported: ThreadPullRequest[],
    limit: number,
  ): Promise<ThreadPullRequest> => {
    const all = [...new Set([primary.url, ...urls])].slice(0, limit);
    if (all.length < 2) return primary;
    const entries = await Promise.all(
      // the others refresh on the cache's minute, not on every focus of the window
      all.map((u) => (u === primary.url ? primary : status(u).then((r) => withReport(r, reported)))),
    );
    return { ...primary, entries: entries.filter((e): e is ThreadPullRequest => !!e) };
  };
  /** version: names what the chat's saved replies were read at (historyVersion), so they are read again only when it changed */
  const thread = async (id: string, cwd = '', fresh = false, version?: string, limit = MAX_ENTRIES): Promise<ThreadPullRequest | null> => {
    let url: string | null = null;
    let latest = -Infinity;
    /** every PR attached to the chat, with when */
    const attached: { url: string; at: number }[] = [];
    try {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page = await deps.attachments(id, cursor);
        for (const attachment of page.data) {
          const payload = attachment.payload;
          const link =
            attachment.attachmentType === 'pull_request' && payload && typeof payload === 'object' && !Array.isArray(payload)
              ? pullRequestUrl(payload.url)
              : null;
          if (!link) continue;
          const candidate = historicalPullRequestUrl(link, attachment.createdAt);
          attached.push({ url: candidate, at: attachment.createdAt });
          if (attachment.createdAt >= latest) {
            latest = attachment.createdAt;
            url = candidate;
          }
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor);
    } catch (error) {
      // older Codex versions keep these in desktop state, read below
      noteIgnored("list a chat's attachments for its pull request", error);
    }
    // the chat's monitor binding is the PR it tracks now, whatever its harness or its folder's branch: before its attachments
    let monitored: string | null = null;
    try {
      monitored = pullRequestUrl(await deps.monitored?.(id));
    } catch (error) {
      noteIgnored("read a chat's monitored pull request", error);
    }
    if (monitored) url = monitored;
    // Older Codex attachments can still identify a second PR at a reused URL, even if another source supplies the primary.
    const legacyLinks =
      !url || isMopilotPullRequestUrl(url) || attached.some((attachment) => isMopilotPullRequestUrl(attachment.url))
        ? await legacy('', !url && fresh).then(
            (records) => records[id] ?? [],
            () => [],
          )
        : [];
    url ??= legacyLinks[0] ?? null;
    let responses: readonly ResponseTurn[] = [];
    try {
      responses = (await deps.responses?.(id, version)) ?? [];
    } catch (error) {
      noteIgnored("read a chat's responses for its pull request", error);
    }
    const attachments = [...attached.sort((a, b) => b.at - a.at).map((a) => a.url), ...legacyLinks];
    const mergeCandidates: MergeCandidate[] = [];
    const reports = responsePullRequests(responses, url, attachments, mergeCandidates);
    const reportedUrls = reports.filter((r) => r.state !== 'unknown').map((r) => r.url);
    const others = [...attachments, ...(url ? [url] : []), ...reportedUrls];
    const verified = await findVerifiedMergeUrls(mergeCandidates, others, limit, (link) => status(link, fresh), mergeCommits);
    others.push(...verified);
    const primaryUrl = url ?? reports[0]?.url ?? verified[0];
    if (primaryUrl) {
      // a read of a known link always answers, with unknown status at worst
      const result = (await status(primaryUrl, fresh))!;
      // An undated binding is still authoritative while its URL can name a PR. When GitHub confirms the PR is
      // absent, show the verified moved PR when it is the chat's only reference for that number in these repositories.
      const moved = missing.has(result) ? movedMopilotPullRequestUrl(primaryUrl) : primaryUrl;
      const independentReports = moved === primaryUrl ? reports : responsePullRequests(responses, null, attachments);
      const namedIndependently = () => attachments.includes(primaryUrl) || independentReports.some((r) => r.url === primaryUrl);
      if (moved !== primaryUrl && others.includes(moved) && !namedIndependently()) {
        const recovered = (await status(moved, fresh))!;
        if (recovered.state !== 'unknown')
          return withEntries(
            recovered,
            others.filter((u) => u !== primaryUrl),
            independentReports,
            limit,
          );
      }
      return withEntries(withReport(result, independentReports)!, others, independentReports, limit);
    }
    if (!cwd) return null;
    try {
      const head = await headOf(cwd);
      const result = head ? await branch(JSON.stringify([cwd, head]), fresh) : null;
      return withReport(result, responsePullRequests(responses, result?.url));
    } catch {
      return null;
    }
  };
  /** each chat's latest settled read, so a menu or row mounted later shows it at once instead of waiting on GitHub */
  const settled = new Map<string, { sequence: number; cwd: string; version?: string; pr: ThreadPullRequest | null; at: number }>();
  let sequence = 0;
  const recorded = async (id: string, cwd = '', fresh = false, version?: string) => {
    const started = ++sequence;
    const pr = await thread(id, cwd, fresh, version);
    // an older read settling after a newer one cannot replace its answer
    if ((settled.get(id)?.sequence ?? 0) < started) settled.set(id, { sequence: started, cwd, version, pr, at: now() });
    return pr;
  };
  /**
   * The chat's last settled PR for this folder and history version; undefined until one settles, or, with `maxAge`, when
   * it settled longer ago than that (ms).
   */
  const known = (id: string, cwd = '', version?: string, maxAge = Infinity) => {
    const entry = settled.get(id);
    return entry && entry.cwd === cwd && entry.version === version && now() - entry.at <= maxAge ? entry.pr : undefined;
  };
  /** One PR's status by its canonical link, from the same cache and GitHub limit (a message's PR links). */
  const pullRequest = (url: string, fresh = false) => status(url, fresh) as Promise<ThreadPullRequest>;
  /** Every PR a chat's history names, up to MAX_LISTED; apart from `known`, so a badge keeps its own shorter answer. */
  const listed = async (id: string, version: string): Promise<ThreadPullRequest[]> => {
    const pr = await thread(id, '', false, version, MAX_LISTED);
    return pr ? (pr.entries ?? [pr]) : [];
  };
  return Object.assign(recorded, { status: pullRequest, known, listed });
}
