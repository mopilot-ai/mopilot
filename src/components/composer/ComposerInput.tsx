// The composer's contenteditable input: atomic skill, chat, tab and file reference chips, and serializing the draft to prompt text.

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ClipboardEvent, type Ref } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment } from '../../store/types';
import { openSkill } from '../markdown/SkillLink';
import { SkillGlyph } from '../markdown/SkillGlyph';
import { openPath } from '../../session/open';
import { modKey } from '../../lib/platform';
import { sessionMentions } from '../../lib/sessionMentions';
import { tabMentions } from '../../../shared/tabMentions.mjs';
import { fileMentions } from '../../lib/fileMentions';
import { deleteAdjacentSkill } from '../../lib/skillDeletion';
import { useComposerComposition } from '../../lib/composerComposition';
import { imeComposing } from '../../lib/focus';
import { readEditor, caretOffset, placeCaret, selectedText } from '../../lib/composerEditorDocument';
import { editComposerList, restoreComposerLists, startComposerList } from '../../lib/composerLists';
import { clearComposerBoundaries, pasteComposerBlocks } from '../../lib/composerBlockEdit';

export type ComposerInputElement = HTMLDivElement & {
  value: string;
  selectionStart: number;
  setSelectionRange: (start: number, end: number) => void;
  replaceRange: (start: number, end: number, text: string) => void;
  /**
   * Puts the caret at `position` once the editor shows `text`: now if it already does, else in the render that draws it,
   * in the same step as the pick, so a key typed right after lands there (#1719). A frame later is too late, and a
   * focused editor redrawn with new text otherwise keeps its old caret offset.
   */
  setCaretAfter: (text: string, position: number) => void;
};

type Reference =
  | (ReturnType<typeof sessionMentions>[number] & { kind: 'chat' })
  | (ReturnType<typeof tabMentions>[number] & { kind: 'tab' })
  | { kind: 'file'; start: number; end: number; token: string; title: string; path: string };

/**
 * Chat, browser tab and `@path` file references in a draft, in order; each stays an atomic chip holding its serialized
 * token. A file mention is one only outside a chat or tab token (fileMentions already skips markdown links).
 */
export function references(text: string): Reference[] {
  const tokens: Reference[] = [
    ...sessionMentions(text).map((m) => ({ ...m, kind: 'chat' as const })),
    ...tabMentions(text).map((m) => ({ ...m, kind: 'tab' as const })),
  ];
  const files = fileMentions(text).map((m) => ({ ...m, kind: 'file' as const, title: m.token }));
  return [...tokens, ...files].sort((a, b) => a.start - b.start);
}

/** Render serialized references with DOM text APIs, so titles cannot inject markup. */
function referenceFragment(text: string) {
  const out = document.createDocumentFragment();
  let at = 0;
  for (const m of references(text)) {
    out.append(document.createTextNode(text.slice(at, m.start)));
    const token = document.createElement('span');
    token.className =
      m.kind === 'tab' ? 'composer-session-token composer-tab-token' : m.kind === 'file' ? 'composer-file-token' : 'composer-session-token';
    token.dataset.sessionToken = m.token;
    if (m.kind === 'file') token.dataset.filePath = m.path;
    token.contentEditable = 'false';
    token.textContent = m.title;
    token.title = m.kind === 'tab' ? `${m.title}\n${m.url}` : m.kind === 'file' ? m.path : m.title;
    out.append(token);
    at = m.end;
  }
  out.append(document.createTextNode(text.slice(at)));
  return out;
}

export function ComposerInput({
  ref,
  value,
  attachments,
  disabled,
  hidden,
  placeholder,
  onChange,
  onKeyDown,
  onPaste,
  onSelect,
  onSessionOpen,
  onSessionSend,
}: {
  ref: Ref<ComposerInputElement>;
  value: string;
  attachments: Attachment[];
  disabled: boolean;
  hidden: boolean;
  placeholder: string;
  onChange: (text: string, attachments: Attachment[], caret: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  onSelect: (text: string, caret: number) => void;
  onSessionOpen?: (id: string) => void;
  onSessionSend?: (id: string) => void;
}) {
  const elRef = useRef<ComposerInputElement | null>(null);
  const rendered = useRef('');
  // a caret position setCaretAfter asked for, placed by the render that draws its text
  const pendingCaret = useRef<{ text: string; position: number } | null>(null);
  const [iconHosts, setIconHosts] = useState<HTMLElement[]>([]);
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const archive = useRef(new Map<string, Attachment>());
  const sequence = useRef(0);
  const composition = useComposerComposition(() => sync());
  const editingList = useRef(false);
  const { composing } = composition;
  const skills = attachments.flatMap((a) =>
    a.kind === 'skill' ? [{ a, offset: Math.max(0, Math.min(value.length, a.textOffset ?? 0)) }] : [],
  );
  const signature = JSON.stringify([value, skills.map(({ a, offset }) => [a.path, a.displayName ?? a.name, offset])]);
  useEffect(() => {
    if (!sessionMenu) return;
    const dismiss = (event: globalThis.KeyboardEvent | MouseEvent) => {
      if (event.type === 'keydown') {
        const key = event as globalThis.KeyboardEvent;
        if (key.key === 'Escape' && !imeComposing(key)) setSessionMenu(null);
      } else if (!(event.target as HTMLElement)?.closest('[role="menu"]')) setSessionMenu(null);
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('mousedown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('mousedown', dismiss);
    };
  }, [sessionMenu]);

  // Busy (a send preparing its references, a chat starting) blocks edits but keeps the editor focusable: Chromium moves
  // the focus of an editor that turns contentEditable=false to <body>, so Esc and the next message went nowhere (#1658).
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || !disabled) return;
    const block = (event: Event) => event.preventDefault();
    el.addEventListener('beforeinput', block);
    return () => el.removeEventListener('beforeinput', block);
  }, [disabled]);

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el || composing.current || rendered.current === signature) return;
    const focused = document.activeElement === el;
    const caret = focused ? caretOffset(el) : value.length;
    const hosts: HTMLElement[] = [];
    el.replaceChildren();
    let at = 0;
    for (const { a, offset } of [...skills].sort((a, b) => a.offset - b.offset)) {
      el.append(referenceFragment(value.slice(at, offset)));
      const mention = document.createElement('span');
      mention.className = 'composer-skill';
      mention.dataset.skillId = String(++sequence.current);
      archive.current.set(mention.dataset.skillId, a);
      mention.contentEditable = 'false';
      mention.title = a.path;
      const icon = document.createElement('span');
      hosts.push(icon);
      const label = document.createElement('span');
      label.textContent = a.displayName ?? a.name;
      mention.append(icon, label);
      el.append(mention);
      at = offset;
    }
    el.append(referenceFragment(value.slice(at)));
    restoreComposerLists(el);
    rendered.current = signature;
    setIconHosts(hosts);
    const asked = pendingCaret.current?.text === value ? pendingCaret.current.position : null;
    pendingCaret.current = null;
    if (asked !== null) placeCaret(el, Math.min(asked, value.length));
    else if (focused) placeCaret(el, Math.min(caret, value.length));
  });

  const sync = () => {
    const el = elRef.current!;
    clearComposerBoundaries(el);
    const next = readEditor(el);
    const nextSkills = next.mentions.flatMap(({ id, offset }) => {
      const a = archive.current.get(id);
      return a ? [{ ...a, textOffset: offset }] : [];
    });
    const nextAttachments = [...attachments.filter((a) => a.kind !== 'skill'), ...nextSkills];
    rendered.current = JSON.stringify([next.text, nextSkills.map((a) => [a.path, a.displayName ?? a.name, a.textOffset])]);
    onChange(next.text, nextAttachments, caretOffset(el));
  };

  return (
    <>
      <div
        ref={(el) => {
          elRef.current = el as ComposerInputElement | null;
          if (el)
            Object.defineProperties(el, {
              value: { configurable: true, get: () => readEditor(el).text },
              selectionStart: { configurable: true, get: () => caretOffset(el) },
              setSelectionRange: { configurable: true, value: (start: number, end: number) => placeCaret(el, start, end) },
              setCaretAfter: {
                configurable: true,
                value: (text: string, position: number) => {
                  if (readEditor(el).text === text) {
                    pendingCaret.current = null;
                    placeCaret(el, Math.min(position, text.length));
                  } else pendingCaret.current = { text, position };
                },
              },
              replaceRange: {
                configurable: true,
                value: (start: number, end: number, text: string) => {
                  el.focus();
                  placeCaret(el, start, end);
                  const container = document.createElement('div');
                  container.append(referenceFragment(text));
                  document.execCommand('insertHTML', false, container.innerHTML);
                  sync();
                },
              },
            });
          if (typeof ref === 'function') return ref(elRef.current);
          if (ref) ref.current = elRef.current;
        }}
        className={`composer-input composer-editor ${hidden ? 'voice-hidden' : ''}`}
        role="textbox"
        aria-label="Message"
        aria-multiline="true"
        aria-disabled={disabled}
        data-placeholder={!composition.active && !value && !skills.length ? placeholder : ''}
        contentEditable
        spellCheck={false}
        suppressContentEditableWarning
        // An IME can draw marked text before it updates the serialized draft.
        onCompositionStart={composition.start}
        onCompositionEnd={composition.end}
        onBlur={composition.blur}
        onInput={(e) => {
          if (composing.current || editingList.current) return;
          if (!disabled && (e.nativeEvent as InputEvent).inputType === 'insertText') {
            editingList.current = true;
            try {
              startComposerList(e.currentTarget as ComposerInputElement);
            } finally {
              editingList.current = false;
            }
          }
          sync();
        }}
        onKeyDown={(e) => {
          onKeyDown(e);
          let listEdited = false;
          editingList.current = true;
          try {
            listEdited = editComposerList(
              e.currentTarget as ComposerInputElement,
              e.nativeEvent,
              e.defaultPrevented || disabled || composing.current,
            );
          } finally {
            editingList.current = false;
          }
          if (listEdited) {
            e.preventDefault();
            sync();
          }
          if (deleteAdjacentSkill(e.currentTarget, e.nativeEvent, e.defaultPrevented || disabled || composing.current)) {
            e.preventDefault();
            sync();
          }
          if (!e.defaultPrevented && e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        onSelect={() => onSelect(elRef.current!.value, elRef.current!.selectionStart)}
        onClick={(e) => {
          const session = (e.target as HTMLElement).closest<HTMLElement>('[data-session-token]');
          if (session) {
            // the selector above guarantees the attribute
            const mention = sessionMentions(session.dataset.sessionToken!)[0];
            if (mention) onSessionOpen?.(mention.id);
            return;
          }
          const mention = (e.target as HTMLElement).closest<HTMLElement>('[data-skill-id]');
          const a = mention && archive.current.get(mention.dataset.skillId!);
          if (a) {
            if (modKey(e)) openPath(a.path);
            else openSkill(a.path);
          }
        }}
        onContextMenu={(e) => {
          const token = (e.target as HTMLElement).closest<HTMLElement>('[data-session-token]');
          const mention = token && sessionMentions(token.dataset.sessionToken!)[0];
          if (mention && onSessionSend && !disabled) {
            e.preventDefault();
            setSessionMenu({ id: mention.id, x: e.clientX, y: e.clientY });
          }
        }}
        onCopy={(e) => {
          const text = selectedText(e.currentTarget);
          if (text === null) return;
          e.preventDefault();
          e.clipboardData.setData('text/plain', text);
        }}
        onCut={(e) => {
          const text = selectedText(e.currentTarget);
          if (text === null) return;
          e.preventDefault();
          e.clipboardData.setData('text/plain', text);
          // busy: the selection is copied, not removed
          if (disabled) return;
          document.execCommand('delete');
          sync();
        }}
        onPaste={(e) => {
          if (disabled) return e.preventDefault();
          onPaste(e);
          if (e.defaultPrevented) return;
          e.preventDefault();
          // Plain text only: pasting another page must not introduce editable skill markup.
          const text = e.clipboardData.getData('text/plain');
          const container = document.createElement('div');
          container.append(referenceFragment(text));
          if (restoreComposerLists(container) || references(text).length) {
            pasteComposerBlocks(e.currentTarget, container.innerHTML);
          } else document.execCommand('insertText', false, text);
        }}
      />
      {sessionMenu && (
        <div role="menu" className="menu" style={{ position: 'fixed', left: sessionMenu.x, top: sessionMenu.y, zIndex: 1000 }}>
          <button
            role="menuitem"
            onClick={() => {
              onSessionOpen?.(sessionMenu.id);
              setSessionMenu(null);
            }}
          >
            Open chat
          </button>
          <button
            role="menuitem"
            onClick={() => {
              onSessionSend?.(sessionMenu.id);
              setSessionMenu(null);
            }}
          >
            Send message
          </button>
          <button role="menuitem" onClick={() => setSessionMenu(null)}>
            Close
          </button>
        </div>
      )}
      {iconHosts.map((host, index) => createPortal(<SkillGlyph size={14} />, host, String(index)))}
    </>
  );
}
