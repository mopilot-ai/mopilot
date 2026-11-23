// What the S1 watcher keeps in the Superagent database: settings, threads, triggers and the Gate's decisions with their Right/Wrong marks.
// Everything here is written by the intake in one transaction per event; nothing is ever sent anywhere (S1 is watch only).

const OUTCOMES = ['would_accept', 'would_ignore', 'would_ask'];
const MARKS = ['right', 'wrong'];

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now: () => number }} o
 */
function createWatchStore(db, { now }) {
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const putThread = db.prepare(
    `INSERT INTO threads (key, source, ref_id, created_at, last_at, meta) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET last_at = excluded.last_at, meta = excluded.meta`,
  );
  const putTrigger = db.prepare(
    `INSERT OR IGNORE INTO triggers (id, event_id, source, thread_key, kind, actor_login, actor_type, human, text, url, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const triggerRow = db.prepare('SELECT * FROM triggers WHERE id = ?');
  const putDecision = db.prepare(
    `INSERT OR IGNORE INTO decisions (id, trigger_id, thread_key, rule, mode, result, outcome, reason, reason_text, policy_version, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const decisionOf = db.prepare('SELECT * FROM decisions WHERE trigger_id = ?');
  const recent = db.prepare(
    `SELECT d.id, d.rule, d.mode, d.result, d.outcome, d.reason, d.reason_text, d.at, d.mark,
            t.kind, t.actor_login, t.text, t.url, t.thread_key, th.meta AS thread_meta
     FROM decisions d JOIN triggers t ON t.id = d.trigger_id JOIN threads th ON th.key = d.thread_key
     ORDER BY d.at DESC, d.rowid DESC LIMIT ?`,
  );
  const markStmt = db.prepare('UPDATE decisions SET mark = ?, marked_at = ? WHERE id = ?');
  const tally = db.prepare(`SELECT outcome, mark, COUNT(*) AS n FROM decisions GROUP BY outcome, mark`);
  const lastAllowed = db.prepare("SELECT MAX(at) AS at FROM decisions WHERE rule = ? AND thread_key = ? AND result = 'allow'");
  const allowedSince = db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE rule = ? AND result = 'allow' AND at > ?");

  const settings = {
    /** @returns {unknown} the saved JSON value, or undefined */
    get(key) {
      const row = /** @type {any} */ (getSetting.get(key));
      return row ? JSON.parse(row.value) : undefined;
    },
    set(key, value) {
      putSetting.run(key, JSON.stringify(value));
    },
  };

  /** Creates or touches a thread; `meta` is the source's own description of it (repo, number, url). */
  const upsertThread = ({ key, source, refId, meta }) => putThread.run(key, source, refId, now(), now(), JSON.stringify(meta));

  /** Stores a trigger once; a second insert of the same id changes nothing. @returns {boolean} whether it is new */
  const insertTrigger = (t) =>
    putTrigger.run(
      t.id,
      t.eventId,
      t.source,
      t.threadKey,
      t.kind,
      t.actorLogin,
      t.actorType,
      t.human ? 1 : 0,
      t.text,
      t.url ?? null,
      t.occurredAt,
    ).changes === 1;

  const getTrigger = (id) => triggerRow.get(id);

  /** Records the Gate's decision for a trigger once. @returns {boolean} whether it is new */
  const recordDecision = (d) =>
    putDecision.run(
      d.id,
      d.triggerId,
      d.threadKey,
      d.rule ?? null,
      d.mode ?? null,
      d.result,
      d.outcome,
      d.reason,
      d.reasonText,
      d.policyVersion,
      now(),
    ).changes === 1;

  const decisionFor = (triggerId) => decisionOf.get(triggerId);

  /** The newest decisions with what they were about, for the observe log. */
  const listDecisions = (limit = 50) =>
    recent.all(limit).map((r) => {
      const row = /** @type {any} */ (r);
      const meta = JSON.parse(row.thread_meta);
      return {
        id: row.id,
        at: row.at,
        outcome: row.outcome,
        result: row.result,
        rule: row.rule,
        mode: row.mode,
        reason: row.reason,
        reasonText: row.reason_text,
        mark: row.mark,
        kind: row.kind,
        actor: row.actor_login,
        text: row.text,
        url: row.url,
        subject: { number: meta.number, type: meta.type },
      };
    });

  /** Sets or clears (null) the Right/Wrong mark of a decision. @returns {boolean} whether the decision exists */
  function mark(decisionId, value) {
    if (value !== null && !MARKS.includes(value)) throw new RangeError(`mark must be right, wrong or null, not ${value}`);
    return markStmt.run(value, value === null ? null : now(), decisionId).changes === 1;
  }

  /** How the marks measure "would accept": precision is right over right and wrong. */
  function stats() {
    const out = { total: 0, wouldAccept: 0, marked: 0, right: 0, wrong: 0, precision: /** @type {number | null} */ (null) };
    for (const r of tally.all()) {
      const row = /** @type {any} */ (r);
      out.total += row.n;
      if (row.outcome !== 'would_accept') continue;
      out.wouldAccept += row.n;
      if (row.mark === 'right') out.right += row.n;
      if (row.mark === 'wrong') out.wrong += row.n;
    }
    out.marked = out.right + out.wrong;
    out.precision = out.marked ? out.right / out.marked : null;
    return out;
  }

  /** When the rule last allowed something on the thread (ms), or null: the Gate's cooldown reads it. */
  const lastAllowedAt = (rule, threadKey) => /** @type {any} */ (lastAllowed.get(rule, threadKey)).at ?? null;
  /** How many things the rule allowed after `sinceMs`: the Gate's rate limit reads it. */
  const countAllowedSince = (rule, sinceMs) => /** @type {any} */ (allowedSince.get(rule, sinceMs)).n;

  return {
    settings,
    upsertThread,
    insertTrigger,
    getTrigger,
    recordDecision,
    decisionFor,
    listDecisions,
    mark,
    stats,
    lastAllowedAt,
    countAllowedSince,
  };
}

module.exports = { createWatchStore, OUTCOMES, MARKS };
