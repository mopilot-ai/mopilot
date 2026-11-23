// Basic-tier harnesses over ACP, renderer side. The ACP client runs in main (electron/harness/acp.cjs), and main
// translates its events (electron/harness/items/acp.cjs) into the Codex v2 notification shapes the store already
// understands, so the thread UI is shared.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { TURN_PAGE, olderPagesKept } from '../../store/turnPages';
import { beginThreadVisibilityRead } from '../../store/archiveOwnership';
import { acpThread, noteAcpSession } from '../../harness/acpSessions';
import { native, type AcpConfigOption, type AcpEvent, type AcpSessionState } from '../../lib/native';
import { acpCommands, composeCommands, machineCommands, resolveTyped } from '../../harness/commands';
import { hostFamilyOfHarness } from '../../../shared/host/chatIds.mjs';
import type { PendingRequest, Thread, ThreadItem, TurnState } from '../../store/types';
import type { AppState } from '../../store/state';
import { applyNotification } from '../../store/notifications';
import { buildInput } from '../../store/send';
import { chatOf, nativeOf, suggestOtherHarness } from '../../store/chats';
import { get as getState, newTurn, patchRuntime, set as setState, threadTitle, toast, touchChat, upsertThread } from '../../store/core';
import { navigate, openPaneTab } from '../../store/panes';
import { unhideFolder, rememberChatProject } from '../../store/projects';
import { readFailed, readSucceeded } from '../../store/chatReads';
import { addPendingTurn } from '../../store/pendingTurns';
import { chatProxy } from '../../harness/adapters/proxy';
import { acpAgentEmit } from './acpAgents';
import { createStreamNotifications } from '../../lib/streamNotifications';
import { flushSessionPatches } from '../../store/session/useSession';
import { harnessInfo, hostFamilyLabel } from '../../harness/registry';
import { adoptBasicHarnesses, detectBasicHarnesses, recheckBasic } from './acpDiscovery';
export { detectBasicHarnesses, recheckBasic, useFreshBasics } from './acpDiscovery';
import { acpHarnessOf, isAcpThread } from '../../harness/types';
import { errorText, ignoring } from '../../lib/ignored';
import { isLimitError, providerRetryError } from '../../../shared/acpStop.mjs';
import { isAuthText } from '../../../shared/acpAuth.mjs';
import { isEnabled } from '../../lib/flags';
import { selectValues } from '../../../shared/acpMode.mjs';
import { dispatchLogin, loginTerminal } from '../../harness/acpLogin';
import { authenticateBasic, cancelBasicSignIn, followBasicSignIns, SIGNIN_WAITING } from './acpSignIn';
import { beginHistoryOpen } from '../../store/transcriptRead';

export { isAcpThread };

export type { BasicHarness } from '../../harness/types';

/** Its registry label, else the label its quirks give (a harness the registry doesn't list yet), else its id. A chat that runs Claude Code or Codex on a machine goes by that agent's name. */
export const basicLabel = (id: string) =>
  hostFamilyLabel(id) ?? harnessInfo(`acp:${id}`)?.label ?? getState().basicHarnesses.find((h) => h.id === id)?.label ?? id;
/** The label a chat's harness goes by ('Kimi Code' for 'acp:kimi:…'). */
export const acpLabelOf = (nativeId: string) => basicLabel(acpHarnessOf(nativeId) ?? '');

/** design copy: the Basic badge's hover */
export const BASIC_HOVER = (label: string) =>
  `Chat, approvals, computer and browser control work. Goal, plan and review work only if ${label} has them.`;
/** A basic harness switched off for now (a remote kill switch, electron/harness/admission.cjs): its reason, never a Settings switch. */
export const TURNED_OFF = (reason: string | null) => reason ?? 'Turned off for now';
export { admissionFailure as UNSUPPORTED } from '../../harness/copy';

/* ------------------------------------------------------------------ */
/* detection and admission                                             */
/* ------------------------------------------------------------------ */
// The list is main's (electron/harness/admission.cjs), which looks for every binary again each time it builds one.
// Its answers and pushes come over one ordered channel, so the last list to arrive is the newest: no sequence guard.
export { loginCommand, type LoginTerminal } from '../../harness/acpLogin';

export { authenticateBasic, cancelBasicSignIn, SIGNIN_WAITING } from './acpSignIn';

/**
 * Sign a basic harness in from a chat: its terminal login in the side pane, else ACP authenticate with its first
 * method; one with neither (or not listed) opens Settings → Other harnesses, where its row says how.
 */
export function signInBasic(id: string) {
  const h = getState().basicHarnesses.find((x) => x.id === id);
  const term = h && loginTerminal(h);
  return dispatchLogin(term ?? null, {
    terminal: (t) => openPaneTab('terminal', { ...t, cwd: getState().home, signIn: true }),
    authenticate: () => {
      const method = h?.authMethods[0];
      // cannot reject: authenticateBasic says itself why the sign-in failed
      if (h && method) return void authenticateBasic(h, method.id);
      navigate({ name: 'settings', section: 'other-harnesses' });
    },
    unavailable: (reason) => toast(reason, 'error'),
  });
}

/**
 * A basic chat's failed turn that asks for a sign-in: the harness's own words (shared/acpAuth.mjs), or main refusing to
 * start it while it reads signed out ("<label>: Sign in to <label> first", or "<label>: <how to set it up>" for a setup
 * its quirks name). Sign in with the harness's own login, then Re-check. Null when the error is something else.
 */
export function basicAuthRecovery(chatId: string, message: string | null | undefined) {
  const id = acpHarnessOf(nativeOf(chatId));
  if (!id) return null;
  const h = getState().basicHarnesses.find((x) => x.id === id);
  const label = h?.label ?? acpLabelOf(nativeOf(chatId));
  const signedOut = isAuthText(message) || message === `${label}: Sign in to ${label} first`;
  // a setup its quirks name (dsh's key) fails in the words its Settings row shows
  const setup = !signedOut && h?.state === 'signin' && !!h.reason && message === `${label}: ${h.reason}`;
  if (!signedOut && !setup) return null;
  return {
    // how it signs in is decided on the click, from the list as it is then (one with no sign-in opens its Settings row)
    label: setup ? 'Set up' : 'Sign in',
    signIn: () => signInBasic(id),
    // cannot reject: recheckBasic says itself when the check fails
    recheck: () => void recheckBasic(id),
    waiting: {
      text: (s: AppState) => (s.basicSignIns[id] ? SIGNIN_WAITING : null),
      // cannot reject: cancelBasicSignIn says itself when it fails
      cancel: () => void cancelBasicSignIn(id),
    },
  };
}

/* ------------------------------------------------------------------ */
/* threads                                                             */
/* ------------------------------------------------------------------ */
/** Chats Sage created this run and hasn't sent to yet (no transcript to read). */
const fresh = new Set<string>();
// the chat a machine runs is made like this (acpHost.ts)
export { acpThread, fresh };

export async function loadAcpThreads() {
  const visible = beginThreadVisibilityRead();
  try {
    const list = await native.acp.list();
    const archived = getState().claudeArchived;
    setState((s) => {
      const threads = { ...s.threads };
      const order = [...s.threadOrder];
      for (const c of list) {
        if (archived[c.id] || !visible.allows(c.id)) continue;
        const t = acpThread(c);
        noteAcpSession(c.id, c.sessionId);
        const prev = threads[c.id];
        threads[c.id] = prev ? { ...prev, ...t, name: t.name ?? prev.name, projectId: prev.projectId ?? null } : t;
        if (!order.includes(c.id)) order.push(c.id);
      }
      return { threads, threadOrder: order };
    });
  } catch (e) {
    console.warn('ACP chats', e);
  } finally {
    visible.finish();
  }
}

/** Basic-tier chats archived in Sage meta, from main's list (Settings → Archived chats); rejects when main can't list them. */
export async function archivedAcpThreads(): Promise<Thread[]> {
  const archived = getState().claudeArchived;
  return (await native.acp.list()).filter((c) => archived[c.id]).map(acpThread);
}

/** Basic-tier chats whose title or Sage transcript holds the term (the search palette); `scope`: the search box asking. */
export async function searchAcpThreads(term: string, scope?: string): Promise<Thread[]> {
  return (await native.acp.search(term, 30, scope)).map(acpThread);
}

export function startAcpThread(o: { cwd: string; projectId?: string | null; harness: string }): string {
  unhideFolder(o.cwd);
  const id = `acp:${o.harness}:${crypto.randomUUID()}`;
  fresh.add(id);
  // cannot reject: a registration that failed is recorded and answers false, and the first send reports its own failure
  void chatProxy.newAcpSession(id, { cwd: o.cwd });
  const now = Date.now();
  upsertThread({ ...acpThread({ id, cwd: o.cwd, createdAt: now, updatedAt: now }), projectId: o.projectId ?? null } as Thread, true);
  rememberChatProject(id, o.projectId);
  patchRuntime(id, () => ({ loaded: true, loading: false }));
  return id;
}

/** One native ACP history as main translated it under the stable chat that owns it; its live translator follows on from the turn the transcript ends in. */
export async function readAcpTurns(id: string, chatId: string, cwd: string, opts: { limit?: number; before?: string | null } = {}) {
  const { page, activeTurnId, diffs } = await native.acp.turns(id, chatId, cwd, opts);
  const { turns, olderCursor } = JSON.parse(new TextDecoder().decode(page)) as { turns: TurnState[]; olderCursor: string | null };
  return { turns: turns.map((turn) => (turn.id in diffs ? { ...turn, diff: diffs[turn.id] } : turn)), olderCursor, activeTurnId };
}

/** `latest` with every page before it. A cursor that doesn't move stops it: a read that isn't going back would never end. */
async function withOlderPages(id: string, chatId: string, cwd: string, latest: Awaited<ReturnType<typeof readAcpTurns>>) {
  let page = latest;
  let turns = page.turns;
  while (page.olderCursor) {
    const cursor = page.olderCursor;
    page = await readAcpTurns(id, chatId, cwd, { limit: TURN_PAGE, before: cursor });
    turns = [...page.turns, ...turns];
    if (page.olderCursor === cursor) break;
  }
  return turns;
}

/**
 * Every turn of a native ACP history, a page at a time, each of them short on the main process's thread. A page settles
 * the session as of then, so for a session that can still say something (`active`) the newest page is taken again after
 * the older ones: its reply is the last thing read, and a caller that commits in that tick has lost nothing to the stream.
 * A cursor is how many turns come before its page, which says where that page goes on what was read.
 */
export async function readAllAcpTurns(id: string, chatId: string, cwd: string, { active = false } = {}) {
  const first = await readAcpTurns(id, chatId, cwd, { limit: TURN_PAGE });
  let turns = await withOlderPages(id, chatId, cwd, first);
  if (!active || !first.olderCursor) return { turns, activeTurnId: first.activeTurnId };
  for (;;) {
    const newest = await readAcpTurns(id, chatId, cwd, { limit: TURN_PAGE });
    const before = Number(newest.olderCursor);
    if (before < turns.length) return { turns: [...turns.slice(0, before), ...newest.turns], activeTurnId: newest.activeTurnId };
    // no turn of it was read before: the last one read can have gone on since, and what lies between hasn't been read yet
    turns = await withOlderPages(id, chatId, cwd, newest);
  }
}

/** The page of an ACP chat's turns before `cursor`, for the older history above what is shown. */
export async function loadOlderAcpTurns(id: string, cursor: string): Promise<{ turns: TurnState[]; nextCursor: string | null }> {
  const page = await readAcpTurns(id, id, getState().threads[id]?.cwd ?? '', { limit: TURN_PAGE, before: cursor });
  return { turns: page.turns, nextCursor: page.olderCursor === cursor ? null : page.olderCursor };
}

/** What ACP shows: text, reasoning and output deltas once per frame, everything else in order at once (lib/streamNotifications.ts). */
const display = createStreamNotifications(applyNotification);

/** Apply the deltas held for the next frame: they belong to turns a read is about to replace, and its page has them already. */
export const flushAcpDisplay = () => display.flush();

export async function openAcpThread(id: string) {
  if (fresh.has(id)) return patchRuntime(id, () => ({ loaded: true, loading: false }));
  const opening = beginHistoryOpen(id);
  const segments = getState().segments[id];
  const current = () => opening.owns() && nativeOf(id) === id && getState().segments[id] === segments;
  try {
    const { turns, olderCursor, activeTurnId } = await readAcpTurns(id, id, getState().threads[id]?.cwd ?? '', { limit: TURN_PAGE });
    // deltas held for the next frame belong to the turns about to be replaced
    display.flush();
    if (!current()) return;
    patchRuntime(id, (r) => {
      const kept = olderPagesKept(r.turns, r.olderCursor, turns, olderCursor);
      return {
        ...readSucceeded(r),
        loaded: true,
        loading: false,
        turns: [...kept.before, ...turns],
        olderCursor: kept.olderCursor,
        activeTurnId,
      };
    });
  } catch (e) {
    if (current()) patchRuntime(id, () => readFailed(e));
  } finally {
    opening.finish();
  }
}

export function acpRename(id: string, name: string) {
  return native.acp.rename(id, name);
}

/* ------------------------------------------------------------------ */
/* turns                                                               */
/* ------------------------------------------------------------------ */
/**
 * The message is shown at once, in a turn of its own until the harness's turnStart names it. Main
 * (electron/harness/acpTurns.cjs) builds the prompt and sends it; only the window the message came
 * from gets this.
 */
function onTurnStarting(e: Extract<AcpEvent, { kind: 'turnStarting' }>) {
  const content = buildInput(e.text, e.attachments);
  const bubble = { type: 'userMessage', id: `local-${e.clientId}`, clientId: e.clientId, content } as ThreadItem;
  patchRuntime(e.chatId, (r) => ({
    turns: addPendingTurn(
      r.turns,
      {
        ...newTurn(`pending-${e.clientId}`),
        items: e.note ? [{ type: 'statusNote', id: `note-${e.clientId}`, ...e.note } as unknown as ThreadItem, bubble] : [bubble],
      },
      e.itemId,
    ),
    activeTurnId: `pending-${e.clientId}`,
    error: null,
  }));
}

function onTurnStarted(e: Extract<AcpEvent, { kind: 'turnStarted' }>) {
  const { chatId: threadId, key: nid } = e;
  fresh.delete(nid);
  touchChat(threadId, { text: e.text });
}

function onTurnFailed(e: Extract<AcpEvent, { kind: 'turnFailed' }>) {
  patchRuntime(e.chatId, (r) => ({
    turns: r.turns.map((x) => (x.id === `pending-${e.clientId}` ? { ...x, status: 'failed', error: { message: e.error } } : x)),
    activeTurnId: r.activeTurnId === `pending-${e.clientId}` ? null : r.activeTurnId,
  }));
  // a session the harness wouldn't open for lack of quota: the same way forward as a turn that ran out
  if (isLimitError(e.error)) suggestOtherHarness(e.chatId, 'acp');
}

/** Stop on an ACP chat; `turnId`: main's id for the turn a button showed ('retired' when another one runs). */
export async function acpInterrupt(threadId: string, turnId?: string) {
  try {
    return await chatProxy.stopAcp(nativeOf(threadId), turnId);
  } catch (e) {
    toast(`Couldn't stop: ${errorText(e)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* approvals                                                           */
/* ------------------------------------------------------------------ */
/** The approval card's answer: an ACP optionId, or null (Deny without a reject option, or cancel). */
export function resolveAcpRequest(req: PendingRequest, result: unknown) {
  const r = result as { optionId?: unknown } | null | undefined;
  const optionId = typeof r?.optionId === 'string' ? r.optionId : null;
  // rejects when the answer did not reach main; resolveRequest says so and puts the card back
  return native.acp.permission(String(req.id), optionId);
}

/* ------------------------------------------------------------------ */
/* events from main                                                    */
/* ------------------------------------------------------------------ */
function note(chatId: string, kind: string, text: string, id = `${kind}-${crypto.randomUUID()}`) {
  const rt = getState().runtime[chatId];
  const last = rt?.turns[rt.turns.length - 1];
  if (!last) return;
  display.emit('item/completed', {
    threadId: chatId,
    turnId: last.id,
    item: { type: 'statusNote', id, kind, text },
  });
}

/** A scheduled run made a basic-tier chat in main, here or on a remote machine (`hostId`, whose folder is no path here): it shows in the sidebar like one started here. */
function onChatStarted(e: Extract<AcpEvent, { kind: 'chatStarted' }>) {
  if (!e.hostId) unhideFolder(e.worktreeOf ?? e.cwd);
  fresh.add(e.chatId);
  const t = Date.now();
  upsertThread({ ...acpThread({ id: e.chatId, cwd: e.cwd, createdAt: t, updatedAt: t }), projectId: e.projectId ?? null } as Thread, true);
  rememberChatProject(e.chatId, e.projectId);
  if (e.worktreeOf) setState((st) => ({ worktreeOf: { ...st.worktreeOf, [e.chatId]: e.worktreeOf! } }));
  patchRuntime(e.chatId, () => ({ loaded: true, loading: false }));
}

function onEvent(e: AcpEvent) {
  // the session patches main sent before this event (a crash, #2847) land first; a streamed update waits for the frame
  if (e.kind !== 'update') flushSessionPatches();
  const nid = e.key;
  const chatId = chatOf(nid);
  // Native updates arriving after a switch belong to the retired segment, never the current turn.
  if (nativeOf(chatId) !== nid && ['turnEnd', 'providerError', 'unattended'].includes(e.kind)) return;
  switch (e.kind) {
    case 'turnStarting':
      return onTurnStarting(e);
    case 'turnStarted':
      return onTurnStarted(e);
    case 'turnFailed':
      return onTurnFailed(e);
    case 'transcriptError':
      return toast(
        `Couldn't save the history of “${threadTitle(getState().threads[chatId])}” (${acpLabelOf(nid)}) to disk: ${e.error}. MoPilot keeps trying.`,
        'error',
      );
    case 'threadName':
      // the first message cut short, then the title the agent wrote, unless the chat was renamed meanwhile
      setState((st) =>
        st.threads[e.chatId] && (!st.threads[e.chatId].name || st.threads[e.chatId].name === e.provisional)
          ? { threads: { ...st.threads, [e.chatId]: { ...st.threads[e.chatId], name: e.name } } }
          : {},
      );
      return;
    case 'chatStarted':
      return onChatStarted(e);
    case 'turnEnd':
      // out of quota: the harness says so only in words; offer a way to go on elsewhere (`running`, from main: a late or repeated end offers nothing again)
      if (e.running && isLimitError(e.error)) suggestOtherHarness(chatId, 'acp');
      return;
    case 'permission':
      // the card is main's (SessionState approvals), and so is the notification
      return;
    case 'permissionCancelled':
      // a Host that says how a card closed ("Allowed on Pocket iPhone", "Not answered") leaves that line in the thread
      // (its id is the one the chat's history gives the same line, from the transcript record: a line is never drawn twice)
      if (e.line && isEnabled('host.unattended')) note(chatId, 'card', e.line, `card-${e.requestId}`);
      return;
    case 'session':
      noteAcpSession(nid, e.sessionId);
      if (e.note) note(chatId, 'resume', e.note);
      return;
    case 'providerError':
      return display.emit('error', providerRetryError(chatId, e.turnId, acpLabelOf(nid), e.error));
    case 'unattended':
      return note(chatId, 'unattended', `${acpLabelOf(nid)} started working with no message running, so MoPilot stopped it`);
    case 'closed':
      // main says whether a turn was running. Approval routing follows main's SessionState; this source may be an older segment.
      if (e.working)
        toast(`${acpLabelOf(nid)} quit while working. Pending approvals were cancelled · Your queued messages are kept`, 'error');
      return;
  }
}

let started = false;
export function startAcp() {
  if (started) return;
  started = true;
  native.acp.onEvent(onEvent);
  // the items main translated (electron/harness/items/acp.cjs)
  native.acp.onItems((e) => acpAgentEmit(e.chatId, display.emit)(e.method, e.params));
  native.acp.onHarnesses(adoptBasicHarnesses);
  followBasicSignIns();
  // the list comes again through onHarnesses, and the chats with the next load
  detectBasicHarnesses().catch(ignoring('list the basic harnesses at startup'));
  // a harness installed (or removed) while the app runs: the user comes back to the window after installing one
  // elsewhere, so ask then rather than at the next launch (useFreshBasics covers installs inside the app)
  window.addEventListener('focus', () => void detectBasicHarnesses());
  loadAcpThreads().catch(ignoring('list the basic-tier chats at startup'));
}

/* ------------------------------------------------------------------ */
/* modes, config options, commands                                     */
/* ------------------------------------------------------------------ */
/** The / menu and typed commands for a basic harness (commandLayer: an unlisted harness gets /xxx verbatim). */
export function acpRegistry(id: string, commands: AcpSessionState['commands']) {
  // a machine's Claude Code or Codex keeps /goal and /init as this app's own, as a chat on this Mac does
  const agent = hostFamilyOfHarness(id);
  return composeCommands(acpCommands(basicLabel(id), commands ?? null, agent ? machineCommands(agent) : []));
}
export const acpTyped = (text: string, id: string, commands: AcpSessionState['commands']) => resolveTyped(text, acpRegistry(id, commands));

/** The model a basic chat runs on, as the harness names it among its config options; null when it lists none. */
export function acpModelName(config: AcpConfigOption[] | null | undefined): string | null {
  const model = config?.find((o) => o.category === 'model');
  return model ? (optionValues(model).find((v) => v.value === model.currentValue)?.name ?? String(model.currentValue ?? '')) : null;
}

/** A select option's values, with groups flattened. */
export const optionValues: (o: AcpConfigOption) => { value: unknown; name: string; description?: string | null }[] = selectValues;

/** Change the chat's mode; false (and said why) when the harness refused, so it keeps the old one. */
export async function setAcpMode(chatId: string, modeId: string): Promise<boolean> {
  return native.acp.setMode(nativeOf(chatId), modeId).then(
    () => true,
    (e) => (toast(`Couldn't change the mode: ${errorText(e)}`, 'error'), false),
  );
}

/** Change one of the chat's config options; false (and said why) when the harness refused, so it keeps the old value. */
export async function setAcpConfig(chatId: string, configId: string, value: unknown): Promise<boolean> {
  return native.acp.setConfigOption(nativeOf(chatId), configId, value).then(
    () => true,
    (e) => (toast(`Couldn't change it: ${errorText(e)}`, 'error'), false),
  );
}
