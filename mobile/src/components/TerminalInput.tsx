// A line of input and the few keys a phone keyboard lacks, for the terminal screen; Tab and the arrows repeat while held.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import { Field } from './ui';
import { monoFamily } from '../fonts';
import { typoWeight } from '../typography';
import { useTheme } from '../theme';

/** The keys sent as the bytes a terminal expects; `repeat` keys go on being sent while they are held. */
export const KEYS = [
  { label: 'Ctrl-C', data: '\u0003', repeat: false },
  { label: 'Tab', data: '\t', repeat: true },
  { label: 'Esc', data: '\u001b', repeat: false },
  { label: '↑', data: '\u001b[A', repeat: true },
  { label: '↓', data: '\u001b[B', repeat: true },
] as const;

/** A hold longer than this starts repeating, every REPEAT_EVERY_MS, and a hold that never ends (no release arrives) stops after MAX_REPEATS. */
export const HOLD_MS = 400;
export const REPEAT_EVERY_MS = 80;
export const MAX_REPEATS = 100;

function KeyButton({
  spec,
  write,
  idle,
  chip,
}: {
  spec: (typeof KEYS)[number];
  write: (data: string) => void;
  idle: () => boolean;
  chip: object;
}) {
  const theme = useTheme();
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = useCallback(() => {
    clearInterval(timer.current as never);
    timer.current = null;
  }, []);
  // leaving the screen while a key is held must not leave it sending
  useEffect(() => stop, [stop]);
  const hold = () => {
    stop();
    let sent = 0;
    write(spec.data);
    // a beat is skipped while earlier keys are still on their way, so a slow link cannot pile them up behind a Ctrl-C
    timer.current = setInterval(() => (++sent >= MAX_REPEATS ? stop() : idle() && write(spec.data)), REPEAT_EVERY_MS);
  };
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={spec.label}
      accessibilityHint={spec.repeat ? 'Hold to repeat' : undefined}
      onPress={() => write(spec.data)}
      // without onLongPress a long hold is one ordinary press when it ends
      {...(spec.repeat && { onLongPress: hold, delayLongPress: HOLD_MS })}
      onPressOut={stop}
      style={chip}
    >
      <Text style={{ fontFamily: monoFamily(), color: theme.termInk }}>{spec.label}</Text>
    </Tap>
  );
}

export function TerminalInput({ write, idle = () => true }: { write: (data: string) => void; idle?: () => boolean }) {
  const theme = useTheme();
  const [line, setLine] = useState('');
  // Enter in a terminal is a carriage return
  const run = () => {
    if (!line) return;
    write(`${line}\r`);
    setLine('');
  };
  const chip = {
    minHeight: 44,
    minWidth: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: theme.termKey,
  } as const;
  return (
    <View style={{ backgroundColor: theme.termBar, padding: 10, gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Field
          placeholder="Type a command"
          placeholderTextColor={theme.termMuted}
          value={line}
          onChangeText={setLine}
          onSubmitEditing={run}
          autoCapitalize="none"
          autoCorrect={false}
          style={{ flex: 1, backgroundColor: theme.termKey, borderWidth: 0, color: theme.termInk, fontFamily: monoFamily() }}
        />
        <Tap
          accessibilityRole="button"
          accessibilityLabel="Run"
          accessibilityState={{ disabled: !line }}
          disabled={!line}
          onPress={run}
          style={{ ...chip, backgroundColor: line ? theme.termInk : theme.termKey }}
        >
          <Text style={{ fontWeight: typoWeight.semibold, color: line ? theme.termBg : theme.termMuted }}>Run</Text>
        </Tap>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {KEYS.map((key) => (
          <KeyButton key={key.label} spec={key} write={write} idle={idle} chip={chip} />
        ))}
      </View>
    </View>
  );
}
