// The chat's composer with everything that reads what is typed: the field, the / and @ menus, the Send button's state and the voice note's text; it holds the draft, so a key typed re-renders this and not the screen around it.
import { type ComponentProps, memo, type ReactNode, useCallback, useRef, useSyncExternalStore } from 'react';
import type { Owned } from '../remote/client';
import { useComposerMenu } from '../remote/useComposerMenu';
import type { DraftHandle } from '../presentation/drafts';
import { messageReady } from '../presentation/messagePictures';
import { useDraft } from '../presentation/useDraft';
import { joinDraft, splitDraft, withoutQuote } from '../presentation/quoteChips';
import { QuoteChips } from './QuoteChips';
import type { Media } from '../platform/media';
import { Composer } from './Composer';
import { ComposerMenu } from './ComposerMenu';
import { VoiceNote } from './VoiceNote';

type Items = Parameters<typeof messageReady>[1];

/** Drawn again only when its own props or the draft change, not for each draw of the chat screen around it (see `useThreadComposer`). */
export const ChatComposer = memo(function ChatComposer({
  drafts,
  request,
  chatId,
  media,
  items,
  busy,
  send,
  guard,
  onVoiceBusy,
  ...props
}: {
  drafts: DraftHandle;
  request: Owned;
  chatId: string;
  media?: Media;
  /** The attached files: files alone are a message. */
  items: Items;
  /** An action holds the screen: nothing sends now. */
  busy: boolean;
  /** Sends the draft with these skills; false when nothing went (the skills stay). */
  send: (skills: string[]) => boolean;
  /** Wraps the send, for what has to be answered first (a plan card's refusal). */
  guard: (send: () => void) => () => void;
  onVoiceBusy: (busy: boolean) => void;
} & Omit<ComponentProps<typeof Composer>, 'draft' | 'setDraft' | 'disabled' | 'send' | 'above' | 'fieldProps' | 'menu' | 'menuOpen'> & {
    menuOpen: boolean;
  }) {
  const [full, setFull] = useDraft(drafts);
  // the quotes an Ask put at the head of the draft are chips; the field holds the words typed under them
  const { quotes, typed: draft } = splitDraft(full);
  const setDraft = useCallback(
    (value: string | ((old: string) => string)) =>
      setFull((old) => {
        const now = splitDraft(old);
        return joinDraft(now.quotes, typeof value === 'function' ? value(now.typed) : value);
      }),
    [setFull],
  );
  const removeQuote = useCallback((index: number) => setFull((old) => withoutQuote(old, index)), [setFull]);
  // an Ask takes the keyboard: the field is drawn again, which focuses it
  const asked = useSyncExternalStore(drafts.subscribe, drafts.focusTick ?? (() => 0));
  // asks from before this screen opened are not this screen's: only a later one takes the keyboard
  const askedAtOpen = useRef(asked).current;
  const menu = useComposerMenu(request, chatId, draft, setDraft);
  let voice: ReactNode;
  if (media)
    voice = (
      <VoiceNote
        {...{ media, request }}
        caps={null}
        onBusy={onVoiceBusy}
        use={(t) => setDraft((old) => (old.trim() ? `${old.trim()} ${t}` : t))}
      />
    );
  return (
    <Composer
      {...props}
      draft={draft}
      setDraft={setDraft}
      focusKey={`${props.focusKey}:${asked}`}
      autoFocus={props.autoFocus || asked !== askedAtOpen}
      tray={
        <>
          <QuoteChips quotes={quotes} remove={removeQuote} />
          {props.tray}
        </>
      }
      disabled={busy || !messageReady(full, items)}
      send={guard(() => {
        if (send(menu.skills)) menu.clearSkills();
      })}
      above={<ComposerMenu menu={menu.menu} skills={menu.skills} pick={menu.pick} removeSkill={menu.removeSkill} />}
      fieldProps={{ onChangeText: menu.onChangeText, selection: menu.selection, onSelectionChange: menu.onSelectionChange }}
      menu={voice}
    />
  );
});
