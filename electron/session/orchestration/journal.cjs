// The durable record of chats that start other chats: each child's link and latest report, each parent's waiting
// notes and wake count, and which delivered items were briefs, wake-ups or family messages (for how windows show them).
const { clock } = require('../../platform/ports/clock.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { NOTES_KEPT } = require('../../../shared/sideSessions.mjs');

/** Items remembered for display: the newest this many. */
const DELIVERIES_KEPT = 500;
/** Item ids a parent sent a child that are remembered to tell its turns from the user's. */
const DRIVEN_KEPT = 50;
/** Proposals remembered: the newest this many, besides the ones still open or starting. */
const PROPOSALS_KEPT = 200;

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isString = (v) => typeof v === 'string' && v.length > 0;

function emptyJournal() {
  return { schemaVersion: 1, children: {}, parents: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {}, dependants: {} };
}

/** What a proposal can be: waiting for the user, being started, started, or set aside by the user or the agent. */
const PROPOSAL_STATUS = ['open', 'briefing', 'starting', 'started', 'dismissed', 'declined'];

/** Whether a read journal has the shape this version writes; anything else is kept on disk and not used. */
function validJournal(d) {
  if (!isObject(d) || d.schemaVersion !== 1 || !isObject(d.children) || !isObject(d.parents) || !isObject(d.deliveries)) return false;
  const childOk = (c) =>
    isObject(c) &&
    isString(c.parentId) &&
    isString(c.name) &&
    typeof c.title === 'string' &&
    Number.isFinite(c.createdAt) &&
    Array.isArray(c.driven) &&
    c.driven.every(isString) &&
    (c.lastReport === null || isObject(c.lastReport));
  const parentOk = (p) =>
    isObject(p) &&
    Number.isSafeInteger(p.wakes) &&
    typeof p.held === 'boolean' &&
    typeof p.cutShort === 'boolean' &&
    Array.isArray(p.notes) &&
    p.notes.every((n) => isObject(n) && isString(n.childId) && typeof n.body === 'string' && typeof n.wakes === 'boolean');
  const deliveryOk = (x) => isObject(x) && ['brief', 'wake', 'message'].includes(x.kind) && isString(x.chatId) && Number.isFinite(x.at);
  const proposalOk = (x) =>
    isObject(x) &&
    isString(x.parentId) &&
    ['offer', 'own_initiative'].includes(x.kind) &&
    PROPOSAL_STATUS.includes(x.status) &&
    isObject(x.args) &&
    Number.isFinite(x.createdAt) &&
    Number.isFinite(x.expiresAt);
  const queuedOk = (e) => isObject(e) && isString(e.id) && isString(e.chatId) && isObject(e.item) && typeof e.item.text === 'string';
  // a journal from before proposals, the queue or task lists has none
  const proposals = d.proposals === undefined ? {} : d.proposals;
  const queue = d.queue === undefined ? [] : d.queue;
  const planOk = (x) => isObject(x) && Array.isArray(x.items) && x.items.every((i) => isObject(i) && typeof i.content === 'string');
  const wrapOk = (x) => isObject(x) && typeof x.recap === 'string' && Array.isArray(x.actions);
  const plans = d.plans === undefined ? {} : d.plans;
  const wrapUps = d.wrapUps === undefined ? {} : d.wrapUps;
  // a session waiting for others (dependants.cjs): what it waits for, its brief, and why it is held (a journal from before them has none)
  const dependantOk = (x) =>
    isObject(x) &&
    isString(x.parentId) &&
    typeof x.title === 'string' &&
    isString(x.briefId) &&
    Array.isArray(x.after) &&
    x.after.length > 0 &&
    x.after.every(isString) &&
    isObject(x.brief) &&
    typeof x.brief.prompt === 'string' &&
    (x.held === null || (isObject(x.held) && isString(x.held.by) && isString(x.held.how)));
  const dependants = d.dependants === undefined ? {} : d.dependants;
  return (
    isObject(dependants) &&
    Object.values(dependants).every(dependantOk) &&
    isObject(plans) &&
    Object.values(plans).every(planOk) &&
    isObject(wrapUps) &&
    Object.values(wrapUps).every(wrapOk) &&
    isObject(proposals) &&
    Array.isArray(queue) &&
    queue.every(queuedOk) &&
    Object.values(d.children).every(childOk) &&
    Object.values(d.parents).every(parentOk) &&
    Object.values(d.deliveries).every(deliveryOk) &&
    Object.values(proposals).every(proposalOk)
  );
}

class OrchestrationJournal {
  /**
   * @param {{ file: string, publish?: (data: any) => void, write?: (data: any) => void }} o
   *   publish: the journal changed (for open windows); write: replaces the file write (tests)
   */
  constructor({
    file,
    publish = () => {
      /* no window to tell */
    },
    write,
  }) {
    this.file = file;
    this.publish = publish;
    this.write =
      write ??
      ((data) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writePrivate(file, JSON.stringify(data));
      });
    /** why the journal can't be used this run (it exists but can't be read), or null */
    this.startupError = null;
    this.data = emptyJournal();
    try {
      if (fs.existsSync(file)) {
        const read = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!validJournal(read)) fail('invalid_journal');
        this.data = {
          ...read,
          proposals: read.proposals ?? {},
          queue: read.queue ?? [],
          plans: read.plans ?? {},
          wrapUps: read.wrapUps ?? {},
          dependants: read.dependants ?? {},
        };
        // a start the app quit during never finished: its proposal can be started again
        for (const p of Object.values(this.data.proposals)) {
          if (p.status === 'starting') p.status = 'open';
          // no tool call outlives the app: an offer that waited for the user waits on its card alone, and counts down no more
          delete p.waiting;
          delete p.countdown;
        }
        // a turn that ran when the app quit ended unseen: its time isn't known, so it isn't counted (childUsage.cjs)
        for (const c of Object.values(this.data.children)) if (c.worked?.since != null) c.worked.since = null;
      }
    } catch (error) {
      // Keep the file as it is and turn orchestration off: an unreadable record must not become an empty one that
      // forgets which chats are linked, nor stop the app from starting.
      noteIgnored('read the orchestration journal', error);
      this.startupError = 'journal_unavailable';
    }
  }

  /** A copy to change and hand to commit. */
  draft() {
    if (this.startupError) fail(this.startupError);
    return structuredClone(this.data);
  }

  /** Write first, then use: a write that fails changes nothing. */
  commit(data) {
    if (this.startupError) fail(this.startupError);
    const ids = Object.keys(data.deliveries);
    if (ids.length > DELIVERIES_KEPT) {
      const oldest = ids.sort((a, b) => data.deliveries[a].at - data.deliveries[b].at).slice(0, ids.length - DELIVERIES_KEPT);
      for (const id of oldest) delete data.deliveries[id];
    }
    for (const child of Object.values(data.children))
      if (child.driven.length > DRIVEN_KEPT) child.driven = child.driven.slice(-DRIVEN_KEPT);
    // settled and expired proposals go oldest first; open and starting ones stay
    const now = clock.now();
    const live = (p) => p.status === 'starting' || (p.status === 'open' && now <= p.expiresAt);
    const settled = Object.keys(data.proposals).filter((id) => !live(data.proposals[id]));
    settled.sort((a, b) => data.proposals[a].createdAt - data.proposals[b].createdAt);
    for (const id of settled.slice(0, Math.max(0, settled.length - PROPOSALS_KEPT))) delete data.proposals[id];
    this.write(data);
    this.data = data;
    try {
      this.publish(structuredClone(data));
    } catch (error) {
      // presentation only: the journal is already written
      noteIgnored('show the orchestration journal', error);
    }
  }

  /** Change the journal with `edit` (a draft it may change) and write it; returns what `edit` returned. */
  change(edit) {
    const data = this.draft();
    const result = edit(data);
    this.commit(data);
    return result;
  }

  child(id) {
    return this.data.children[id] ?? null;
  }

  parent(id) {
    return this.data.parents[id] ?? null;
  }

  proposal(id) {
    return this.data.proposals[id] ?? null;
  }

  /** The chats `id` started, oldest first. */
  childrenOf(id) {
    return Object.entries(this.data.children)
      .filter(([, c]) => c.parentId === id && !c.detached)
      .sort(([, a], [, b]) => a.createdAt - b.createdAt)
      .map(([childId]) => childId);
  }
}

/** A parent's record as a new one starts. */
function emptyParent() {
  return { wakes: 0, held: false, cutShort: false, notes: [] };
}

/**
 * Leave `parentId` a note in the draft `d`, keeping its newest NOTES_KEPT.
 * @param {any} d a journal draft
 * @param {string} parentId
 * @param {{ childId: string, body: string, at: number, wakes: boolean }} note
 */
function addNote(d, parentId, note) {
  const p = (d.parents[parentId] ??= emptyParent());
  p.notes = [...p.notes, note].slice(-NOTES_KEPT);
}

/**
 * Put notes a wake-up carried back at the front of `parentId`'s waiting notes, older than any that came since. They
 * wake nobody by themselves: they ride with the parent's next wake.
 * @param {any} d a journal draft
 * @param {string} parentId
 * @param {{ childId: string, body: string }[]} notes the delivery's notes
 * @param {number} at when the wake-up composed them
 */
function restoreNotes(d, parentId, notes, at) {
  const p = (d.parents[parentId] ??= emptyParent());
  p.notes = [...notes.map((n) => ({ childId: n.childId, body: n.body, at, wakes: false })), ...p.notes].slice(-NOTES_KEPT);
}

module.exports = {
  OrchestrationJournal,
  emptyParent,
  addNote,
  restoreNotes,
  validJournal,
  DELIVERIES_KEPT,
  DRIVEN_KEPT,
  PROPOSALS_KEPT,
  PROPOSAL_STATUS,
};
