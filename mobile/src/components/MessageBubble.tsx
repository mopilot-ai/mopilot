// One row of a chat as Claude's transcript draws it: the reply in serif, full width, revealed word by word; your messages in a grey bubble; steps as quiet one-line rows that open on a tap.
import { memo, useMemo, useState } from 'react';
import { heartbeatMessage } from '../../../shared/heartbeatMessage.mjs';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { kindOfText, type Kind, type KeyedRow } from '../presentation/toolRuns';
import { useTheme } from '../theme';
import { Markdown, type BlockOptions } from './Markdown';
import { selectableText } from '../presentation/replyText';
import { useMessageMenu } from './SelectText';
import { inPlaceSelection } from '../platform/inPlaceSelection';
import { nativeGate } from '../presentation/nativeGate';
import { UserText } from './UserText';
import { Chevron, Enter } from './Motion';
import { StepGlyph } from './StepGlyph';
import { useStreamRevealSteps } from '../useStreamReveal';
import { monoFamily } from '../fonts';
import type { StepExtras } from '../presentation/stepRows';
import { StepPicture } from './StepPicture';
import { typo } from '../typography';
import { authoredCardOf, authoredTitle } from './AuthoredCard';
import { useTranslation } from '../ui/i18n';
import { MessageImages } from './MessageImages';

type Role = 'user' | 'assistant' | 'preview' | 'liveUser' | 'live' | 'activity' | string;
const WHO: Record<string, string> = {
  user: 'You',
  assistant: 'MoPilot',
  preview: 'Live reply',
  liveUser: 'You, live',
  live: 'Live activity',
  activity: 'Activity',
};

/** A reply: serif Markdown. Text that arrives while it streams is paced and each new word fades in; shown text never fades again. */
function Reply({
  id,
  text,
  streaming,
  a11y,
  onBlock,
  inPlace,
}: {
  id: string;
  text: string;
  streaming: boolean;
  a11y: BlockOptions['a11y'];
  onBlock: BlockOptions['onBlock'];
  inPlace?: { copyMessage: () => void; selectText: () => void };
}) {
  const { shown, steps } = useStreamRevealSteps(id, text, streaming);
  // the reply's own long-press menu selects any range of it, so its prose is not selectable whole by the system
  return <Markdown text={shown} serif fade steps={steps} selectable={false} a11y={a11y} onBlock={onBlock} inPlace={inPlace} />;
}

/** "Edited auth/callback.ts" as the verb and its subject, the subject set in mono as Claude's step rows do. */
export function stepParts(text: string): { verb: string; subject: string } {
  const m = /^((?:Ran |Searched for |Read |Edited |Created |Grep |Glob |LS ))(.+)$/s.exec(text);
  return m ? { verb: m[1].trimEnd(), subject: m[2] } : { verb: text, subject: '' };
}

/** Where a step worked, after its line ("Clicked · Chrome"), for a step in your own browser rather than the computer's. */
const PLACE: Record<string, string> = { chrome: 'Chrome' };

/**
 * One step: a quiet line with a chevron, one line tall; a tap shows all of it and what it read or ran. A step still
 * running reads darker, one that failed in red; the screenshot it took shows small under it. `label` is what a screen reader hears.
 */
export function StepRow({
  text,
  label = `Activity: ${text}`,
  state,
  detail,
  thumbnail,
  surface,
  callId,
  kind,
}: {
  text: string;
  label?: string /** what the step did, as the row carries it: the words of a live step ("npm test") say nothing of it */;
  kind?: Kind;
} & StepExtras) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const { verb, subject } = stepParts(text);
  const place = surface ? PLACE[surface] : undefined;
  return (
    <View>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={place ? `${label}, in ${place}` : label}
        accessibilityState={{ expanded: open, busy: state === 'running' }}
        onPress={() => setOpen(!open)}
        hitSlop={4}
        style={{ flexDirection: 'row', alignItems: open ? 'flex-start' : 'center', gap: 8, minHeight: 36, paddingVertical: 5 }}
      >
        <StepGlyph kind={kind ?? kindOfText(text)} />
        <Text
          selectable={open}
          numberOfLines={open ? undefined : 1}
          style={{
            flexShrink: 1,
            // opened, the row's lines start at the top: the first one is centred on the 24 pt glyph beside it
            paddingTop: open ? 2 : 0,
            ...typo.subhead,
            color: state === 'failed' ? theme.bad : state === 'running' ? theme.ink : theme.ink2,
          }}
        >
          {verb}
          {!!subject && <Text style={{ fontFamily: monoFamily(), ...typo.footnote }}>{` ${subject}`}</Text>}
          {!!place && <Text style={{ color: theme.ink3 }}>{` · ${place}`}</Text>}
        </Text>
        <View style={{ paddingTop: open ? 6 : 0 }}>
          <Chevron open={open} color={theme.ink3} />
        </View>
      </Tap>
      {open && !!detail && (
        <Text
          selectable
          style={{
            marginLeft: 32,
            marginBottom: 6,
            padding: 10,
            borderRadius: 10,
            backgroundColor: theme.sunken,
            fontFamily: monoFamily(),
            ...typo.caption,
            color: theme.ink2,
          }}
        >
          {detail}
        </Text>
      )}
      {!!thumbnail && <StepPicture uri={thumbnail} callId={callId} />}
    </View>
  );
}

// memoized on its strings, so a long thread re-renders only the row a streamed delta changed
export const MessageBubble = memo(function MessageBubble({
  role,
  text: rawText,
  id = '',
  streaming = false,
  images = 0,
  messageId,
  pictures,
  ...step
}: {
  role: Role;
  text: string;
  /** names the row, so the replies streaming at once keep their own reveal */
  id?: string;
  /** the reply may still grow: what arrives is paced */
  streaming?: boolean;
  /** how many pictures the message carries, fetched from the computer by `messageId` */
  images?: number;
  messageId?: string;
  /** pictures this phone already holds (a message not sent yet), drawn instead of fetched */
  pictures?: string[];
  /** for a step row: what the step did */
  kind?: Kind;
} & StepExtras) {
  const theme = useTheme();
  const { t } = useTranslation();
  const who = WHO[role] ?? 'Activity';
  const mine = role === 'user' || role === 'liveUser';
  const text = useMemo(
    () => (role === 'assistant' || role === 'preview' ? heartbeatMessage(rawText, streaming) : rawText),
    [rawText, role, streaming],
  );
  const menu = useMessageMenu(text, () => (mine ? text : selectableText(text)));
  // a reply still streaming keeps its React blocks and their per-word fade; it becomes a native run you select in place once the turn has ended
  const native = inPlaceSelection() && !streaming;
  // what MoPilot itself wrote into the chat is a one-line card, never a bubble of envelope text
  const authored = mine ? authoredCardOf(text) : null;
  if (authored) {
    const title = authoredTitle(authored, t);
    return <StepRow text={title} label={`MoPilot: ${title}`} detail={authored.body || undefined} />;
  }
  const quiet = role === 'live' || role === 'activity' || !(role in WHO);
  if (quiet) return <StepRow text={text} label={`${who}: ${text}`} {...step} />;
  const attached = mine && (pictures?.length || images) ? <MessageImages itemId={messageId} count={images} local={pictures} /> : null;
  // pictures alone: the tiles are the message
  if (attached && !text.trim()) return attached;
  return (
    <>
      {attached}
      <View
        // a touch starts with no native view under it: a run that is shown says so after this, and then its own menu answers a long press
        onTouchStartCapture={() => nativeGate.touch(false)}
        onTouchEnd={nativeGate.release}
        onTouchCancel={nativeGate.release}
        style={{
          alignSelf: mine ? 'flex-end' : 'stretch',
          maxWidth: mine ? '82%' : '100%',
          ...(mine
            ? {
                backgroundColor: theme.sunken,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 22,
                marginTop: 6,
                marginBottom: 14,
              }
            : { marginBottom: 12 }),
        }}
      >
        {/* a user bubble's own label names who it is from */}
        {/* a long press opens Copy and Select Text, unless a native run under the finger answers it itself (a press on React text, or beside the runs, is never left with nothing); the pressable is not an element of its own, so the reply's blocks and links stay reachable */}
        <Tap
          feel="none"
          accessible={false}
          onLongPress={mine || !native ? menu.open : () => (nativeGate.touchedNative() ? nativeGate.awaitMenu(menu.open) : menu.open())}
          delayLongPress={350}
        >
          {mine ? (
            <UserText text={text} label={`${who}: ${text}`} a11y={menu.a11y} />
          ) : (
            // not one merged element: each block reads as its rendered text, and a link in it stays reachable
            <Reply
              id={id}
              text={text}
              streaming={streaming}
              a11y={menu.a11y}
              onBlock={menu.onBlock}
              inPlace={native ? { copyMessage: menu.copyAll, selectText: menu.select } : undefined}
            />
          )}
        </Tap>
        {menu.sheet}
      </View>
    </>
  );
});

/** Two or more consecutive steps as one quiet line ("Read 3 files · 2 s"); a tap opens the steps themselves. */
export function ToolRun({ steps, summary, running }: { steps: KeyedRow[]; summary: string; running: boolean }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  // Claude's row says what was done and no time; the time of the turn is on its "Worked" line
  const label = summary;
  const kinds = new Set(steps.map((s) => s.kind ?? kindOfText(s.text)));
  const kind: Kind = kinds.size === 1 ? [...kinds][0] : 'other';
  // the screenshot the run took last shows under its line while it is folded, as a lone step's does
  const shown = open ? undefined : steps.findLast((s) => s.thumbnail);
  return (
    <View>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded: open, busy: running }}
        onPress={() => setOpen(!open)}
        hitSlop={4}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 36, paddingVertical: 5 }}
      >
        <StepGlyph kind={kind} />
        <Text numberOfLines={1} style={{ flexShrink: 1, ...typo.subhead, color: theme.ink2 }}>
          {label}
        </Text>
        <Chevron open={open} color={theme.ink3} />
      </Tap>
      {!!shown?.thumbnail && <StepPicture uri={shown.thumbnail} callId={shown.callId} />}
      {open && (
        <Enter>
          <View style={{ paddingLeft: 32 }}>
            {steps.map((step) => (
              <StepRow
                key={step.key}
                text={step.text}
                kind={step.kind}
                state={step.state}
                detail={step.detail}
                thumbnail={step.thumbnail}
                surface={step.surface}
                callId={step.callId}
              />
            ))}
          </View>
        </Enter>
      )}
    </View>
  );
}
