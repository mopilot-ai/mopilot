// Superagent intake: takes the plain event objects the GitHub source emits, cleans the text once, stores the event once, threads it, and records the Gate's decision.
// The event shape is the source's (sources/githubNotifications.cjs header). Nothing is posted, run or written to GitHub: S1 only records.
// Each event is handled under the store's exactly-once claim, in one transaction: a failure before it commits releases the claim so the next delivery retries.
const { key } = require('../core/ids.cjs');
const { threadKey } = require('../core/model.cjs');
const { reasonText } = require('../core/reasons.cjs');
const { sanitize } = require('./sanitize.cjs');
const { decide } = require('../gate/gate.cjs');
const { loadConfig } = require('../gate/config.cjs');

const KINDS = Object.freeze([
  'issue.opened',
  'pull_request.opened',
  'issue.comment',
  'pull_request.comment',
  'pull_request.review_comment',
]);
const OUTCOME = { allow: 'would_accept', deny: 'would_ignore', ask: 'would_ask' };
const str = (v) => typeof v === 'string' && v.length > 0;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Why an event is not the shape the source documents, or null. @param {any} e */
function shapeProblem(e) {
  if (!record(e)) return 'not an object';
  if (e.source !== 'github') return 'unknown source';
  if (!str(e.externalId) || !str(e.threadKey)) return 'no id';
  if (!KINDS.includes(e.kind)) return 'unknown kind';
  if (!record(e.actor) || !str(e.actor.login) || !str(e.actor.type)) return 'no actor';
  if (!record(e.repo) || !str(e.repo.fullName)) return 'no repo';
  if (!record(e.subject) || !str(e.subject.type) || !Number.isInteger(e.subject.number)) return 'no subject';
  // an issue opened with no description has a null body on GitHub: that is an empty text, not a bad event
  if (e.body != null && typeof e.body !== 'string') return 'no body';
  if (!Number.isFinite(Date.parse(e.occurredAt))) return 'no time';
  return null;
}

/**
 * @param {object} o
 * @param {any} o.store an open Superagent store
 * @param {() => number} o.now
 * @param {string} [o.owner] names this process's claims
 * @param {number} [o.claimTtlMs]
 */
function createIntake({ store, now, owner = 'intake', claimTtlMs = 30_000 }) {
  const w = store.watch;

  /**
   * Handles one event. Resolves to what became of it: 'invalid' (not the documented shape, nothing stored), 'ignored' (no repo
   * is watched or it is another repo, nothing stored), 'paused' (stored and threaded, no decision), 'recorded' (stored, threaded,
   * decided), or the claim's own answer ('duplicate', 'busy').
   * @param {unknown} input
   * @returns {Promise<{ status: string, reason?: string, decision?: any }>}
   */
  async function receive(input) {
    const problem = shapeProblem(input);
    if (problem) return { status: 'invalid', reason: problem };
    const raw = /** @type {any} */ (input);
    const config = loadConfig(store);
    if (!config.repo) return { status: 'ignored', reason: 'no_repo' };
    if (raw.repo.fullName.toLowerCase() !== config.repo.toLowerCase()) return { status: 'ignored', reason: 'wrong_repo' };

    // the raw text is cleaned here, once; only the cleaned event is stored
    const { body, ...rest } = raw;
    const event = { ...rest, text: sanitize(body ?? '') };
    const { id: eventId } = store.events.record(event.source, event.externalId, event);
    const triggerId = key(event.source, event.externalId);

    /** @type {any} */
    let decision = null;
    let paused = false;
    const outcome = await store.events.handle(event.source, event.externalId, owner, claimTtlMs, async () => {
      store.atomic(() => {
        const current = loadConfig(store);
        const thread = threadKey({ source: event.source, id: event.threadKey });
        w.upsertThread({
          key: thread,
          source: event.source,
          refId: event.threadKey,
          meta: {
            repo: event.repo.fullName,
            repoNodeId: event.repo.nodeId ?? null,
            number: event.subject.number,
            type: event.subject.type,
            url: event.subject.url ?? null,
          },
        });
        w.insertTrigger({
          id: triggerId,
          eventId,
          source: event.source,
          threadKey: thread,
          kind: event.kind,
          actorLogin: event.actor.login,
          actorType: event.actor.type,
          human: event.actor.type === 'User',
          text: event.text,
          url: event.subject.url,
          occurredAt: event.occurredAt,
        });
        if (current.paused.all || current.paused.github) {
          paused = true;
          return;
        }
        const d = decide({
          trigger: { actorLogin: event.actor.login, actorType: event.actor.type, kind: event.kind, text: event.text, threadKey: thread },
          config: current,
          now: now(),
          lastAllowedAt: w.lastAllowedAt,
          countAllowedSince: w.countAllowedSince,
        });
        w.recordDecision({
          id: key('decision', triggerId),
          triggerId,
          threadKey: thread,
          rule: d.rule,
          mode: d.mode,
          result: d.result,
          outcome: OUTCOME[d.result],
          reason: d.reason.code,
          reasonText: reasonText(d.reason),
          policyVersion: d.policyVersion,
        });
        decision = { ...d, outcome: OUTCOME[d.result] };
      });
    });
    if (outcome !== 'done') return { status: outcome };
    return paused ? { status: 'paused' } : { status: 'recorded', decision };
  }

  return { receive };
}

module.exports = { createIntake, shapeProblem, KINDS };
