// MoMo's notes on this Host (#5474, shared/momoCore/notes*.ts): the notes, the journal, one undo entry per change and one snapshot per night, sealed under the home's storage (a move carries them, Reset deletes them). The model only proposes ops; `ops` has the core check each quote and write the good ones; an owner's order goes to the learning service as a suggested rule, never into a note. The nightly tidy runs once a day after 03:00 home time, keeps a snapshot first, and "Restore last night" puts it back.
import crypto from 'node:crypto';
import { applyOps, undoEntry } from '../../../shared/momoCore/noteOps.ts';
import { ownerForget, ownerWrite } from '../../../shared/momoCore/noteOwner.ts';
import { bringBack, cloneTree, editByOwner, emptyTree, findLine, lineCount } from '../../../shared/momoCore/notes.ts';
import { restoreSnapshot, tidy } from '../../../shared/momoCore/noteTidy.ts';
import { textMatchesQuote } from '../../../shared/momoCore/text.ts';
import { noteViews } from '../../../shared/momoCore/view.ts';
import { sealedStore } from '../momoCoreHost.mjs';

const KEEP_ENTRIES = 300;
const KEEP_SNAPSHOTS = 7;
const TICK_MS = 15 * 60_000;
/** The nightly tidy runs from this hour of the home's local day. */
const TIDY_HOUR = 3;

/** @param {any} v */
const shape = (v) => ({
  tree: Array.isArray(v?.tree?.notes) && Array.isArray(v?.tree?.archive) ? { notes: v.tree.notes, archive: v.tree.archive } : emptyTree(),
  journal: Array.isArray(v?.journal) ? v.journal.slice(-KEEP_ENTRIES) : [],
  /** @type {Record<string, any>} undo entries by the journal entry they belong to */
  undo: v?.undo && typeof v.undo === 'object' ? v.undo : {},
  snapshots: Array.isArray(v?.snapshots) ? v.snapshots.slice(-KEEP_SNAPSHOTS) : [],
  lastTidyDay: typeof v?.lastTidyDay === 'string' ? v.lastTidyDay : '',
});

/** @param {ReturnType<typeof shape>} all */
const prune = (all) => {
  all.journal = all.journal.slice(-KEEP_ENTRIES);
  const kept = new Set(all.journal.map((/** @type {any} */ j) => j.id));
  for (const id of Object.keys(all.undo)) if (!kept.has(id)) delete all.undo[id];
  all.snapshots = all.snapshots.slice(-KEEP_SNAPSHOTS);
};

/** @param {{ home: any, report?: (m: string) => void, now?: () => number }} deps */
export default ({ home, report, now = Date.now }) => {
  /** @type {ReturnType<typeof sealedStore<ReturnType<typeof shape>>> | null} */
  let store = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  const open = () => (store ??= sealedStore({ dir: home.storage.dir, name: 'notes.json', safeStorage: home.data.safeStorage, shape, now }));
  const newId = () => crypto.randomUUID();
  const iso = () => new Date(now()).toISOString();
  /** The home's local day, `YYYY-MM-DD`. */
  const dayOf = () => {
    const d = new Date(now());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  /** The audit line comes first; a change of the owner's notes that cannot be recorded is not made. @param {string} what @param {string} by */
  const audited = async (what, by) => !!(await home.service('gate')?.audit?.({ event: 'notes.changed', reason: what, by }));
  /** Writes one change while this Host is the running home; null when it is not. @template R @param {(all: ReturnType<typeof shape>) => R | Promise<R>} fn @returns {Promise<R | null>} */
  const change = async (fn) => {
    if (!home.stamp()) return null;
    return open().change(async (all) => {
      const out = await fn(all);
      prune(all);
      return out;
    });
  };

  const api = {
    /**
     * The model's proposed ops, checked and applied by code. Whether the chat holds outside content comes from the Host's own record of that chat (a call without a chat is tainted), never from the caller; `sources` must be built by the Host from messages it received (an owner's only from an authenticated owner device). Owner orders found in them become suggested rules.
     * @param {unknown[]} raw @param {{ chatId?: string, sources: import('../../../shared/momoCore/noteOps.ts').SourceText[], trigger: 'chat' | 'change' | 'nightly', background?: boolean }} ctx
     */
    async ops(raw, ctx) {
      const tainted = home.service('gate')?.taintFor?.(ctx.chatId).tainted() ?? true;
      const result = await change(async (all) => {
        const r = applyOps(all.tree, raw, {
          sources: ctx.sources,
          trigger: ctx.trigger,
          background: ctx.background,
          tainted,
          now: iso(),
          newId,
        });
        // the model's own proposals are audited too: with changes to make, the line is written before they are kept
        if (r.undo && !(await audited(`ops ${ctx.trigger}`, 'momo'))) return null;
        all.tree = r.tree;
        if (r.journal) all.journal.push(r.journal);
        if (r.journal && r.undo) all.undo[r.journal.id] = r.undo;
        return { applied: r.applied, rejected: r.rejected, suggestions: r.suggestions };
      });
      if (result)
        for (const s of result.suggestions)
          await home.service('learning')?.suggest?.({ text: s.text, sourceId: s.sourceId, quote: s.quote });
      return result;
    },

    /** What a line says now, or null when there is no such line (a card for a change of it shows this). @param {string} noteId @param {string} lineId */
    lineText: (noteId, lineId) => (home.stamp() ? (findLine(open().read().tree, noteId, lineId)?.text ?? null) : null),

    /** Whether the owner's quote is about the line an update or retire names: it says what the line says (the check of the notes core, against the line). A quote that is only some other words of the owner's does not vouch for changing it. @param {{ noteId?: string, lineId?: string, quote?: string }} op */
    binds(op) {
      const text = api.lineText(String(op.noteId), String(op.lineId));
      return text !== null && textMatchesQuote(text, String(op.quote));
    },

    /** Undo one change of the History, if its lines still look as it left them. @param {string} journalId @param {string} by */
    undo: (journalId, by) =>
      change(async (all) => {
        const entry = all.undo[journalId];
        if (!entry) return { restored: 0, skipped: 0, found: false };
        if (!(await audited('undo', by))) return null;
        const r = undoEntry(all.tree, entry);
        all.tree = r.tree;
        delete all.undo[journalId];
        all.journal.push({
          id: newId(),
          at: iso(),
          trigger: 'chat',
          ops: [],
          summary: [`Undid a change (${r.restored} line${r.restored === 1 ? '' : 's'} restored).`],
          rejected: [],
        });
        return { restored: r.restored, skipped: r.skipped.length, found: true };
      }),

    /** The owner's own edit of a line: final, and Confirmed. @param {string} noteId @param {string} lineId @param {string} text @param {string} by */
    edit: (noteId, lineId, text, by) =>
      change(async (all) => {
        if (!(await audited('edit', by))) return null;
        return editByOwner(all.tree, noteId, lineId, text, iso());
      }),

    /** The owner writes a line under a title on the Notes page: Confirmed at once, audited first, with a History entry and an Undo. @param {string} title @param {string} text @param {string} by */
    write: (title, text, by) =>
      change(async (all) => {
        const r = ownerWrite(all.tree, { title, text }, { now: iso(), newId });
        if (!r.ok) return { ok: false, reason: r.reason };
        if (!(await audited('write', by))) return null;
        all.tree = r.tree;
        all.journal.push(r.journal);
        all.undo[r.journal.id] = r.undo;
        return { ok: true };
      }),

    /** The owner forgets one line, or every line of a note: the lines are let go (History brings them back) and Undo restores them. @param {string} noteId @param {string | undefined} lineId @param {string} by */
    forget: (noteId, lineId, by) =>
      change(async (all) => {
        const r = ownerForget(all.tree, noteId, lineId, { now: iso(), newId });
        if (!r.ok) return { ok: false };
        if (!(await audited('forget', by))) return null;
        all.tree = r.tree;
        all.journal.push(r.journal);
        all.undo[r.journal.id] = r.undo;
        return { ok: true };
      }),

    /** "Bring back": a line let go returns, Confirmed. @param {string} lineId @param {string} by */
    bringBack: (lineId, by) =>
      change(async (all) => {
        if (!(await audited('bring-back', by))) return null;
        return bringBack(all.tree, lineId, iso());
      }),

    /** The nightly tidy: one snapshot, one journal entry, at most a fifth of the lines, and at most once a day however often it is asked for. @param {string} [by] */
    tidyIfDue: (by = 'system') =>
      change(async (all) => {
        if (all.lastTidyDay === dayOf()) return null;
        if (!(await audited('tidy', by))) return null;
        const r = tidy(all.tree, { now: iso(), newId });
        all.tree = r.tree;
        all.snapshots.push(r.snapshot);
        all.journal.push(r.journal);
        if (r.undo) all.undo[r.journal.id] = r.undo;
        all.lastTidyDay = dayOf();
        return { journalId: r.journal.id, snapshotId: r.snapshot.id, deferred: r.deferred };
      }),

    /** "Restore last night": the notes as they were before that night's tidy. The notes as they are now are kept as a snapshot first, so a restore can itself be restored. @param {string} snapshotId @param {string} by */
    restore: (snapshotId, by) =>
      change(async (all) => {
        const snapshot = all.snapshots.find((/** @type {any} */ s) => s.id === snapshotId);
        if (!snapshot) return null;
        if (!(await audited('restore', by))) return null;
        const safety = { id: newId(), at: iso(), tree: cloneTree(all.tree), lineCount: lineCount(all.tree) };
        all.snapshots.push(safety);
        all.tree = restoreSnapshot(snapshot);
        all.journal.push({
          id: newId(),
          at: iso(),
          trigger: 'chat',
          ops: [],
          summary: ['Restored the notes as they were before the nightly tidy.'],
          snapshotId: safety.id,
          rejected: [],
        });
        return { safetySnapshotId: safety.id };
      }),

    /**
     * "Restore" on one note: the lines the nightly tidy let go in that note come back where they were, a line changed since is left alone, and the other notes are not touched. The tidy's undo entry is used for only that note's changes; what was brought back is taken out of it, so it is not brought back twice.
     * @param {string} noteId @param {string} by
     */
    restoreNote: (noteId, by) =>
      change(async (all) => {
        const night = [...all.journal]
          .reverse()
          .find((j) => j.trigger === 'nightly' && all.undo[j.id]?.changes.some((c) => c.noteId === noteId));
        if (!night) return { ok: false };
        const entry = all.undo[night.id];
        const r = undoEntry(all.tree, { ...entry, changes: entry.changes.filter((c) => c.noteId === noteId) });
        if (!r.restored) return { ok: false };
        if (!(await audited('restore', by))) return null;
        all.tree = r.tree;
        const back = entry.changes.filter((c) => c.noteId === noteId && !r.skipped.includes(c));
        entry.changes = entry.changes.filter((c) => !back.includes(c));
        if (!entry.changes.length) delete all.undo[night.id];
        const title = /** @type {{ title: string }} */ (r.tree.notes.find((n) => n.id === noteId)).title;
        all.journal.push({
          id: newId(),
          at: iso(),
          trigger: 'chat',
          ops: back.map((c) => ({ type: /** @type {const} */ ('add'), noteId, lineId: /** @type {{ lineId: string }} */ (c).lineId })),
          summary: [
            `You brought back ${r.restored} line${r.restored === 1 ? '' : 's'} the nightly tidy let go in "${title.slice(0, 40)}".`,
          ],
          rejected: [],
        });
        return { ok: true, restored: r.restored };
      }),

    /** What the Notes page draws. */
    view() {
      if (!home.stamp()) return [];
      const all = open().read();
      return noteViews(all.tree, { journal: all.journal, undoable: new Set(Object.keys(all.undo)) });
    },

    /** The nightly tick: tidy once a day from 03:00, when it has not run today. */
    async tick() {
      if (!home.stamp() || new Date(now()).getHours() < TIDY_HOUR) return null;
      return api.tidyIfDue();
    },

    /** A copy of the notes, for the model to read. */
    snapshotTree() {
      return home.stamp() ? cloneTree(open().read().tree) : emptyTree();
    },
  };

  const disarm = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  /** One line in one note, written as the model's proposal is: from an owner's message of a chat. */
  const seed = async () => {
    const said = { id: 'seed-1', kind: /** @type {const} */ ('chat'), at: iso(), text: 'I prefer email over calls', owner: true };
    await api.ops([{ type: 'add', title: 'Seed', kind: 'topic', text: 'Prefers email', sourceId: 'seed-1', quote: 'I prefer email' }], {
      chatId: 'momo-seed',
      sources: [said],
      trigger: 'chat',
    });
  };
  home.use('notes', {
    seed,
    start: () => {
      disarm();
      timer = setInterval(
        () => void api.tick().catch((error) => /** @type {(m: string) => void} */ (report)(`MoMo's nightly tidy failed: ${error.message}`)),
        TICK_MS,
      );
      timer.unref?.();
    },
    pause: disarm,
    wipe: () => {
      disarm();
      store = null;
    },
  });
  home.provide('notes', api);
};
