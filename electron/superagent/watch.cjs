// The S1 watch service behind Settings › Superagent: what the page reads (settings, observe log, precision, problems) and what it may change
// (repo, allowed list, rule modes, pause, Right/Wrong marks, acknowledging a damaged database). It acts on nothing outside the Superagent database.
const { reasonText } = require('./core/reasons.cjs');
const { prefixCodePoints } = require('../../shared/textPrefix.mjs');
const { RULES, MODES, loadConfig, saveConfig, parseRepo, parseLogins } = require('./gate/config.cjs');

class WatchError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'WatchError';
    this.code = code;
  }
}

const KIND_LABEL = {
  'issue.opened': 'Issue',
  'pull_request.opened': 'PR',
  'issue.comment': 'Comment on issue',
  'pull_request.comment': 'Comment on PR',
  'pull_request.review_comment': 'Review comment on PR',
};
const VERDICT = { would_accept: 'Would accept', would_ignore: 'Would ignore', would_ask: 'Would ask a person' };
const SNIPPET = 90;

/** One line saying what an observe-log row was about, in the canvas's words. */
function describe(row) {
  const label = KIND_LABEL[row.kind] ?? row.kind;
  const n = row.subject.number === null ? '' : ` #${row.subject.number}`;
  const text = row.text.replace(/\s+/g, ' ').trim();
  const snippet = [...text].length > SNIPPET ? `${prefixCodePoints(text, SNIPPET)}…` : text;
  return `${label}${n} from ${row.actor}${snippet ? `: ${snippet}` : ''}`;
}

/** The error the page shows for a store that is not open, in one short line. */
function problemOf(error) {
  if (!error) return { code: 'failed', message: 'Superagent is starting.', setAside: null };
  const damaged = error?.name === 'StoreDamagedError';
  if (damaged) return { code: 'damaged', message: error.message, setAside: error.setAside ?? null };
  if (error?.name === 'StoreNewerError') return { code: 'newer', message: error.message, setAside: null };
  return { code: 'failed', message: String(error?.message ?? error), setAside: null };
}

/**
 * @param {object} o
 * @param {() => any} o.getStore the open store, or null while Superagent is off or could not open
 * @param {() => any} o.getError why it could not open, or null
 * @param {() => boolean} o.enabled the `superagent` flag
 * @param {() => void} o.onChange called after anything the page can see changed (settings or a new decision)
 * @param {() => void} o.acknowledge the person's explicit action after damage: lets a fresh database start
 */
function createWatch({ getStore, getError, enabled, onChange, acknowledge }) {
  const open = () => {
    const store = getStore();
    if (!store) throw new WatchError('unavailable', 'Superagent is not running.');
    return store;
  };
  const changed = (v) => {
    onChange();
    return v;
  };
  const view = (store, config) => ({
    repo: config.repo,
    allowed: config.allowed,
    botLogin: config.botLogin,
    paused: config.paused,
    rules: RULES.map((r) => ({ id: r.id, name: r.name, line: r.line, available: r.available, mode: config.rules[r.id].mode })),
  });

  return {
    /** Everything the page shows, or why it can show nothing. */
    state() {
      if (!enabled()) return { ok: false, error: { code: 'off', message: 'Superagent is off.', setAside: null } };
      const store = getStore();
      if (!store) return { ok: false, error: problemOf(getError()) };
      return {
        ok: true,
        config: view(store, loadConfig(store)),
        log: store.watch.listDecisions(50).map((r) => ({ ...r, verdict: VERDICT[r.outcome], what: describe(r) })),
        stats: store.watch.stats(),
        // events whose effect may have run but never finished: S1 has no effect, so this stays empty until S2, and shows if it ever is not
        reconcile: store.events.needsReconcile(),
      };
    },
    /** @param {unknown} value */
    setRepo(value) {
      const store = open();
      const repo = value === null || value === '' ? null : parseRepo(value);
      if (value !== null && value !== '' && !repo) throw new WatchError('invalid_repo', 'Use owner/name, like mopilot-ai/mopilot.');
      return changed(view(store, saveConfig(store, { ...loadConfig(store), repo })));
    },
    /** @param {unknown} list */
    setAllowed(list) {
      const store = open();
      if (!Array.isArray(list)) throw new WatchError('invalid_login', 'The allowed list must be a list of GitHub logins.');
      const { logins, invalid } = parseLogins(list);
      if (invalid.length) throw new WatchError('invalid_login', `Not a GitHub login: ${invalid.join(', ')}`);
      return changed(view(store, saveConfig(store, { ...loadConfig(store), allowed: logins })));
    },
    /** @param {string} id @param {string} mode */
    setRuleMode(id, mode) {
      const store = open();
      const rule = RULES.find((r) => r.id === id);
      if (!rule) throw new WatchError('unknown_rule', `Unknown rule: ${id}`);
      if (typeof id !== 'string' || typeof mode !== 'string') throw new WatchError('unknown_rule', 'Unknown rule.');
      if (mode === 'auto') throw new WatchError('auto_unavailable', 'Auto arrives with the next phase.');
      if (!MODES.includes(mode)) throw new WatchError('invalid_mode', `Unknown mode: ${mode}`);
      const config = loadConfig(store);
      return changed(view(store, saveConfig(store, { ...config, rules: { ...config.rules, [id]: { ...config.rules[id], mode } } })));
    },
    /** @param {'all' | 'github'} scope @param {boolean} paused */
    setPaused(scope, paused) {
      const store = open();
      if (scope !== 'all' && scope !== 'github') throw new WatchError('invalid_scope', `Unknown pause: ${scope}`);
      const config = loadConfig(store);
      return changed(view(store, saveConfig(store, { ...config, paused: { ...config.paused, [scope]: paused === true } })));
    },
    /** @param {string} decisionId @param {'right' | 'wrong' | null} value */
    mark(decisionId, value) {
      const store = open();
      if (typeof decisionId !== 'string') throw new WatchError('unknown_decision', 'That entry is no longer in the log.');
      if (value !== null && value !== 'right' && value !== 'wrong')
        throw new WatchError('invalid_mark', 'A mark is Right, Wrong or cleared.');
      if (!store.watch.mark(decisionId, value)) throw new WatchError('unknown_decision', 'That entry is no longer in the log.');
      return changed(store.watch.stats());
    },
    /** Starts a fresh database after damage; the damaged copy stays where it was set aside. */
    acknowledgeDamage() {
      if (problemOf(getError()).code !== 'damaged') throw new WatchError('not_damaged', 'There is no damaged database to replace.');
      acknowledge();
      return changed(true);
    },
    describe,
    reasonText,
  };
}

module.exports = { createWatch, WatchError, describe, problemOf };
