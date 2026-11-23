// The line under a turn, as Claude draws it: the orange spark with what the turn is doing, the amber "Waiting for you", then "Worked 1m 20s" with copy and retry.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { Clock } from '../presentation/toolRuns';
import { THINKING_LAST_MS, workedWords, workingWords, type Tail } from '../presentation/workingLine';
import { QUIET_LINE } from '../remote/useQuiet';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { Spark } from './Spark';
import { typo } from '../typography';

/** A 44 pt round target holding one small glyph: the finished turn's copy and retry. */
function LineAction({
  label,
  name,
  glyph,
  onPress,
}: {
  label: string;
  name: 'doc.on.doc' | 'arrow.clockwise';
  glyph: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={{ width: 28, aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}
    >
      <Icon name={name} glyph={glyph} size={15} color={theme.ink2} />
    </Tap>
  );
}

/**
 * While the turn works: the spinning spark and the activity of the step that ends the transcript, or Claude's thinking
 * copy that grows the longer nothing new comes (counted from `since`). A turn silent past the quiet limit says so instead.
 * Waiting: the amber hand. Done: "Worked …", which folds the turn's steps on a tap, with copy and retry beside it.
 */
export function TurnLine({
  clock,
  state,
  folded,
  quiet = false,
  tail = { type: 'none' },
  since,
  toggle,
  copy,
  retry,
}: {
  clock: Clock;
  state: 'working' | 'waiting' | 'done';
  folded: boolean;
  /** The turn is running but nothing has come from it for a while: the line says so instead of claiming work. */
  quiet?: boolean;
  /** What ends the transcript, which names the activity. */
  tail?: Tail;
  /** When the tail last changed (ms since the epoch): the thinking copy grows from here. */
  since?: number;
  toggle?: () => void;
  /** Copies the turn's reply; absent when it has none. */
  copy?: () => void;
  /** Sends your last message again; absent when there is nothing to send. */
  retry?: () => void;
}) {
  const theme = useTheme();
  // the copy escalates here, so the chat around the line is not drawn again every second
  const [now, setNow] = useState(() => Date.now());
  // a line drawn without a time for its tail counts from when it was first drawn
  const [drawnAt] = useState(now);
  const from = since ?? drawnAt;
  // the copy stops changing at its last words, and so does the tick
  const thinking = state === 'working' && !quiet && tail.type !== 'step' && tail.type !== 'reply' && now - from < THINKING_LAST_MS;
  useEffect(() => {
    if (!thinking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [thinking]);
  if (state === 'working') {
    const words = quiet ? QUIET_LINE : workingWords(tail, Math.max(0, now - from));
    return (
      <View
        accessible
        accessibilityLabel={words || 'Responding'}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 30, paddingTop: 6, paddingBottom: 12 }}
      >
        <Spark size={18} spin={!quiet} />
        {!!words && <Text style={{ ...typo.subhead, color: theme.ink2 }}>{words}</Text>}
      </View>
    );
  }
  if (state === 'waiting')
    return (
      <View
        accessible
        accessibilityLabel="Waiting for you"
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 30, paddingTop: 6, paddingBottom: 12 }}
      >
        <Icon name="hand.raised" glyph="✋" size={16} color={theme.amber} />
        <Text style={{ ...typo.subhead, color: theme.warn }}>Waiting for you</Text>
      </View>
    );
  const words = workedWords(clock?.took);
  const text = { ...typo.footnote, color: theme.ink3 } as const;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 2, paddingBottom: 14 }}>
      {toggle ? (
        <Tap
          accessibilityRole="button"
          accessibilityLabel={`${words}, ${folded ? 'show' : 'hide'} the steps`}
          accessibilityState={{ expanded: !folded }}
          onPress={toggle}
          style={{ minHeight: 32, justifyContent: 'center' }}
        >
          <Text style={text}>{words}</Text>
        </Tap>
      ) : (
        <Text accessibilityLabel={words} style={text}>
          {words}
        </Text>
      )}
      {copy && <LineAction label="Copy reply" name="doc.on.doc" glyph="⧉" onPress={copy} />}
      {retry && <LineAction label="Retry" name="arrow.clockwise" glyph="↻" onPress={retry} />}
    </View>
  );
}

/** One chip above the composer after a turn: the lines this chat changed, which opens the Changes screen. */
export function ChangesChip({ added, removed, open }: { added: number; removed: number; open: () => void }) {
  const theme = useTheme();
  const mono = { fontFamily: monoFamily(), ...typo.caption } as const;
  const said = [added ? `${added} added` : '', removed ? `${removed} removed` : ''].filter(Boolean).join(', ');
  return (
    <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 6 }}>
      <Tap
        accessibilityRole="button"
        accessibilityLabel={`Changes${said ? `, ${said}` : ''}`}
        onPress={open}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          minHeight: 36,
          paddingHorizontal: 12,
          borderRadius: 999,
          borderWidth: 1,
          borderColor: theme.line,
          backgroundColor: theme.surface,
        }}
      >
        <Text style={{ ...typo.footnoteSemibold, color: theme.ink }}>Changes</Text>
        <Text style={mono}>
          {!!added && <Text style={{ color: theme.ok }}>{`+${added}`}</Text>}
          {!!added && !!removed && ' '}
          {!!removed && <Text style={{ color: theme.bad }}>{`−${removed}`}</Text>}
        </Text>
      </Tap>
    </View>
  );
}
