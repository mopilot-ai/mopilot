// Chat ids across native sessions, the harness a chat or new chat uses, and notes added to chats. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { hostOfChatNow, onMachineNow } from '../lib/hostChats';
import type { AppState } from './state';
import type { HarnessKind, Semantic } from '../harness/adapter';
import { native, type MigrationStatus } from '../lib/native';
import { harnessEnabled } from '../lib/flags';
import { codexBlocked, codexIncompatible } from '../harness/codexCompat';
import { codexState } from '../harness/codexState';
import type { ChatNote } from '../lib/chatMeta';
import { rememberedNewChatHost, type PermissionMode, type ThreadItem, type StatusNoteItem } from './types';
import { admittedBasics } from '../harness/launch';
import { basicIdOf, defaultHarnessNote, resolveDefaultHarness, type DefaultFallback, type DefaultHarness } from '../harness/defaultHarness';
import { ownTable } from '../../shared/ownTable.mjs';
import { currentNativeId } from '../harness/ownership';
import { HARNESS_IDS, HARNESS_LABEL, acpHarnessOf, type HarnessId, type HarnessModel } from '../harness/types';
import { TEMPORARY_BASIC_HARNESS, currentFamily, firstTierOf, otherFirstTier, type HarnessFamily } from '../harness/family';
import { harnessKindOf } from '../harness/registry';
import { setSession } from './session/useSession';
import { segmentAliases } from '../../shared/segmentAlias.mjs';
import { get, set, setPrefs, toast, toastFailure, patchTurn } from './core';
import { isMomoChat } from '../lib/momoChats';
import { dispatchComposerCommand } from '../lib/shortcutFocus';
import { modelLabel } from '../lib/format';
import { contextTokens } from '../lib/contextFormat';
import { reportedTokenUsage } from './contextUsage';
import { limitNoteText } from '../harness/limitNote';
import { switchHarnessAtLimit } from '../../shared/limitPolicy.mjs';
import { ALREADY_ENDED, ALREADY_SWITCHED } from './liveAction';
import { runtime } from './runtime';
import { replaceDraftHarness } from './draftHarness';

/* ------------------------------------------------------------------ */
/* chats that span several native sessions (design §05)                */
/* ------------------------------------------------------------------ */
let aliasSource: AppState['segments'] | null = null;
let aliasMap = new Map<string, string>();
/** The chat a native session belongs to (itself when it was never part of a switch). */
export function chatOf(nativeId: string): string {
  const segs = get().segments;
  if (segs !== aliasSource) {
    aliasSource = segs;
    // main's rule (ChatController.chatOf): a switch's session is the switched chat's, whatever else names it
    aliasMap = segmentAliases(Object.entries(segs).map(([chat, list]) => [chat, list.map((seg) => seg.nativeId)]));
  }
  return aliasMap.get(nativeId) ?? nativeId;
}
/** The native session the chat's next message goes to. */
export function nativeOf(chatId: string): string {
  return currentNativeId(get().segments[chatId], chatId);
}
/** The family of the chat's current harness: Codex, Claude Code, or a basic harness over ACP. */
export const chatFamily = (chatId: string): HarnessFamily => currentFamily(get().segments[chatId], chatId);
/** The harness a chat's usage data names (its turns and ratings): Codex, Claude Code, or the basic harness's kind (acp:kimi). */
export const usageHarnessOf = (chatId: string): string => firstTierOf(chatFamily(chatId)) ?? harnessKindOf(nativeOf(chatId));
/** The basic harness a chat runs on ('kimi' for 'acp:kimi:…'), or null for Codex and Claude Code. */
export const chatBasicHarness = (chatId: string, s: AppState = get()): string | null =>
  acpHarnessOf(currentNativeId(s.segments[chatId], chatId));
/** The harness a chat runs on now ('codex', 'claude' or 'acp:<id>'): its own, whatever the default for new chats is. */
export const chatKind = (chatId: string, s: AppState = get()): HarnessKind => {
  const basic = chatBasicHarness(chatId, s);
  return basic ? `acp:${basic}` : firstTierOf(chatFamily(chatId))!;
};
/** What the chat's current harness is called ('Codex', 'Claude Code', 'Kimi Code'). */
export const chatHarnessLabel = (chatId: string) => {
  const h = firstTierOf(chatFamily(chatId));
  return h ? HARNESS_LABEL[h] : runtime().acpLabelOf(nativeOf(chatId));
};
/** Codex is connected and signed in. */
export const codexUsable = (s: AppState = get()) =>
  harnessEnabled('codex') && s.conn === 'ready' && !s.requiresAuth && !codexIncompatible(s.codexCompat);

/**
 * What the harness itself has turned off: on Codex, a capability whose runtime probe failed or whose feature
 * is off (WP5-20). Claude Code and the basic harnesses say so through main's caps instead.
 */
const HARNESS_BLOCKED: Record<HarnessFamily, (s: Semantic) => string | null> = {
  codex: (s) => codexBlocked(get().codexCompat, s),
  claude: () => null,
  acp: () => null,
};
/** Why a semantic can't be used in this chat (or a new one) right now, or null. Only that capability is greyed out. */
export function blockedReason(chatId: string | null, s: Semantic): string | null {
  return HARNESS_BLOCKED[chatId ? chatFamily(chatId) : newChatFamily()](s);
}
/** Claude Code is installed and signed in (subscription or API key). */
export const claudeUsable = (s: AppState = get()) =>
  harnessEnabled('claude') && (s.claude.status.state === 'ready' || s.claude.status.state === 'apikey');
/** What the store knows of each first-tier harness: whether it can run, is being looked for, and what a switch to it would pick. */
interface FirstTierState {
  usable(s: AppState): boolean;
  /** being looked for right now: Codex connecting, Claude Code detecting */
  pending(s: AppState): boolean;
  /** why it can't run, when the store knows (#1872): a first run with Codex signed out says so, not "can't run" */
  why(s: AppState): DefaultFallback | undefined;
  /** the model new chats on it start with */
  model(s: AppState): string | null;
  models(s: AppState): Pick<HarnessModel, 'id' | 'label' | 'isDefault'>[];
}
/** A first-tier harness's states that say why it can't run; any other says it just can't. */
const WHY: Partial<Record<string, DefaultFallback>> = ownTable({ signin: 'signin', missing: 'missing' });
const FIRST_TIER: Record<HarnessId, FirstTierState> = {
  codex: {
    usable: (s) => codexUsable(s),
    pending: (s) => s.conn === 'connecting',
    why: (s) => (!harnessEnabled('codex') ? 'off' : WHY[codexState(s) ?? '']),
    model: (s) => s.prefs.model,
    // the label the picker shows ("GPT-6.1 Sol"): it becomes the switch divider's model name
    models: (s) => s.models.map((m) => ({ id: m.model, label: modelLabel(m.displayName), isDefault: m.isDefault })),
  },
  claude: {
    usable: (s) => claudeUsable(s),
    pending: (s) => s.claude.status.state === 'detecting',
    why: (s) => (!harnessEnabled('claude') ? 'off' : WHY[s.claude.status.state]),
    model: (s) => s.prefs.claudeSelection.model,
    models: (s) => s.claude.models,
  },
};
export const harnessUsable = (h: HarnessId, s: AppState = get()) => FIRST_TIER[h].usable(s);
const harnessPending = (h: HarnessId, s: AppState) => FIRST_TIER[h].pending(s);
/** The harness the user picked for new chats, as saved; what runs is defaultHarness(s).kind. */
export const savedDefaultHarness = (s: AppState = get()): HarnessKind => s.prefs.defaultHarness;
/**
 * The default harness for new chats, resolved against what can run now (harness/defaultHarness.ts): every page that
 * shows or uses the default reads it here. A selector takes a field of it, never the object (a new one each call).
 */
const resolveFor = (saved: HarnessKind, s: AppState): DefaultHarness =>
  resolveDefaultHarness({
    saved,
    usable: { codex: harnessUsable('codex', s), claude: harnessUsable('claude', s) },
    pending: { codex: harnessPending('codex', s), claude: harnessPending('claude', s) },
    why: { codex: FIRST_TIER.codex.why(s), claude: FIRST_TIER.claude.why(s) },
    basics: s.basicHarnesses,
  });
/** The harness the next new chat starts on: this draft's pick in the model picker, else the saved default. */
export const defaultHarness = (s: AppState = get()): DefaultHarness => resolveFor(s.newChatHarnessPick ?? savedDefaultHarness(s), s);
/** The saved default alone, resolved: what Settings and scheduled tasks use, whatever the open draft picked. */
export const savedDefaultResolved = (s: AppState = get()): DefaultHarness => resolveFor(savedDefaultHarness(s), s);
/** What a page showing the default says while it can't run and another harness stands in, or null (a selector can read it). */
export const defaultHarnessFallbackNote = (s: AppState = get()) => defaultHarnessNote(defaultHarness(s));
/** Make `kind` the harness new chats start on. Existing chats keep their own harness. */
export const setDefaultHarness = (kind: HarnessKind) => {
  set((s) => replaceDraftHarness(s, null));
  setPrefs({ defaultHarness: kind });
};
/**
 * The harness picked in a new chat's model picker: for this draft only, never the saved default (that changes only in
 * Settings → New chats use). Picking the saved default again clears the pick.
 */
export const pickNewChatHarness = (kind: HarnessKind) => set((s) => replaceDraftHarness(s, kind === savedDefaultHarness(s) ? null : kind));
/**
 * The first-tier harness new chats use: the default when it is Codex or Claude Code (or the other one while it can't
 * run), and Codex's or Claude's side of things when the default is a basic harness.
 */
export const newChatHarness = (s: AppState = get()): HarnessId => defaultHarness(s).firstTier;
/**
 * A new chat from the tray or the Mini bar starts from the default harness's own defaults: what the
 * last new chat set up (a temporary chat, a Codex Cloud environment, its own Worktree choice) doesn't
 * carry over. The model, effort, Fast and the Worktree switch's setting come from the saved prefs.
 */
export function resetNewChatDefaults() {
  set((s) => ({
    newChatTemporary: false,
    newChatCloudEnv: null,
    newChatRepositoryGroup: undefined,
    newChatWorktree: null,
    newChatWorktreeHintOff: null,
    newChatBranch: null,
    newChatWorkspace: null,
    ...replaceDraftHarness(s, null),
  }));
}
/** Whether the next new chat asks for a worktree: this draft's own choice, else the saved default (off until the user turns it on). */
export function newChatWorktreeOn(s: AppState = get()): boolean {
  return s.newChatWorktree ?? s.prefs.worktreeDefault === true;
}
/** The Worktree switch (the context bar's or /worktree): this chat's and, as in Claude's desktop app, later new chats' setting. */
export function setNewChatWorktree(on: boolean) {
  set({ newChatWorktree: null });
  setPrefs({ worktreeDefault: on });
}

/** An explicit Run on choice changes the default for later drafts. */
export function rememberRunOn({ id, name }: { id: string; name: string }) {
  const lastNewChatHost = id === 'local' ? null : { id, name };
  if (get().prefs.lastNewChatHost?.id !== lastNewChatHost?.id) setPrefs({ lastNewChatHost });
  else void native.prefs.patch({ lastNewChatHost }, []).catch(toastFailure("Couldn't save the Run on choice"));
}

/** Clear the local project. Regular New chat uses the last Run on choice. */
export function clearNewChatProject(reuseRunOn = false) {
  const local = { newChatProjectId: 'none', newChatCwd: null, newChatRepositoryGroup: undefined };
  if (!reuseRunOn) return set((s) => (s.newChatRepositoryGroup ? { ...local, newChatCloudEnv: null } : local));
  set((s) => {
    const active = s.newChatHost?.id === s.prefs.lastNewChatHost?.id ? s.newChatHost : null;
    const remembered = rememberedNewChatHost(s.prefs, active?.path);
    return {
      ...local,
      newChatProjectId: remembered ? null : 'none',
      newChatHost: remembered,
      newChatCloudEnv: remembered || s.newChatRepositoryGroup ? null : s.newChatCloudEnv,
      newChatTemporary: false,
    };
  });
}
/** The basic harness new chats start on ('opencode' for 'acp:opencode'), or null when they start on Codex or Claude Code. */
export function newChatBasic(s: AppState = get()): string | null {
  return basicIdOf(defaultHarness(s).kind);
}
/**
 * The family the next new chat runs on: a picked basic harness, or newChatHarness. A temporary chat can't be kept off
 * disk by a basic-tier harness, so one picked there runs on TEMPORARY_BASIC_HARNESS (RoutingChip says so).
 */
export function newChatFamily(s: AppState = get()): HarnessFamily {
  if (!newChatBasic(s)) return newChatHarness(s);
  return s.newChatTemporary ? TEMPORARY_BASIC_HARNESS : 'acp';
}
/**
 * Why ⇧⌘N can't start a temporary chat now, or null. One picked on a basic harness runs on TEMPORARY_BASIC_HARNESS,
 * so that harness has to run here; one still being looked for may yet, and is let through.
 */
export function temporaryChatBlocked(s: AppState = get()): string | null {
  if (!newChatBasic(s) || harnessUsable(TEMPORARY_BASIC_HARNESS, s) || harnessPending(TEMPORARY_BASIC_HARNESS, s)) return null;
  const label = HARNESS_LABEL[TEMPORARY_BASIC_HARNESS];
  return `Temporary chats need ${label}. Sign in to it or install it first`;
}
/**
 * The harness kind the next new chat runs on, for a capability read: first-tier, or 'acp:<id>' on a picked basic harness
 * (a temporary one runs on TEMPORARY_BASIC_HARNESS, as newChatFamily says).
 */
export const newChatKind = (s: AppState = get()): HarnessKind => {
  const basic = newChatBasic(s);
  if (!basic) return newChatHarness(s);
  return s.newChatTemporary ? TEMPORARY_BASIC_HARNESS : `acp:${basic}`;
};
/** What the harness itself has turned off for a semantic (Codex's failed probes), for a harness picked by the caller. */
export const harnessBlocked = (family: HarnessFamily, s: Semantic): string | null => HARNESS_BLOCKED[family](s);
/** Something can run a chat: Codex, Claude Code or an admitted basic harness. */
export const anyHarnessUsable = (s: AppState = get()) => codexUsable(s) || claudeUsable(s) || admittedBasics(s.basicHarnesses).length > 0;
/** A harness that could still turn out usable is being looked for: Codex connecting, Claude detecting, a basic harness listed or probed. */
export const harnessesChecking = (s: AppState = get()) =>
  s.conn === 'connecting' ||
  s.claude.status.state === 'detecting' ||
  !s.basicListed ||
  s.basicHarnesses.some((h) => h.state === 'checking');
/** Native sessions that are later segments of some chat; the sidebar hides them. */
export function segmentNatives(segs: AppState['segments']): Set<string> {
  const out = new Set<string>();
  for (const [chat, list] of Object.entries(segs)) for (const seg of list) if (seg.nativeId !== chat) out.add(seg.nativeId);
  return out;
}

/** Model each chat last ran on this session, to mark a model change in the thread. */
const lastModels = new Map<string, string>();
export function setLastModel(chatId: string, model: string | null) {
  if (model) lastModels.set(chatId, model);
  // a removed chat's entry would otherwise stay for the life of the window: an entry whose chat is missing from the list
  // on two reports in a row goes (a chat just created is listed by its next report)
  const threads = get().threads;
  for (const id of lastModels.keys()) {
    if (id === chatId || threads[id]) missingModels.delete(id);
    else if (missingModels.delete(id)) lastModels.delete(id);
    else missingModels.add(id);
  }
}
const missingModels = new Set<string>();
/**
 * The context windows a harness reported, by the model that was running when it did: nothing else says how big a
 * model's window is (the CLI's and Codex's model lists carry no size), so a model not yet run in this window has none,
 * unless its id says.
 */
const reportedWindows = new Map<string, number>();
const windowOf = (model: string) => reportedWindows.get(model) ?? (/\[1m\]/i.test(model) ? 1_000_000 : null);

/** A report of the chat's current segment arrived: its window is the window of the model the chat's latest turn runs on. */
export function noteReportedWindow(chatId: string, window: number | null | undefined) {
  const model = lastModels.get(chatId) ?? get().runtime[chatId]?.settings?.model ?? null;
  if (model && window && window > 0) reportedWindows.set(model, window);
}

/**
 * A one-line note when the chat's model changed since its last turn (P5), plus a warning when the chat is already over
 * the new model's window (`warn`: in the window the message was sent from). A window nobody reported is not guessed:
 * a chat is never told it is over a size the model does not have.
 */
export function modelChangeNote(chatId: string, model: string | null, label: string, warn = true) {
  if (!model) return null;
  const prev = lastModels.get(chatId) ?? get().runtime[chatId]?.settings?.model ?? null;
  lastModels.set(chatId, model);
  if (!prev || prev === model) return null;
  const win = windowOf(model);
  // what the chat holds is the current segment's report: a replaced harness's is not this chat's context
  const used = reportedTokenUsage(get(), chatId)?.last?.inputTokens ?? 0;
  if (win !== null && used > win && warn) toast(`This chat is over ${label}'s ${contextTokens(win)} window. Compacting first`, 'error');
  return { kind: 'model', text: `Model changed to ${label}` };
}

/**
 * A line in the chat saying it moved to another account, kept in the chat's v2 file so it is still
 * there after a reload (D-65). Returns false when the chat has no turns yet.
 */
export function accountNote(chatId: string, text: string, savedId?: string) {
  const rt = get().runtime[chatId];
  const last = rt?.turns[rt.turns.length - 1];
  if (!last) return false;
  // main wrote the note into the chat's file itself (it arrives with chats:changed): only show it here
  if (savedId) {
    if (!last.items.some((i) => i.id === savedId))
      patchTurn(chatId, last.id, (t) => ({
        items: [...t.items, { type: 'statusNote', id: savedId, kind: 'account', text } satisfies StatusNoteItem as unknown as ThreadItem],
      }));
    return true;
  }
  const note: ChatNote = {
    id: `account-${crypto.randomUUID()}`,
    kind: 'account',
    text,
    turnId: last.id.startsWith('pending-') ? null : last.id,
    turn: rt.turns.length - 1,
    at: Date.now(),
  };
  patchTurn(chatId, last.id, (t) => ({
    items: [...t.items, { type: 'statusNote', id: note.id, kind: 'account', text } satisfies StatusNoteItem as unknown as ThreadItem],
  }));
  set((s) => ({ chatNotes: { ...s.chatNotes, [chatId]: [...(s.chatNotes[chatId] ?? []), note] } }));
  return true;
}

/** How a chat that ran out of quota goes on: what the note says, and the action its note and toast offer. */
interface LimitWayForward {
  text: string;
  /** A destination exists; main still checks source accounts and policy before it actually switches. */
  canAutoSwitch?: boolean;
  action: { label: string; run: () => unknown };
}

/** A Settings page, opened from a note (loaded on use: the panes module reads the store). */
export const openSettings = (section: string) => () =>
  void import('./panes').then(({ navigate }) => navigate({ name: 'settings', section }), toastFailure("Couldn't open Settings"));

/** A first-tier chat switches in place to the other first-tier harness (automatic handoff, with the next message). */
function inPlaceWayForward(chatId: string, from: HarnessId): LimitWayForward {
  const other = otherFirstTier(from);
  const s = get();
  const models = FIRST_TIER[other].models(s);
  const model = models.find((m) => m.id === FIRST_TIER[other].model(s)) ?? models.find((m) => m.isDefault) ?? models[0];
  const can = harnessUsable(other, s) && !!model;
  return {
    text: limitNoteText(HARNESS_LABEL[from], HARNESS_LABEL[other], can),
    ...(can ? { canAutoSwitch: true } : {}),
    // the switch where it can run, else where the other harness is set up
    action:
      can && model
        ? {
            label: `Continue on ${HARNESS_LABEL[other]}`,
            run: () =>
              setSession(chatId, {
                pendingSwitch: { harness: other, model: FIRST_TIER[other].model(get()), modelLabel: model.label, mode: 'auto' },
              }),
          }
        : { label: `Set up ${HARNESS_LABEL[other]}`, run: openSettings(other) },
  };
}

/**
 * Each family's way forward at its usage limit. ACP continues in the same chat on the new-chat harness,
 * or the first first-tier harness with a usable model; otherwise it offers setup.
 */
const LIMIT_WAY_FORWARD: Record<HarnessFamily, (chatId: string) => LimitWayForward> = {
  codex: (chatId) => inPlaceWayForward(chatId, 'codex'),
  claude: (chatId) => inPlaceWayForward(chatId, 'claude'),
  acp: (chatId) => {
    const label = chatHarnessLabel(chatId);
    // the harness new chats start on, else the first that can run
    const to = [newChatHarness(), ...HARNESS_IDS].find((h) => harnessUsable(h) && FIRST_TIER[h].models(get()).length > 0);
    if (!to)
      return {
        text: `${label} limit reached. Set up another harness to continue.`,
        action: { label: 'Harness settings', run: openSettings('harnesses') },
      };
    const models = FIRST_TIER[to].models(get());
    const model = models.find((m) => m.id === FIRST_TIER[to].model(get())) ?? models.find((m) => m.isDefault) ?? models[0];
    return {
      text: `${label} limit reached. Continue on ${HARNESS_LABEL[to]} in this chat.`,
      canAutoSwitch: true,
      action: {
        label: `Continue on ${HARNESS_LABEL[to]}`,
        run: () =>
          void setSession(chatId, {
            pendingSwitch: { harness: to, model: FIRST_TIER[to].model(get()), modelLabel: model.label, mode: 'auto' },
          }),
      },
    };
  },
};

/** A chat's way on at its usage limit (limitNote.ts's text, and the action), worked out now. */
/**
 * A chat's way on at its usage limit: its family's, or in a MoMo chat its brain chip (only MoMo's brain moves it to
 * another harness; main refuses a window's switch, shared/momoCommands.mjs).
 */
function wayForward(chatId: string, from: HarnessFamily): LimitWayForward {
  // a chat on a machine ran out on that machine's account: this Mac's harnesses and logins are not a way on for it. One whose machine is
  // not known yet (the chats on machines are still being read) is offered nothing of this Mac's either, and is not said to be on a machine
  if (onMachineNow(chatId)) {
    const where = hostOfChatNow(chatId) ? " on this chat's machine" : '';
    return { text: `${chatHarnessLabel(chatId)} limit reached${where}.`, action: { label: 'Machines', run: openSettings('connections') } };
  }
  if (!isMomoChat(get().momoChats, chatId)) return LIMIT_WAY_FORWARD[from](chatId);
  const text = `${chatHarnessLabel(chatId)} limit reached. Change MoMo's brain to continue.`;
  return { text, action: { label: 'Change brain', run: () => dispatchComposerCommand('open-model-picker') } };
}
export const limitNoteWay = (chatId: string) => wayForward(chatId, chatFamily(chatId));
/** The way on a chat's usage-limit note offers when clicked, worked out then (the other harness may be set up since). */
export const limitNoteAction = (chatId: string) => limitNoteWay(chatId).action;

/** The limit turns already taken up: every harness reports a limit more than once. */
const limitSeen = new Set<string>();

/**
 * When a chat's harness runs out of quota, note it once and point at continuing on another harness (design §05). Main
 * may switch when opted in (Settings → General, electron/session/limitContinue.cjs), so its toast stays away. The note
 * offers recovery until main confirms a switch; `transient`: a pause that names no end of quota.
 */
export function suggestOtherHarness(chatId: string, from: HarnessFamily, note = true, transient = false) {
  const way = wayForward(chatId, from);
  const rt = get().runtime[chatId];
  const last = rt?.turns[rt.turns.length - 1];
  const auto = !transient && !!way.canAutoSwitch && switchHarnessAtLimit(get().prefs);
  if (auto && last) {
    if (limitSeen.has(`${chatId}:${last.id}`)) return;
    limitSeen.add(`${chatId}:${last.id}`);
  }
  if (note && last && !last.items.some((i: ThreadItem | StatusNoteItem) => i.type === 'statusNote' && i.kind === 'limit'))
    patchTurn(chatId, last.id, (t) => ({
      items: [
        ...t.items,
        {
          type: 'statusNote',
          id: `limit-${crypto.randomUUID()}`,
          kind: 'limit',
          text: way.text,
        } satisfies StatusNoteItem as unknown as ThreadItem,
      ],
    }));
  // An opted-in automatic switch needs no extra toast; the note keeps its manual recovery action.
  if (auto) return;
  // one click readies the way forward, worked out at the click like the note's
  const { label } = way.action;
  toast(way.text, 'error', { action: { label, run: () => takeWayForward(chatId, from, label) } });
}

/**
 * The limit toast's way forward, read at the click: the chat may have switched since the toast showed (it says so and
 * does nothing), and the other harness's model may have changed (the switch takes it as it is now). A way that is no
 * longer the one the button named (that harness can't run now) does nothing either: the chat's note offers the new one.
 */
function takeWayForward(chatId: string, from: HarnessFamily, label: string) {
  if (chatFamily(chatId) !== from) return toast(ALREADY_SWITCHED);
  const { action } = wayForward(chatId, from);
  if (action.label !== label) return toast(ALREADY_ENDED);
  action.run();
}

/* ------------------------------------------------------------------ */
/* permission / sandbox mapping                                        */
/* ------------------------------------------------------------------ */
export function permissionParams(mode: PermissionMode, cwd?: string | null) {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' as const };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' as const, approvalsReviewer: 'user' };
    case 'auto-review':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' as const, approvalsReviewer: 'auto_review' };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' as const, approvalsReviewer: 'user' };
  }
}

/** Tell the user when moving chat data to the v2 files didn't finish (the legacy data is untouched). */
export function migrationNotice(list: MigrationStatus[]) {
  // the built-in browser's cookies from before the rename: some couldn't be carried over (D-83)
  if (list.some((x) => x.id === 'cookies-v1'))
    toast('Some sites in the built-in browser will ask you to sign in again', 'info', { duration: 15000 });
  const m = list.find((x) => x.id !== 'cookies-v1' && x.result !== 'ok' && x.result !== 'done');
  set({ migrationIssue: m && (m.result === 'failed' || m.result === 'error') ? m : null });
  if (!m) return;
  if (m.result === 'deferred') return toast('Not enough disk space to move chat data. Retrying next launch.', 'error');
  if (m.result === 'newer')
    return toast('This data comes from a newer version of MoPilot and opens read-only', 'error', {
      action: { label: 'Check for updates', run: openSettings('about') },
    });
  // failed or error: the sidebar banner (MigrationBanner) says so and offers Retry
}

/** Run the chat-data migration again (the banner's and Settings' Retry). */
export const retryMigration = () => native.chats.retryMigration().then(migrationNotice);
/** Settings' Restore pre-migration data: back to the legacy files, kept until Retry. */
export const restoreMigration = () =>
  native.chats.restoreMigration().then((r) => (r ? migrationNotice(r) : toast('There is no backup to restore', 'error')));
