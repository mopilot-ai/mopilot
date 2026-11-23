// The chat composer's props held still while the chat screen draws for something else (#4986): a streamed reply drew the screen on every event, and its handlers and elements are new each time, so the composer drew with it (22-27 times a send on the phone). The handlers here are stable forwarders that read what the screen holds when they are called, so nothing they do is out of date; the pill and the attachment strip are made again only when what they show changes.
import { type ComponentProps, useMemo, useRef } from 'react';
import type { Media } from '../platform/media';
import { feedbackPlaceholder, type useCards } from '../remote/useCards';
import type { useAttachments } from '../remote/useAttachments';
import type { useChatControls } from '../remote/useChatControls';
import { AttachmentStrip } from './AttachmentStrip';
import type { ChatComposer } from './ChatComposer';
import { ChatModelPill } from './ChatModelSheet';

type Inputs = {
  send: (skills: string[]) => boolean;
  cards: ReturnType<typeof useCards>;
  files: ReturnType<typeof useAttachments>;
  settings: ReturnType<typeof useChatControls>;
  media?: Media;
  running: boolean;
  busy: boolean;
  stopping: { stopping: boolean; stop: () => void };
  voiceBusy: boolean;
  setVoiceBusy: (busy: boolean) => void;
  /** The state setters of the sheets the pill and the + button open: React keeps these the same. */
  setModelSheet: (open: 'model') => void;
  setAdding: (open: boolean) => void;
};

/** What `ChatComposer` is given besides the chat, the draft, the request and the media, which the screen passes itself. */
export type ThreadComposer = Pick<
  ComponentProps<typeof ChatComposer>,
  | 'items'
  | 'guard'
  | 'send'
  | 'stop'
  | 'onVoiceBusy'
  | 'focusKey'
  | 'autoFocus'
  | 'placeholder'
  | 'running'
  | 'attached'
  | 'stopDisabled'
  | 'stopping'
  | 'menuOpen'
  | 'bar'
  | 'onAttach'
  | 'tray'
  | 'busy'
>;

export function useThreadComposer(now: Inputs): ThreadComposer {
  const latest = useRef(now);
  latest.current = now;
  const { media, files, settings, setModelSheet, setAdding } = now;
  const calls = useMemo(
    () => ({
      send: (skills: string[]) => latest.current.send(skills),
      // the refusal that comes first is read when the button is tapped: a plan that arrived since the composer last drew still holds the send
      guard: (send: () => void) => () => latest.current.cards.refusingFirst(send)(),
      stop: () => latest.current.stopping.stop(),
      retry: (key: number) => latest.current.files.retry(key),
      remove: (key: number) => latest.current.files.remove(key),
      openModel: () => setModelSheet('model'),
      openAdd: () => setAdding(true),
    }),
    [setModelSheet, setAdding],
  );
  const bar = useMemo(() => <ChatModelPill controls={settings.controls} open={calls.openModel} />, [settings.controls, calls]);
  const tray = useMemo(
    () => media && <AttachmentStrip items={files.items} retry={calls.retry} remove={calls.remove} />,
    [media, files.items, calls],
  );
  return {
    items: files.items,
    guard: calls.guard,
    send: calls.send,
    stop: calls.stop,
    onVoiceBusy: now.setVoiceBusy,
    // remounted when the plan is sent back, so the field takes focus
    focusKey: now.cards.feedback ?? 'message',
    autoFocus: !!now.cards.feedback,
    placeholder: feedbackPlaceholder(now.cards.feedback),
    running: now.running,
    attached: files.ids.length > 0,
    stopDisabled: now.busy,
    stopping: now.stopping.stopping,
    menuOpen: now.voiceBusy,
    bar,
    onAttach: media ? calls.openAdd : undefined,
    tray,
    busy: now.busy,
  };
}
