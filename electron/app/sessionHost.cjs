// What the session-management tools (capabilities/tools/sessionRead.cjs, sessionControl.cjs) ask of main about a chat: its
// facts, transcript, usage and export, its title, archive and deletion, and the places a new session could start. Each
// goes through the chat's own harness adapter by stable chat id, so it works on Codex, Claude Code and ACP chats with no
// chat window open; the model, effort, fast and permission settings are in sessionSettings.cjs.
const { parseKind } = require('../../shared/harnessKind.mjs');
const { saveMeta } = require('../../shared/metaSave.mjs');
const { eventsOf, eventText } = require('../capabilities/tools/sessionText.cjs');
const { writeNewExport } = require('../platform/exportFile.cjs');
const { createSessionSettings, coded, familyOf } = require('./sessionSettings.cjs');

const TOP_CATEGORIES = 5;
const slug = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * @param {object} o
 * @param {any} o.live main's late-bound services: chats, controller, codex, claudeTurns, acpHost, chatDeletion, peerRuntime, identity
 * @param {any} o.orchestrator the linked-session orchestrator (its journal, archive state and harness picker)
 * @param {() => any} o.prefs the app's prefs
 * @param {(chatId: string) => Promise<string | null>} o.projectOf the chat's folder
 * @param {(dir: string) => { branch?: string | null } | null} o.worktreeInfo the managed worktree a folder is in
 * @param {() => { id: string, name: string, path: string }[]} o.projects the saved projects
 * @param {() => string} o.downloads the user's Downloads folder
 * @param {(chatId: string) => void} o.changed every window reads the chat again (chats:changed)
 * @param {() => { service: { get: (owner: string) => any } } | null} o.context main's context service (context/index.cjs appContext)
 * @param {() => number} [o.now]
 */
function createSessionHost({ live, orchestrator, prefs, projectOf, worktreeInfo, projects, downloads, changed, context, now = Date.now }) {
  const settings = createSessionSettings({ live, prefs, usable: (kind) => orchestrator.o.usable(kind) });
  const ref = (id) => live.controller.ref(id);
  const record = (id) => live.chats.records.get(id) ?? null;
  const titleOf = (id) => orchestrator.journal.child(id)?.title ?? live.codex?.chatName(id) ?? null;
  const missing = (id) => coded(`Session ${id} is no longer available.`, 'not_found');

  /** The chat's whole history as {turns, omitted}, or null when it cannot be read. */
  async function history(id) {
    if (!record(id) || !live.peerRuntime?.readHistory) return null;
    const h = await live.peerRuntime.readHistory(id);
    return h ? { turns: h.turns, omitted: h.earlierContentOmitted === true } : null;
  }

  /** A harness that keeps an archive of its own is restored there too, best effort (the other harnesses have only MoPilot's). */
  const UNARCHIVE_NATIVE = {
    codex: async (id) => {
      const thread = live.codex.codexThread(id);
      if (thread)
        await live.codex.threadUnarchive(thread).catch((error) =>
          // best effort: the orchestrator notes what it could not do
          orchestrator.safely('unarchive the chat on its harness too', () => {
            throw error;
          }),
        );
    },
    claude: null,
    acp: null,
  };

  const RENAME = {
    codex: async (id, title) => {
      const thread = live.codex.codexThread(id);
      if (!thread) throw missing(id);
      await live.codex.threadRename(thread, title);
    },
    claude: (id, title) => live.claudeTurns.api.rename(ref(id).id, title),
    acp: (id, title) => live.acpHost.rename(ref(id).key, title, false),
  };

  /** The plan's windows as the harness reports them, or why there is nothing to say. */
  function planOf(kind) {
    const family = parseKind(kind)?.family;
    const list = family ? live.identity?.instances?.(family) : null;
    if (!Array.isArray(list) || !list.length)
      return { status: 'unavailable', note: 'No signed-in login is known for this harness, so its limits could not be read.' };
    const plans = list.filter((i) => i.billing === 'subscription' || i.billing === 'harness');
    if (!plans.length) return { status: 'not_applicable', note: 'Plan limits do not apply: this harness runs on pay-per-use billing.' };
    return {
      status: 'ok',
      logins: plans.map((i) => ({
        login: i.label ?? i.account,
        active: i.active === true,
        outOfUsage: i.limited === true,
        ...(i.limited && typeof i.limitedUntil === 'number' ? { resetsAt: new Date(i.limitedUntil).toISOString() } : {}),
      })),
    };
  }

  /** The chat's context window as last measured. */
  function contextOf(id) {
    const { kind, key } = ref(id);
    const snap = context()?.service.get(JSON.stringify([id, kind, key])) ?? null;
    if (!snap || snap.used == null)
      return {
        status: 'unavailable',
        note: 'Nothing has been measured for this session yet; it reports its context after a turn has run.',
      };
    return {
      status: 'ok',
      model: snap.model ?? undefined,
      tokensUsed: snap.used,
      windowTokens: snap.window ?? undefined,
      percentUsed: snap.window ? Math.round((snap.used / snap.window) * 1000) / 10 : undefined,
      autoCompactAtTokens: snap.autoCompact?.enabled ? snap.autoCompact.threshold : undefined,
      measuredAt: new Date(snap.at).toISOString(),
      largestCategories: [...(snap.categories ?? [])]
        .filter((c) => c.kind === 'used')
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, TOP_CATEGORIES)
        .map((c) => ({ name: c.label, tokens: c.tokens })),
    };
  }

  /** Facts about a chat for get_session; null when main does not know it. */
  async function describe(id) {
    const rec = record(id);
    if (!rec) return null;
    const s = settings.settingsOf(id);
    const cwd = await projectOf(id);
    return {
      title: titleOf(id),
      harness: s?.kind ?? rec.segments.at(-1).kind,
      cwd,
      branch: cwd ? (worktreeInfo(cwd)?.branch ?? null) : null,
      archivedAt: rec.meta.archived ?? null,
      pinned: rec.meta.pinned === true,
      lastActivityAt: rec.updatedAt,
      model: s?.model ?? null,
      effort: s?.effort ?? null,
      permission: s?.permission ?? null,
      fast: s?.fast === undefined ? undefined : { state: s.fast ? 'on' : 'off' },
      pendingSwitch: s ? settings.pendingSwitchOf(id) : null,
    };
  }

  return {
    ...settings,
    history,
    describe,

    async usage(id) {
      if (!record(id)) return null;
      return { plan: planOf(ref(id).kind), context: contextOf(id) };
    },

    /** Name a chat on its own harness. */
    async setTitle(id, title) {
      if (!record(id)) throw missing(id);
      await RENAME[familyOf(ref(id).kind)](id, title);
      // list_sessions and the linked-session notes name it by this
      if (orchestrator.journal.child(id)) orchestrator.journal.change((d) => (d.children[id].title = title));
    },

    /** Bring an archived chat back, and its harness's own archive with it where it keeps one. */
    async unarchive(id) {
      if (!record(id)) throw missing(id);
      // Codex's archive is only kept in step with MoPilot's: a chat it never archived is restored all the same
      const wasArchived = record(id).meta.archived != null;
      await UNARCHIVE_NATIVE[familyOf(ref(id).kind)]?.(id);
      // a chat that is not archived is already restored
      if (!saveMeta(live.chats, id, { archived: null })) throw coded('The chat could not be restored.', 'unarchive_failed');
      // nothing changed for a chat that was not archived: no window needs telling
      if (!wasArchived) return;
      changed(id);
      orchestrator.pump();
    },

    /** Delete a chat for good, on its harness too (the app's own deletion, which tells every window). */
    async remove(id) {
      if (!live.chatDeletion) throw coded('Deleting chats is not available right now.', 'unavailable');
      await live.chatDeletion.delete(id);
    },

    /** Write the chat's conversation to a Markdown file in Downloads. */
    async exportTranscript(id) {
      const h = await history(id);
      if (!h) return null;
      const facts = /** @type {NonNullable<Awaited<ReturnType<typeof describe>>>} */ (await describe(id));
      const lines = [
        `# ${facts.title ?? 'Session'}`,
        '',
        `- Session: ${id}`,
        `- Harness: ${facts.harness}`,
        `- Folder: ${facts.cwd ?? 'unknown'}`,
        `- Exported: ${new Date(now()).toISOString()}`,
        ...(h.omitted ? ['- Earlier history was omitted by the harness.'] : []),
        '',
        ...eventsOf(h.turns).flatMap((e) => [eventText(e), '']),
      ];
      const text = lines.join('\n');
      const dir = downloads();
      const base = `${slug(facts.title) || 'session'}-${slug(id.slice(-12)) || 'chat'}`;
      try {
        return await writeNewExport(dir, base, text);
      } catch (error) {
        throw coded(`The transcript could not be written: ${error.message}`, 'export_failed');
      }
    },

    /** Put a chapter marker in the chat as a note its windows show among the turns. */
    noteChapter(id, { title, summary }) {
      const rec = record(id);
      if (!rec) throw missing(id);
      const at = now();
      const note = {
        id: `chapter-${at}-${rec.meta.notes?.length ?? 0}`,
        kind: 'chapter',
        text: summary ? `Chapter: ${title} - ${summary}` : `Chapter: ${title}`,
        turnId: live.controller.state.get(id)?.activeTurn?.id ?? null,
        // no turn id: the chat's latest turn shows it (src/lib/chatMeta.ts withChatNotes)
        turn: Number.MAX_SAFE_INTEGER,
        at,
      };
      // patchMeta-changes: the chapter note has its own id, so the notes always change
      if (!live.chats.patchMeta(id, { notes: [...(rec.meta.notes ?? []), note] }))
        throw coded('The chapter could not be saved.', 'save_failed');
      changed(id);
    },

    /** Where start_session could put a session now. */
    async startTargets(id) {
      const mine = ref(id).kind;
      const kinds = [];
      for (const kind of orchestrator.o.kinds?.() ?? []) {
        if (await orchestrator.o.usable(kind)) kinds.push({ harness: kind, thisChat: kind === mine });
      }
      const cwd = await projectOf(id);
      return {
        note: 'Pass a harness value to start_session harness (or "auto"); a folder shares or branches from the folder of the chat that starts it.',
        harnesses: kinds,
        thisChat: { harness: mine, folder: cwd, branch: cwd ? (worktreeInfo(cwd)?.branch ?? null) : null },
        projects: projects().map((p) => ({ name: p.name, folder: p.path })),
      };
    },
  };
}

module.exports = { createSessionHost };
