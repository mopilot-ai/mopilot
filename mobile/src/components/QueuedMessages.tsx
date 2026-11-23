// A chat's messages the computer has not accepted yet, as your own grey bubbles with a quiet line under each: waiting for the computer (editable in place until it goes), going out now, not confirmed, or refused, with Retry, Edit and Cancel as small text actions.
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { MobileRuntime } from '../contracts';
import { QUEUED_LINE } from '../macLink';
import { isUnconfirmed, type QueuedSend } from '../outbox';
import { useTheme } from '../theme';
import { useTranslation } from '../ui/i18n';
import { authoredCardOf, authoredTitle } from './AuthoredCard';
import { MessageImages } from './MessageImages';
import { Icon } from './Icon';
import { RiseIn } from './RiseIn';
import { reportSentTop } from '../sendOrigin';
import { Field } from './ui';
import { typo } from '../typography';

/** The three calls the list makes, from the runtime. */
export const queueCalls = (runtime: MobileRuntime) => ({
  cancel: (id: string) => runtime.cancelSend(id),
  retry: (id: string) => runtime.retrySend(id),
  edit: (id: string, text: string) => runtime.editSend(id, text),
});

/** The quiet line under a message that has not gone out: waiting for the Mac, going now, or why it did not. */
export const statusLine = (item: QueuedSend, queuedLine = QUEUED_LINE) =>
  item.status === 'queued'
    ? queuedLine
    : item.status === 'sending'
      ? 'Sending…'
      : `${isUnconfirmed(item) ? 'Not confirmed' : 'Not sent'}: ${item.error}`;

/** What a message of files without words shows in place of its text. */
const filesLabel = (count: number) => (count === 1 ? '1 attachment' : `${count} attachments`);

/** A small text action under a bubble ("Retry", "Edit", "Cancel"), with a full-size target. */
function Action({ title, label, onPress, disabled = false }: { title: string; label: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={{ minHeight: 32, justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}
    >
      <Text style={{ ...typo.footnoteSemibold, color: theme.ink2 }}>{title}</Text>
    </Tap>
  );
}

export function QueuedMessages({
  items,
  cancel,
  retry,
  edit,
  queuedLine,
  takeBack,
  canTakeBack,
  lineOf,
  picturesFor,
  readOnly = false,
  rises = true,
  pins = true,
}: {
  items: QueuedSend[];
  picturesFor?: (id: string) => string[] | undefined;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  /** Rewrites a waiting message; absent where editing is not offered. */
  edit?: (id: string, text: string) => boolean;
  /** What a waiting message says it waits for (the Mac's queue says "next", not "reconnects"). */
  queuedLine?: string;
  /** Edit as the Mac's queue has it: the message leaves the queue and its words go back to the composer. */
  takeBack?: (id: string) => void;
  /** Whether that one message can come back (not one with files, which the composer cannot take back). */
  canTakeBack?: (id: string) => boolean;
  /** What one waiting message says it waits for, where it differs from the rest (the machine is away, a sign-in). */
  lineOf?: (id: string) => string | undefined;
  /** Shown only: the messages cannot be changed from here (MoMo's queue has no phone call to take one back). */
  readOnly?: boolean;
  /** False for a copy of the outbox drawn on another page, which has no ghost over it. */
  rises?: boolean;
  /** The newest message tells the chat's pin where it sits (not where the chat knows its own baseline, as MoMo's). */
  pins?: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  // a held message MoPilot wrote (a routine's report) reads as its one-line title, never the model's instruction
  const shown = (text: string) => {
    const card = authoredCardOf(text);
    return card ? authoredTitle(card, t) : text;
  };
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // where the newest message sits in the list's content (this list's own place plus its place in the list), for the pin
  const place = useRef<{ root: number | null; item: number | null }>({ root: null, item: null });
  const report = () => {
    const { root, item } = place.current;
    if (pins && root !== null && item !== null) reportSentTop(root + item);
  };
  if (!items.length) {
    // not drawn: where it was is no longer where the next message will be
    place.current = { root: null, item: null };
    return null;
  }
  return (
    <View
      onLayout={(event) => {
        place.current.root = event.nativeEvent.layout.y;
        report();
      }}
    >
      {items.map((item, index) => {
        // the message went out (or was refused) while it was being edited: the edit has nowhere to land
        const editable = item.status === 'queued' && !item.attempted && !!edit;
        const pictures = picturesFor?.(item.id) ?? item.pictures;
        const mine = editable && editing?.id === item.id ? editing : null;
        return (
          <RiseIn
            rises={rises}
            key={item.id}
            onLayout={
              index === items.length - 1
                ? (event) => {
                    place.current.item = event.nativeEvent.layout.y;
                    report();
                  }
                : undefined
            }
            style={{ alignItems: 'flex-end', marginTop: 6, marginBottom: 14, gap: 4 }}
          >
            <View
              style={{
                maxWidth: '82%',
                alignSelf: mine ? 'stretch' : 'flex-end',
                backgroundColor: theme.sunken,
                borderRadius: 22,
                paddingHorizontal: 16,
                paddingVertical: 10,
              }}
            >
              {!!pictures?.length && <MessageImages local={pictures} count={pictures.length} />}
              {mine ? (
                <Field
                  multiline
                  autoFocus
                  accessibilityLabel="Edit this message"
                  value={mine.text}
                  onChangeText={(text) => setEditing({ id: item.id, text })}
                  style={{ borderWidth: 0, backgroundColor: 'transparent', paddingHorizontal: 0, paddingVertical: 0, ...typo.body }}
                />
              ) : (
                <Text selectable style={{ ...typo.body, color: theme.ink }}>
                  {item.text.trim()
                    ? shown(item.text)
                    : !pictures?.length && item.images
                      ? `${item.images} ${item.images === 1 ? 'picture' : 'pictures'}`
                      : filesLabel(item.attachments.length)}
                </Text>
              )}
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 4 }}>
              {item.status === 'queued' && <Icon name="clock" glyph="◷" size={12} color={theme.ink2} />}
              <Text style={{ ...typo.footnote, color: item.status === 'failed' ? theme.bad : theme.ink2 }}>
                {statusLine(item, lineOf?.(item.id) ?? queuedLine)}
              </Text>
            </View>
            {item.status !== 'sending' && !readOnly && (
              <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 4 }}>
                {mine ? (
                  <>
                    <Action title="Discard" label="Discard changes" onPress={() => setEditing(null)} />
                    <Action
                      title="Save"
                      label="Save this message"
                      disabled={!mine.text.trim() && !item.attachments.length}
                      onPress={() => {
                        if (edit?.(item.id, mine.text)) setEditing(null);
                      }}
                    />
                  </>
                ) : (
                  <>
                    {item.status === 'failed' && !item.final && (
                      <Action title="Retry" label="Retry sending" onPress={() => retry(item.id)} />
                    )}
                    {editable && (
                      <Action title="Edit" label="Edit this message" onPress={() => setEditing({ id: item.id, text: item.text })} />
                    )}
                    {takeBack && item.status === 'queued' && (canTakeBack?.(item.id) ?? true) && (
                      <Action title="Edit" label="Edit this message" onPress={() => takeBack(item.id)} />
                    )}
                    <Action title="Cancel" label="Cancel this message" onPress={() => cancel(item.id)} />
                  </>
                )}
              </View>
            )}
          </RiseIn>
        );
      })}
    </View>
  );
}
