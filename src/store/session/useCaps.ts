// What a chat can do, per semantic: native, sage, route, disabled (with a reason and a fix) or absent.
// Main resolves it from the chat's current segment, provider, model, account, flags and session state
// (electron/session/caps.cjs); a window asks again when the chat's session changes or main says
// something capabilities read has changed. Components read this, never the harness's name.
import { useMemo } from 'react';
import { useEffectOn } from '../../lib/effects';
import { create } from 'zustand';
import { SEMANTICS, type Semantic } from '../../harness/adapter';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { useSessionField, sessionOf } from './useSession';
import type { SessionState } from './sessionState';
import type { CapView, Caps, CapsHint, ChatCaps } from './capsTypes';

export type { CapView, Caps, CapsHint, ChatCaps } from './capsTypes';

const ABSENT: CapView = Object.freeze({
  state: 'absent',
  via: 'none',
  why: Object.freeze({ layer: 'harness', code: 'harness.undeclared' }),
}) as CapView;
/** Until main has answered: nothing is offered. */
export const NO_CAPS: ChatCaps = Object.freeze({
  kind: 'codex',
  tier: 'first',
  caps: Object.freeze(Object.fromEntries(SEMANTICS.map((s) => [s, ABSENT]))) as Caps,
}) as ChatCaps;

/** What main's caps read of the chat's session (electron/session/caps.cjs): a patch of anything else leaves the caps as they are. */
const capsInputs = (s: SessionState) => ({
  turn: s.turn,
  runningElsewhere: s.runningElsewhere,
  acp: s.acp,
  // a model or harness change mid-turn-idle shows here first
  modality: s.modality,
  pendingSwitch: s.pendingSwitch,
});
type CapsInputs = ReturnType<typeof capsInputs>;
const sameInputs = (a: CapsInputs, b: CapsInputs) =>
  a.turn === b.turn &&
  a.runningElsewhere === b.runningElsewhere &&
  a.acp === b.acp &&
  a.modality === b.modality &&
  a.pendingSwitch === b.pendingSwitch;
// the session's objects by identity: a request key names them without serializing a catalog on every read
const objectIds = new WeakMap<object, number>();
let lastObjectId = 0;
const idOf = (o: object | null) => {
  if (o === null) return 0;
  let id = objectIds.get(o);
  if (id === undefined) objectIds.set(o, (id = ++lastObjectId));
  return id;
};

interface CapsStore {
  byKey: Record<string, { value: ChatCaps; inputs: CapsInputs; gen: number }>;
  /** bumped when main says something capabilities read has changed */
  gen: number;
}
export const useCapsStore = create<CapsStore>(() => ({ byKey: {}, gen: 0 }));

const hintKey = (hint?: CapsHint) => (hint ? JSON.stringify([hint.kind, hint.model, hint.temporary, hint.elsewhere]) : '');
const keyOf = (chatId: string | null | undefined, hint?: CapsHint) => `${chatId ?? ''}|${hintKey(hint)}`;
const fetching = new Map<string, Promise<void>>();

function fetchCaps(chatId: string | null | undefined, hint: CapsHint | undefined, inputs: CapsInputs, gen: number): Promise<void> {
  const key = keyOf(chatId, hint);
  const requestKey = JSON.stringify([
    key,
    inputs.turn,
    inputs.runningElsewhere,
    idOf(inputs.acp),
    inputs.modality,
    idOf(inputs.pendingSwitch),
    gen,
  ]);
  const cur = fetching.get(requestKey);
  if (cur !== undefined) return cur;
  const p = native.session
    .caps(chatId ?? null, hint)
    .then((c) => {
      if (c && useCapsStore.getState().gen === gen && sameInputs(capsInputs(sessionOf(chatId)), inputs))
        useCapsStore.setState((s) => ({ byKey: { ...s.byKey, [key]: { value: c, inputs, gen } } }));
    })
    // the caps stay unloaded (loaded: false); the next change of its inputs or caps change asks again
    .catch((error) => noteIgnored("read a chat's capabilities", error))
    .finally(() => fetching.delete(requestKey));
  fetching.set(requestKey, p);
  return p;
}

let started = false;
/** Follow main's "capabilities changed" notice (once per window). */
export function startCaps() {
  if (started) return;
  started = true;
  native.session.onCapsChanged(() => useCapsStore.setState((s) => ({ gen: s.gen + 1 })));
}

/** The chat's capabilities now, straight from main; null when unknown (main couldn't resolve them, or the request failed). */
export async function capsOf(chatId: string | null | undefined, hint?: CapsHint): Promise<ChatCaps | null> {
  return native.session.caps(chatId ?? null, hint).catch((error) => (noteIgnored("read a chat's capabilities", error), null));
}

/** Capabilities with their harness and tier. `chatId` null: a chat that hasn't started (give `hint.kind`). */
export function useChatCaps(chatId: string | null | undefined, hint?: CapsHint): ChatCaps & { loaded: boolean } {
  const key = keyOf(chatId, hint);
  const inputs = useSessionField(chatId, capsInputs);
  const gen = useCapsStore((s) => s.gen);
  const got = useCapsStore((s) => s.byKey[key]);
  // Asked again when the chat or the hint's values change (the key; callers rebuild the hint object every
  // render), when what caps read of the chat's session changes or when main says capabilities changed. Each ask reads this
  // render's chat and hint, so every harness is asked the same way.
  useEffectOn([key, inputs, gen], () => {
    startCaps();
    // cannot reject: fetchCaps records a failed read and leaves the caps unloaded
    void fetchCaps(chatId, hint, inputs, gen);
  });
  return useMemo(
    () => (got && sameInputs(got.inputs, inputs) && got.gen === gen ? { ...got.value, loaded: true } : { ...NO_CAPS, loaded: false }),
    [got, inputs, gen],
  );
}

/** Per semantic: { state, via, why?, fix? }. */
export function useCaps(chatId: string | null | undefined, hint?: CapsHint): Caps {
  return useChatCaps(chatId, hint).caps;
}

/** One semantic. */
export function useCap(chatId: string | null | undefined, semantic: Semantic, hint?: CapsHint): CapView {
  return useChatCaps(chatId, hint).caps[semantic];
}
