// start_session: a chat starting a linked child chat on any harness, in its own worktree or its folder, with the
// parent's conversation (a native fork, or an excerpt where the harness has none) or only a brief.
const crypto = require('node:crypto');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { familyOf: harnessFamilyOf, byFamily } = require('../contract/route.cjs');
const { noteIgnored } = require('../../ignored.cjs');
const { briefText, sessionNameOf } = require('../../../shared/sideSessions.mjs');
const { emptyParent } = require('./journal.cjs');
const { familyOf, nameOf, labelOf, rosterFor, notesPathFor } = require('./family.cjs');
const { chooseHarness, requireNeeds, NEEDS } = require('./autoHarness.cjs');
const { predecessorsOf, standingOf, predecessorsFor, MAX_AFTER, HELD_HOW, SHOWN_CHARS } = require('./dependants.cjs');
const { worktreeFor } = require('./placement.cjs');
const { pathsArg, checkScope } = require('./writeScope.cjs');
const { requireCurrentChild, discardPrepared } = require('./preparedChild.cjs');

const MAX_PROMPT_BYTES = 32768;

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

/**
 * The arguments of a start, checked: what the model may pass, with defaults.
 * @returns {{ title: string, prompt: string | null, background: string | null, name: string | null, initiation: string,
 *             context: 'fork' | 'fresh', useWorktree: boolean | undefined, harness: string | null, paths: string[] | null,
 *             needs: string[], after: string[], excerptFrom?: string, restartOf?: string, folderIfNoWorktree?: boolean,
 *             model?: string, effort?: string, permission?: string, userSelected?: boolean }}
 *   harness "auto": main picks it (autoHarness.cjs); after: the sessions it waits for (dependants.cjs); excerptFrom and
 *   restartOf: only main's own restart offers carry them, never the model; folderIfNoWorktree: only a start the user
 *   asked for (a proposal, "always a new session"), which runs in the folder where no worktree can be made
 */
function startArgs(a) {
  const text = (v, max) => (typeof v === 'string' && v.trim() && Buffer.byteLength(v) <= max ? v.trim() : null);
  const title = text(a.title, 400);
  if (!title) fail('invalid_title', 'title is required: a short name for the task (under 60 characters reads best)');
  const initiation = a.initiation ?? 'user_asked';
  if (!['user_asked', 'offer', 'own_initiative'].includes(initiation))
    fail('invalid_initiation', 'initiation is user_asked, offer or own_initiative');
  const context = a.context ?? 'fresh';
  if (context !== 'fork' && context !== 'fresh') fail('invalid_context', 'context is fork or fresh');
  const prompt = text(a.prompt, MAX_PROMPT_BYTES);
  if (!prompt && initiation !== 'offer')
    fail('invalid_prompt', 'prompt is required: the brief the new session starts from (at most 32 KB)');
  const background = text(a.background, MAX_PROMPT_BYTES);
  if (context === 'fresh' && prompt && (!background || [...background].length < 80))
    fail(
      'invalid_background',
      'context "fresh" needs a background of at least 80 characters: the overall goal, decisions and constraints so far, and how this piece fits.',
    );
  if ((prompt?.length ?? 0) + (background?.length ?? 0) > 32000)
    fail(
      'invalid_prompt',
      'The brief plus background is too long (maximum 32000 characters); shorten it so the session can read files itself.',
    );
  if (a.harness !== undefined && a.harness !== 'auto' && !parseKind(String(a.harness)))
    fail('invalid_harness', 'harness is auto, codex, claude or acp:<id>');
  const list = (v, what, ok, max) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.length || v.length > max || !v.every(ok))
      fail(`invalid_${what}`, `${what} is a list of 1 to ${max} ${what === 'needs' ? `of ${NEEDS.join(', ')}` : 'session ids or names'}`);
    return [...new Set(v.map((x) => x.trim()))];
  };
  const needs = list(a.needs, 'needs', (x) => NEEDS.includes(x), NEEDS.length);
  const after = list(a.after, 'after', (x) => typeof x === 'string' && !!x.trim(), MAX_AFTER);
  return {
    title,
    prompt,
    background,
    name: typeof a.name === 'string' && a.name.trim() ? a.name : null,
    initiation,
    context,
    useWorktree: a.use_worktree === undefined ? undefined : a.use_worktree !== false,
    harness: a.harness === undefined ? null : String(a.harness),
    needs,
    after,
    paths: pathsArg(a.paths),
    ...(typeof a.model === 'string' ? { model: a.model } : {}),
    ...(typeof a.effort === 'string' ? { effort: a.effort } : {}),
    ...(typeof a.permission_mode === 'string' ? { permission: a.permission_mode } : {}),
  };
}

/**
 * How each family starts a child that continues the parent's conversation (ChatStarter), given the parent is on the
 * same family: the new chat's id, or null where it can't from this folder. A null entry: the family can't fork.
 * @type {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, ((starter: any, where: any) => Promise<string | null> | string | null) | null>}
 */
const FORK = {
  codex: (starter, w) => starter.forkCodex(w.parentNativeId, w.cwd, w.worktreeOf, w.options),
  claude: (starter, w) => starter.forkClaude(w.parentNativeId, w.cwd, w.worktreeOf, { parentCwd: w.parentCwd, ...w.options }),
  acp: null,
};

/**
 * How each family starts a child as a new conversation (ChatStarter).
 * @type {Record<import('../../../shared/harnessKind.mjs').HarnessFamily, (starter: any, where: any) => Promise<string> | string>}
 */
const FRESH = {
  codex: (starter, w) => starter.startCodex(w.cwd, w.worktreeOf, w.options),
  claude: (starter, w) => starter.startClaude(w.cwd, w.worktreeOf, w.options),
  acp: (starter, w) => starter.startAcp(w.basic, w.cwd, w.worktreeOf, w.options),
};

/**
 * Make the child chat: the folder selected by explicit placement or managed-worktree history, then the conversation. A fork is native
 * where the child's harness can fork the parent's in that folder; elsewhere it is a fresh chat whose brief carries
 * the parent's recent conversation, and the result says so.
 * @param {{ o: any, journal: any, archived: (chatId: string) => boolean }} orch
 */
async function makeChild(orch, parentId, args) {
  const { o } = orch;
  let allocated = null;
  try {
    const needs = args.needs ?? [];
    const check = () => {
      if (args.claim && !args.claim.current()) fail('start_cancelled', 'This start was cancelled; nothing started.');
    };
    check();
    // "auto": the parent's harness when it can do the piece and has usage left, else another that can (autoHarness.cjs)
    const route = args.harness === 'auto' ? await chooseHarness(orch, parentId, { needs }) : null;
    const kind = route?.harness ?? args.harness ?? o.controller.ref(parentId).kind;
    if (!parseKind(kind)) fail('invalid_harness', `"${kind}" isn't a harness`);
    if (!route && !(await o.usable(kind)))
      fail('harness_unavailable', `${kind} isn't available now: it is not installed, not signed in, or switched off`);
    check();
    if (!route) requireNeeds(orch, kind, needs);
    const parentCwd = await o.projectOf(parentId);
    check();
    if (!parentCwd) fail('no_folder', "This chat's folder isn't known, so a session can't be started from it");
    const useWorktree = worktreeFor(orch, parentId, parentCwd, args.useWorktree);
    if (!useWorktree) checkScope(orch, parentId, parentCwd, args.paths); // writeScope.cjs
    let cwd = parentCwd;
    let worktreeOf = null;
    if (useWorktree) {
      const info = o.worktreeInfo(parentCwd);
      const wt = await o.starter.newWorktree(parentCwd, {
        branch: (args.context === 'fork' ? info?.branch : info?.sourceBranch) ?? undefined,
        ...(args.context === 'fork' ? { startPoint: 'head' } : {}),
        what: 'a linked session',
      });
      if (wt && 'path' in wt) allocated = wt.path;
      check();
      if (wt && 'path' in wt) {
        cwd = wt.path;
        worktreeOf = o.chats.records.get(parentId)?.meta?.worktreeOf ?? parentCwd;
      } else if (wt && args.folderIfNoWorktree) {
        // a folder that can't hold one: a start the user asked for (a proposal, "always a new session") runs in the
        // folder, as a new chat does, and the result says where (worktree: false); any other failure is refused
        checkScope(orch, parentId, parentCwd, args.paths);
      } else
        fail(
          'worktree_failed',
          "A worktree couldn't be made for this folder (it may not be a Git repository with a commit). Pass use_worktree: false to share this chat's folder.",
        );
    }
    const ref = o.controller.ref(parentId);
    const options = (await o.childOptions?.(parentId, kind, args)) ?? {};
    const notesRoot = familyOf(orch.journal, parentId)[0];
    const notes = await o.prepareNotes?.(notesRoot);
    check();
    if (notes) {
      options.additionalDirectories = [...new Set([...(options.additionalDirectories ?? []), ...notes.additionalDirectories])];
      const grant = await o.grantParentNotes?.(parentId, notes.path);
      if (grant?.degraded) (options.ignored ??= []).push(grant.degraded);
    }
    check();
    const where = {
      cwd,
      parentCwd,
      worktreeOf,
      parentNativeId: ref.id,
      basic: String(parseKind(kind)?.basic),
      // The task already has a name: publish it before setup of the first turn or a title helper can delay it.
      options: { ...options, meta: { ...options.meta, initialTitle: args.title } },
    };
    if (args.context === 'fork' && harnessFamilyOf(kind) === harnessFamilyOf(ref.kind)) {
      const fork = byFamily(FORK, kind);
      const chatId = fork ? await fork(o.starter, where) : null;
      if (chatId)
        return {
          kind,
          route,
          cwd,
          worktreeOf,
          chatId,
          fallback: null,
          options,
          notesRoot: notes ? notesRoot : null,
          notesPath: notes?.path ?? null,
        };
      return {
        kind,
        route,
        cwd,
        worktreeOf,
        chatId: await byFamily(FRESH, kind)(o.starter, where),
        fallback: fork ? 'fork_needs_same_folder' : 'harness_cannot_fork',
        options,
        notesRoot: notes ? notesRoot : null,
        notesPath: notes?.path ?? null,
      };
    }
    const fallback = args.context === 'fork' ? 'harness_differs' : null;
    return {
      kind,
      route,
      cwd,
      worktreeOf,
      chatId: await byFamily(FRESH, kind)(o.starter, where),
      fallback,
      options,
      notesRoot: notes ? notesRoot : null,
      notesPath: notes?.path ?? null,
    };
  } catch (error) {
    if (allocated) {
      try {
        await o.starter.discardWorktree?.(allocated);
      } catch (cleanupError) {
        noteIgnored('clean an unclaimed linked-session worktree', cleanupError);
      }
    }
    throw error;
  }
}

/**
 * Start a linked child of `parentId` and send it its brief. The caller has the user's word for it: a turn the user
 * started (Orchestrator.start) or the user's click on a proposal (proposals.cjs).
 * @param {{ o: any, journal: any, archived: (chatId: string) => boolean, deliver: (chatId: string, item: any) => Promise<any> }} orch
 * @param {string} parentId
 * @param {ReturnType<typeof startArgs> & {claim?: {current: () => any, continued: boolean}, deferBrief?: boolean, reservedChatId?: string | null}} args
 * @param {string} initiation how it came to be started, kept with the link: user_asked, hand_off, offer, own_initiative
 */
async function startChild(orch, parentId, args, initiation = args.initiation) {
  const { o, journal } = orch;
  const prompt = args.prompt ?? '';
  const parentRecord = o.chats.records.get(parentId);
  if (parentRecord?.meta?.archived != null) fail('parent_archived', 'This chat is archived');
  journal.draft(); // refused now, before any chat is made, when the journal can't be written
  // the sessions it waits for, each one this parent started: one named wrong is refused before any chat is made
  const after = predecessorsOf(journal, parentId, args.after ?? []);
  if (!args.prompt && !args.deferBrief) fail('invalid_prompt', 'The new session needs its task before it can start.');
  const existing = args.reservedChatId ? journal.child(args.reservedChatId) : null;
  if (args.reservedChatId && (!existing || existing.parentId !== parentId || existing.detached || orch.archived(args.reservedChatId)))
    fail('start_cancelled', 'The reserved session is no longer available; nothing was sent.');
  const made = existing
    ? {
        chatId: String(args.reservedChatId),
        kind: existing.harness,
        cwd: existing.cwd,
        worktreeOf: existing.useWorktree ? (o.chats.records.get(parentId)?.meta?.worktreeOf ?? (await o.projectOf(parentId))) : null,
        fallback: existing.contextFallback,
        options: existing.settings,
        notesRoot: existing.notesRoot,
        notesPath: notesPathFor(journal, String(args.reservedChatId), o.notesDirectory),
      }
    : await makeChild(orch, parentId, args);
  await requireCurrentChild(orch, made, args);
  // without the excerpt the child still starts from its brief, and the result says the excerpt is missing; a restart's
  // is the conversation of the session it restarts (autoHarness.cjs)
  const from = args.excerptFrom ?? (made.fallback ? parentId : null);
  const excerpt = from
    ? await o.readExcerpt(from).catch((error) => {
        noteIgnored("read the conversation for a linked session's brief", error);
        return null;
      })
    : null;
  await requireCurrentChild(orch, made, args);
  try {
    if (!made.worktreeOf) checkScope(orch, parentId, made.cwd, args.paths, made.chatId);
  } catch (error) {
    await discardPrepared(orch, made, !!existing);
    throw error;
  }
  const label = (id) => labelOf(journal, id);
  const excerptFrom = args.excerptFrom ? label(args.excerptFrom) : null;
  const taken = new Set(familyOf(journal, parentId).map((id) => nameOf(journal, id)));
  const name = existing?.name ?? sessionNameOf(args.name ?? args.title, taken);
  const briefId = crypto.randomUUID();
  const now = o.now();
  // it waits unless every session it names is done already, and is held at once when one of them failed (the result
  // says so to the parent, in this turn: no note)
  const stand = after.length ? standingOf(orch, after) : { done: true };
  const waits = !('done' in stand);
  const held = 'blocked' in stand ? { by: stand.blocked, how: stand.how, at: now } : null;
  // the link lives only in main's journal: windows may patch chat metadata, never who started a chat
  try {
    journal.change((d) => {
      d.children[made.chatId] = {
        parentId,
        name,
        title: args.title,
        initiation,
        context: made.fallback ? 'fresh' : args.context,
        contextFallback: made.fallback,
        useWorktree: !!made.worktreeOf,
        harness: made.kind,
        cwd: made.cwd,
        ...(args.paths && !made.worktreeOf ? { paths: args.paths } : {}),
        createdAt: now,
        driven: [briefId],
        lastReport: null,
        settings: made.options ?? {},
        ...(made.notesRoot ? { notesRoot: made.notesRoot, notesPath: made.notesPath } : {}),
        continued: args.claim?.continued === true,
        ...(args.deferBrief ? { awaitingBrief: true } : {}),
        // what a restart on another harness carries when this one runs out of usage (autoHarness.cjs offerRestart)
        task: (args.prompt ?? '').slice(0, SHOWN_CHARS),
        ...(args.needs?.length ? { needs: args.needs } : {}),
      };
      d.parents[parentId] ??= emptyParent();
      if (args.deferBrief) return;
      if (waits) {
        d.dependants[made.chatId] = {
          parentId,
          title: args.title,
          briefId,
          after,
          brief: { prompt, background: args.background, excerpt, excerptFrom },
          held,
          at: now,
        };
        return;
      }
      d.deliveries[briefId] = {
        kind: 'brief',
        ...(made.notesPath ? { notesPath: made.notesPath } : {}),
        harness: o.controller.ref(parentId).kind,
        chatId: made.chatId,
        from: parentId,
        title: args.title,
        body: prompt.slice(0, SHOWN_CHARS),
        task: prompt,
        context: args.background,
        fork: args.context === 'fork' && !made.fallback,
        at: now,
      };
    });
  } catch (error) {
    await discardPrepared(orch, made, !!existing);
    throw error;
  }
  o.starter.retainWorktree?.(made.cwd);
  const placed = {
    chat_id: made.chatId,
    name,
    title: args.title,
    harness: made.kind,
    ...(made.route ? { harness_choice: { reason: made.route.reason, considered: made.route.considered } } : {}),
    folder: made.cwd,
    worktree: !!made.worktreeOf,
    ...(args.paths && !made.worktreeOf ? { paths: args.paths } : {}),
    context: made.fallback ? 'fresh' : args.context,
    ...(made.options?.ignored?.length ? { ignored: made.options.ignored } : {}),
    ...(made.fallback ? { context_fallback: made.fallback, excerpt_included: !!excerpt } : {}),
  };
  if (args.deferBrief) return { status: 'briefing', ...placed };
  if (waits)
    return {
      status: held ? 'held' : 'waiting',
      ...placed,
      waits_for: after.map(label),
      ...(held ? { held_by: label(held.by) } : {}),
      next: held
        ? `It is held: ${label(held.by)} ${HELD_HOW[held.how]}. It starts on its own once everything it waits for has finished a turn cleanly.`
        : 'It starts on its own once each of them finishes a turn cleanly, with their reports and branches in its brief; you get its notes as usual. Do not poll.',
    };
  const text = briefText({
    title: args.title,
    prompt,
    background: args.background,
    fork: args.context === 'fork' && !made.fallback,
    notes: made.notesPath,
    parentName: o.title(parentId) || nameOf(journal, parentId),
    parentId,
    excerpt,
    excerptFrom,
    after: predecessorsFor(orch, after),
    roster: rosterFor(o.controller, journal, made.chatId, orch.archived, o.notesDirectory),
  });
  // A busy recipient retains this brief in its own ordered queue (scheduler.cjs).
  const sent = await orch.deliver(made.chatId, {
    id: briefId,
    sideSession: { id: briefId },
    text,
    attachments: [],
    opts: { human: false },
  });
  return {
    status: sent?.queued ? 'queued' : sent?.started === false && !sent?.held ? 'not_started' : 'started',
    ...(sent?.queued ? { queue_position: sent.position } : {}),
    ...placed,
    ...(sent?.started === false && !sent?.held ? { error: sent.error ?? 'the harness did not take the brief; it waits in the chat' } : {}),
  };
}

module.exports = { startArgs, startChild, makeChild, MAX_PROMPT_BYTES };
