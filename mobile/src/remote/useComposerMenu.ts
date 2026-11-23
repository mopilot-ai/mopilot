// The / and @ menus of an open chat's composer: opens where the caret is, loads what the computer lists, applies a pick to the draft, and holds the skills the next message carries.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Owned } from './client';
import {
  type Command,
  type Mention,
  loadCommands,
  loadMentions,
  type MenuScope,
  matchCommands,
  menusOffered,
  pickCommand,
  pickMention,
  popupAt,
} from './composerMenu';

/** How many skills one message carries (the computer's limit). */
const MAX_SKILLS = 10;
/** Typing in an @ menu asks the computer once the fingers pause. */
const MENTION_DELAY_MS = 150;

/** Emptying a list that is empty already keeps the list it was, so nothing that depends on it runs again. */
const none = (old: string[]) => (old.length ? [] : old);

type Rows = { kind: 'slash'; rows: Command[] } | { kind: 'mention'; rows: Mention[] };
/** What the open menu shows: its rows, whether they are still on their way, and why they could not be read. */
export type Menu = Rows & { status: 'loading' | 'ready' | 'error'; error: string | null };

/** `scope` is an open chat's id, or the agent and saved project a new chat starts with; another one has its own menus and skills. */
export function useComposerMenu(request: Owned, scope: MenuScope, draft: string, setDraft: (text: string) => void) {
  const chatId = typeof scope === 'string' ? scope : null;
  const harness = typeof scope === 'string' ? null : scope.harness;
  const projectId = typeof scope === 'string' ? null : scope.projectId;
  const target = useMemo<MenuScope>(() => (chatId !== null ? chatId : { harness: harness!, projectId }), [chatId, harness, projectId]);
  // where the field last said its caret is, and the text that was in it then: for any other text the caret is at the end, where the person types
  const [caret, setCaret] = useState<{ at: number; text: string } | null>(null);
  const [placed, setPlaced] = useState<{ start: number; end: number } | null>(null);
  // the file mentions a pick wrote, which do not open the menu again while they stand
  const [applied, setApplied] = useState<string[]>([]);
  const [skills, setSkills] = useState<string[]>([]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const offered = useRef<ReturnType<typeof menusOffered> | null>(null);
  const commands = useRef<Command[] | null>(null);
  // the text last typed or set, which the caret the field reports belongs to
  const latest = useRef(draft);
  latest.current = draft;
  // another chat has its own menus and skills
  useEffect(() => {
    void target;
    void request;
    offered.current = null;
    commands.current = null;
    setCaret(null);
    setPlaced(null);
    setApplied(none);
    setSkills(none);
    setMenu(null);
  }, [target, request]);
  // a sent message leaves an empty box: its file mentions are done with
  useEffect(() => {
    if (!draft) setApplied(none);
  }, [draft]);
  const at = caret?.text === draft ? Math.min(caret.at, draft.length) : draft.length;
  const popup = useMemo(() => popupAt(draft, at, applied), [draft, at, applied]);
  useEffect(() => {
    if (!popup) {
      // the next time it opens it reads the list again: the chat may have changed harness since
      commands.current = null;
      setMenu(null);
      return;
    }
    let active = true;
    const run = async () => {
      try {
        offered.current ??= menusOffered(request, target);
        const has = await offered.current;
        if (!active) return;
        if (popup.kind === 'slash') {
          if (!has.commands) return active && setMenu(null);
          const loaded = commands.current ?? (await loadCommands(request, target));
          if (active) commands.current = loaded;
          if (active) setMenu({ kind: 'slash', rows: matchCommands(loaded, popup), status: 'ready', error: null });
        } else {
          if (!has.mentions) return active && setMenu(null);
          const rows = await loadMentions(request, target, popup.query);
          if (active) setMenu({ kind: 'mention', rows, status: 'ready', error: null });
        }
      } catch (e) {
        // the request is bound to the computer and says why it failed as an Error
        if (active) setMenu({ kind: popup.kind, rows: [], status: 'error', error: (e as Error).message } as Menu);
      }
    };
    // rows already shown are for what was typed before: they wait, not pressable, until the list for what is typed now arrives
    setMenu((old) => ({ kind: popup.kind, rows: old?.kind === popup.kind ? old.rows : [], status: 'loading', error: null }) as Menu);
    // the commands are one list the computer sends once; an @ list is asked for again as the name is typed, once the fingers pause
    const timer = popup.kind === 'mention' ? setTimeout(() => void run(), MENTION_DELAY_MS) : undefined;
    if (!timer) void run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [popup, target, request]);
  // a position asked of the field is asked once: the render that carried it has told the field
  useEffect(() => {
    if (placed) setPlaced(null);
  }, [placed]);
  const place = (text: string, position: number) => {
    setCaret({ at: position, text });
    setPlaced({ start: position, end: position });
  };
  return {
    menu,
    skills,
    /** A row picked: its text in the draft in place of what was typed, a skill beside the message, the caret after it. */
    pick(row: Command | Mention) {
      if (!popup) return;
      if ('as' in row) {
        if (row.as === 'skill' && !skills.includes(row.name) && skills.length >= MAX_SKILLS) {
          setMenu({ kind: 'slash', rows: [], status: 'error', error: `A message carries up to ${MAX_SKILLS} skills.` });
          return;
        }
        const picked = pickCommand(draft, popup, at, row);
        setDraft(picked.text);
        const skill = picked.skill;
        if (skill) setSkills((old) => (old.includes(skill) ? old : [...old, skill]));
        place(picked.text, picked.caret);
      } else {
        const picked = pickMention(draft, popup, at, row);
        setDraft(picked.text);
        const file = picked.applied;
        if (file) setApplied((old) => [...old, file]);
        place(picked.text, picked.caret);
      }
      setMenu(null);
    },
    removeSkill: (name: string) => setSkills((old) => old.filter((n) => n !== name)),
    /** The message went: its skills went with it. */
    clearSkills: useCallback(() => setSkills(none), []),
    /** For the text field: the text typed, which moves the caret along with an edit made at it. */
    onChangeText(text: string) {
      const before = latest.current;
      latest.current = text;
      setCaret((old) => (old?.text === before ? { at: Math.max(0, old.at + text.length - before.length), text } : old));
      setDraft(text);
    },
    /** For the text field: the position a pick asked it to take. */
    selection: placed ?? undefined,
    /** For the text field: where the caret is, for the text typed so far. */
    onSelectionChange(event: { nativeEvent: { selection: { end: number } } }) {
      setCaret({ at: event.nativeEvent.selection.end, text: latest.current });
    },
  };
}
