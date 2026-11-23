// MoMo's one continuous chat in Claude's Dispatch layout: dotted day lines, your messages as grey bubbles, MoMo's words in serif, reminders as cards with Snooze, Dismiss and Done, MoMo's requests in order, and the one-line pill composer with its orange send.
import type { ComponentProps } from 'react';
import type { DraftHandle } from '../presentation/drafts';
import { useDraft } from '../presentation/useDraft';
import { type ComponentRef, Fragment, type ReactNode, useRef } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { authoredCardOf } from '../components/AuthoredCard';
import { Icon } from '../components/Icon';
import { MessageBubble } from '../components/MessageBubble';
import { RequestCard, type CardData } from '../components/RequestCard';
import { Spark } from '../components/Spark';
import { serifFamily } from '../fonts';
import { cardKey } from '../momo/needs';
import type { AnsweredHere } from '../momo/useNeeds';
import { receiptLine } from '../presentation/receipts';
import { draftOfRow, sendOfRow } from '../momo/stateContract';
import { DraftCard } from './MomoDraft';
import type { MomoRow } from '../momo/chatRows';
import type { Nudge } from '../momo/stateContract';
import { armRise, measureTop } from '../sendOrigin';
import { RiseIn } from '../components/RiseIn';
import { MicButton, type MomoVoiceControl, VoiceNotices, VoicePill } from './MomoVoice';
import { useMessageMenu } from '../components/SelectText';
import { useTheme } from '../theme';
import { typo } from '../typography';
import { NewDivider } from './MomoShell';
import { Pill } from './MomoPill';
import { BriefCard, type BriefAction } from './MomoBriefCard';
import type { BriefState } from '../momo/useBriefStates';
import { briefCardOfRow } from '../momo/stateContract';

export type NudgeAction = 'done' | 'snooze' | 'dismiss';
/** What a reminder reads once it was answered here. */
export const NUDGE_DONE: Record<NudgeAction, string> = { done: 'Done', snooze: 'Snoozed', dismiss: 'Dismissed' };

/** A card's key among the things waiting (a reminder's is its row key). */
export const waitingKey = (card: CardData) => `card:${cardKey(card)}`;

function DayLine({ label }: { label: string }) {
  const theme = useTheme();
  const dots = <View style={{ flex: 1, borderTopWidth: 2, borderStyle: 'dotted', borderColor: theme.ink3, opacity: 0.6 }} />;
  return (
    <View accessibilityRole="header" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6, marginBottom: 16 }}>
      {dots}
      <Text style={{ ...typo.subhead, color: theme.ink2 }}>{label}</Text>
      {dots}
    </View>
  );
}

/** A reminder MoMo raised: what to remember, why now, and the three answers; it never starts a turn. */
export function NudgeCard({
  nudge,
  disabled,
  act,
  state,
}: {
  nudge: Nudge;
  disabled: boolean;
  act: (action: NudgeAction) => void;
  /** What it was answered with, once it was: the buttons give way to it. */
  state?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.surface,
        borderWidth: 1,
        borderColor: theme.line,
        borderRadius: 20,
        padding: 14,
        marginBottom: 14,
        gap: 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Spark size={14} />
        <Text style={{ ...typo.calloutSemibold, color: theme.ink }}>{nudge.title}</Text>
      </View>
      {!!nudge.quote && <Text style={{ fontFamily: serifFamily(), ...typo.body, color: theme.ink }}>“{nudge.quote}”</Text>}
      {!!nudge.why && <Text style={{ ...typo.subhead, color: theme.ink2 }}>{nudge.why}</Text>}
      {state ? (
        <View accessibilityRole="text" style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 4 }}>
          <Icon name="checkmark" glyph="✓" size={14} color={theme.ink2} />
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>{state}</Text>
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
          <Pill title="Snooze" disabled={disabled} onPress={() => act('snooze')} />
          <Pill title="Dismiss" disabled={disabled} onPress={() => act('dismiss')} />
          <Pill title="Done" strong disabled={disabled} onPress={() => act('done')} />
        </View>
      )}
    </View>
  );
}

function Message({ role, text, id }: { role: string; text: string; id: string }) {
  const theme = useTheme();
  // a long press offers Copy and Select Text, as in the chats
  const menu = useMessageMenu(text, () => text);
  const mine = role === 'user' || role === 'liveUser';
  // a user-role row MoPilot wrote (a routine's report, the setup greeting) is its one-line card, never a bubble of the model's instruction
  if (mine && authoredCardOf(text)) return <MessageBubble id={id} role={role} text={text} />;
  if (mine)
    return (
      <RiseIn>
        <View
          style={{
            alignSelf: 'flex-end',
            maxWidth: '82%',
            backgroundColor: theme.sunken,
            borderRadius: 22,
            paddingVertical: 10,
            paddingHorizontal: 16,
            marginTop: 6,
            marginBottom: 14,
          }}
        >
          <Tap feel="none" accessible={false} onLongPress={menu.open} delayLongPress={350}>
            <Text {...menu.a11y} style={{ ...typo.body, color: theme.ink }}>
              {text}
            </Text>
          </Tap>
          {menu.sheet}
        </View>
      </RiseIn>
    );
  // MoMo's words go through the one Markdown renderer every transcript uses (bold next to CJK text included), in the same serif
  if (role === 'assistant' || role === 'preview') return <MessageBubble id={id} role={role} text={text} streaming={role === 'preview'} />;
  // a step or a note: a quiet one-liner
  return (
    <Text numberOfLines={2} style={{ ...typo.subhead, color: theme.ink2, paddingVertical: 5 }}>
      {text}
    </Text>
  );
}

/** A message row: a draft MoMo wrote is its card with Edit, Copy and the open button (the phone sends nothing; a send made on the Mac shows read only); anything else is the line it is. */
function RowBody({ row, brief }: { row: { role: string; text: string; key: string }; brief: BriefHandlers }) {
  const draft = draftOfRow(row);
  const card = briefCardOfRow(row);
  if (card && brief.on)
    return <BriefCard card={card} disabled={!brief.canAct} state={brief.stateOf(card.id)} act={(a) => brief.act(card.id, a)} />;
  return draft ? <DraftCard draft={draft} send={sendOfRow(row)} /> : <Message role={row.role} text={row.text} id={row.key} />;
}

/** What a suggestion card of the morning brief needs: whether the phone may act, what was answered, and the act. */
export type BriefHandlers = {
  on: boolean;
  canAct: boolean;
  stateOf: (id: string) => BriefState | undefined;
  act: (id: string, action: BriefAction) => void;
};
/** One list for every transcript that leaves `answeredHere` out, so such a render does not see a new list each time. */
const NONE_ANSWERED_HERE: AnsweredHere[] = [];

/** The transcript; the screen around it scrolls. `cardRef` reports where each waiting reminder or card sits (by its key), so the needs-you pill can find the first. */
export function MomoTranscript({
  rows,
  queued,
  cards,
  answeredOnMac,
  answeredHere = NONE_ANSWERED_HERE,
  answer,
  act,
  briefAct,
  briefState,
  briefOn,
  canAct,
  closed,
  working,
  progress,
  empty,
  cardRef,
  newKey = null,
}: {
  rows: MomoRow[];
  /** your messages the Mac has not taken yet */
  queued: ReactNode;
  cards: CardData[];
  answeredOnMac: CardData[];
  /** the cards this phone answered, each with the choice's label; none when a caller leaves it out */
  answeredHere?: AnsweredHere[];
  answer: (card: CardData, key: string) => Promise<boolean>;
  act: (nudge: Nudge, action: NudgeAction) => void;
  /** Hide or Start on a suggestion card of the morning brief */
  briefAct: (id: string, action: BriefAction) => void;
  /** what became of a brief card's suggestion (the Mac's store) */
  briefState: (id: string) => BriefState | undefined;
  /** whether suggestions are on: with them off a brief's card is only its line */
  briefOn: boolean;
  canAct: boolean;
  closed: Record<string, string>;
  working: boolean;
  progress: string;
  empty: ReactNode;
  cardRef: (key: string, y: number) => void;
  /** the row the "New" divider goes before (the shell's: the first reply the reader has not seen) */
  newKey?: string | null;
}) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 18 }}>
      {rows.length === 0 && empty}
      {rows.map((r) => (
        <Fragment key={r.key}>
          {r.key === newKey && <NewDivider />}
          {r.kind === 'day' ? (
            <DayLine label={r.label} />
          ) : r.kind === 'nudge' ? (
            <View onLayout={(e) => cardRef(r.key, e.nativeEvent.layout.y)}>
              <NudgeCard nudge={r.nudge} disabled={!canAct} act={(action) => act(r.nudge, action)} state={closed[r.nudge.loopId]} />
            </View>
          ) : (
            <RowBody row={r.row} brief={{ on: briefOn, canAct, stateOf: briefState, act: briefAct }} />
          )}
        </Fragment>
      ))}
      {queued}
      {cards.map((card) => (
        <View
          key={JSON.stringify([card.id, card.rev])}
          onLayout={(e) => cardRef(waitingKey(card), e.nativeEvent.layout.y)}
          style={{ marginBottom: 14 }}
        >
          {card.inApp ? (
            <Text style={{ ...typo.subhead, color: theme.ink2 }}>{card.title} · Finish on your Mac.</Text>
          ) : (
            <RequestCard card={card} answer={(key) => answer(card, key)} />
          )}
        </View>
      ))}
      {answeredOnMac.map((card) => (
        <View key={`done-${cardKey(card)}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 5 }}>
          <Icon name="checkmark" glyph="✓" size={14} color={theme.ink2} />
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>{card.title} · Answered on your Mac</Text>
        </View>
      ))}
      {answeredHere.map(({ card, choice }) => (
        <View key={`here-${cardKey(card)}`} style={{ flexDirection: 'row', gap: 8, alignItems: 'center', paddingVertical: 5 }}>
          <Icon name="checkmark" glyph="✓" size={14} color={theme.ink2} />
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>
            {card.title} · {receiptLine({ by: 'phone', choice })}
          </Text>
        </View>
      ))}
      {working && (
        <View
          accessibilityLiveRegion="polite"
          style={{ flexDirection: 'row', gap: 9, alignItems: 'center', paddingTop: 6, paddingBottom: 12 }}
        >
          <Spark size={18} spin />
          <Text style={{ ...typo.subhead, color: theme.ink2 }}>{progress || 'Working…'}</Text>
        </View>
      )}
    </View>
  );
}

/** Dispatch's single-line pill: the field, then the orange send (or Stop while MoMo works). MoMo takes no attachments, so there is no +. */
export function MomoComposer({
  draft,
  setDraft,
  send,
  stop,
  working,
  disabled,
  voice = null,
  micOff = false,
  placeholder = 'Ask MoMo anything',
}: {
  draft: string;
  setDraft: (text: string) => void;
  send: () => void;
  stop: () => void;
  working: boolean;
  disabled: boolean;
  /** The voice note on offer (A5): null where the phone cannot record or the Mac does not list MoMo's voice method, so no microphone shows. */
  voice?: MomoVoiceControl | null;
  /** The microphone is held: the Mac is away, so nothing could be transcribed. */
  micOff?: boolean;
  /** The empty field's line: "Message #name" in a channel (A2). */
  placeholder?: string;
}) {
  const theme = useTheme();
  const typed = !!draft.trim();
  const canSend = !disabled && typed;
  const box = useRef<ComponentRef<typeof View>>(null);
  return (
    <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 }}>
      {voice && <VoiceNotices voice={voice} />}
      <View
        ref={box}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.line,
          borderRadius: 30,
          paddingVertical: 8,
          paddingRight: 8,
          paddingLeft: 18,
        }}
      >
        {voice && voice.phase !== 'idle' ? (
          <VoicePill voice={voice} />
        ) : (
          <>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={placeholder}
              placeholderTextColor={theme.ink3}
              accessibilityLabel={placeholder}
              multiline
              style={{ flex: 1, ...typo.body, color: theme.ink, maxHeight: 120, paddingVertical: 8 }}
            />
            {voice && <MicButton voice={voice} disabled={disabled || micOff} />}
            {/* as the main chat's: while a turn runs or waits for you, nothing typed shows Stop; with a message typed, Send queues it behind the turn and a smaller Stop stays beside it */}
            {working && typed && (
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Stop"
                disabled={disabled}
                onPress={stop}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.sunken,
                }}
              >
                <Icon name="stop.fill" glyph="■" size={14} color={theme.ink} />
              </Tap>
            )}
            {working && !typed ? (
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Stop"
                disabled={disabled}
                onPress={stop}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.btn,
                }}
              >
                <Icon name="stop.fill" glyph="■" size={14} color={theme.btnInk} />
              </Tap>
            ) : (
              <Tap
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: !canSend }}
                disabled={!canSend}
                onPress={() => {
                  armRise(measureTop(box.current));
                  send();
                }}
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: theme.orange,
                  opacity: canSend ? 1 : 0.45,
                }}
              >
                <Icon name="arrow.up" glyph="↑" size={16} color={theme.accentInk} />
              </Tap>
            )}
          </>
        )}
      </View>
    </View>
  );
}

/** MoMo's composer holding its draft itself: a key typed re-renders this, not the chat around it. */
export function MomoDraftComposer({
  drafts,
  ...props
}: { drafts: DraftHandle } & Omit<ComponentProps<typeof MomoComposer>, 'draft' | 'setDraft'>) {
  const [draft, setDraft] = useDraft(drafts);
  return <MomoComposer {...props} draft={draft} setDraft={setDraft} />;
}
