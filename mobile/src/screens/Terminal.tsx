// A shell on the Mac in the chat's folder: its output (pinch to resize, long-press to select), a line of input and a few keys, sized to the phone; closed when the screen is left.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Share, Text, useWindowDimensions, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { randomId } from '../platform/randomId';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { Followed } from '../components/Followed';
import { MirrorGate } from '../components/MirrorGate';
import { TerminalInput } from '../components/TerminalInput';
import { usePinchSize } from '../components/usePinchSize';
import { ScreenHeader } from '../components/ChatHeader';
import { Button, ErrorLine, useStyles } from '../components/ui';
import { explain } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';
import { applyData, display, emptyTerminal, exitText, type Terminal as State } from '../remote/mirror';
import { typo } from '../typography';

type Event = { ev?: string; stream?: string; at?: unknown; data?: unknown; exitCode?: unknown; signal?: unknown };

function TerminalBody({ runtime, chatId }: { runtime: MobileRuntime; chatId: string }) {
  const request = useOwnedRequest(runtime);
  const [stream] = useState(() => randomId());
  const [state, setState] = useState<State>(emptyTerminal());
  const [phase, setPhase] = useState<'opening' | 'open' | 'failed'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { size: fontSize, settled, handlers: pinch } = usePinchSize();
  // the terminal is as wide as the phone's monospace text: a column is 0.6 of the font size (7.2 points at 12)
  const cols = Math.max(20, Math.min(200, Math.floor((useWindowDimensions().width - 40) / (settled * 0.6))));
  const size = useRef(cols);
  size.current = cols;
  const decoder = useRef(new TextDecoder());
  const have = useRef(0);
  have.current = state.at;
  // events that arrive before pty.open answers wait here, so none is lost or applied out of order
  const gate = useRef<{ opened: boolean; events: Event[] }>({ opened: false, events: [] });
  const opens = useRef(0);
  const apply = useCallback((e: Event) => {
    setState((old) =>
      e.ev === 'pty.exit' ? { ...old, exit: exitText(e.exitCode, e.signal) } : applyData(old, decoder.current, e.at, e.data),
    );
  }, []);
  useEffect(
    () =>
      runtime.onEvent((message) => {
        const e = message as Event;
        if (e.stream !== stream || (e.ev !== 'pty.data' && e.ev !== 'pty.exit')) return;
        if (gate.current.opened) apply(e);
        else gate.current.events.push(e);
      }),
    [runtime, stream, apply],
  );
  const open = useCallback(() => {
    const mine = ++opens.current;
    gate.current = { opened: false, events: [] };
    // the replay the Mac sends answers the gap; a gap that persists is flagged again by the next slice
    setState((old) => (old.gap ? { ...old, gap: false } : old));
    setPhase('opening');
    setError(null);
    request('pty.open', { chatId, stream, cols: size.current, rows: 24, ...(have.current ? { from: have.current } : {}) })
      .then((result) => {
        if (mine !== opens.current) return;
        setNote((result as { truncated?: boolean } | null)?.truncated ? 'Some earlier output is no longer available.' : null);
        const waiting = gate.current.events;
        gate.current = { opened: true, events: [] };
        for (const e of waiting) apply(e);
        setPhase('open');
      })
      .catch((e) => {
        if (mine !== opens.current) return;
        setError(explain(e));
        setPhase('failed');
      });
  }, [request, chatId, stream, apply]);
  useEffect(() => {
    open();
    return () => {
      ++opens.current;
    };
  }, [open]);
  // a slice that skipped ahead: ask the Mac to replay from what the screen has
  useEffect(() => {
    if (state.gap && phase === 'open') open();
  }, [state.gap, phase, open]);
  useEffect(
    () => () => {
      closed.current = true;
      void request('pty.close', { stream }).catch(() => undefined);
    },
    [request, stream],
  );
  useEffect(() => {
    if (phase === 'open') void request('pty.resize', { stream, cols, rows: 24 }).catch(() => undefined);
  }, [phase, cols, request, stream]);
  // keys and lines go out one after another, so what is typed arrives in order
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  // writes not yet answered, so a held key can wait for them
  const queued = useRef(0);
  const closed = useRef(false);
  const write = useCallback(
    (data: string) => {
      // what is still queued when the screen is left is dropped, not sent to a closed terminal
      queued.current++;
      writes.current = writes.current
        .then(() =>
          closed.current
            ? undefined
            : request('pty.write', { stream, data }).then(
                () => setError(null),
                (e) => setError(explain(e)),
              ),
        )
        .finally(() => void queued.current--);
    },
    [request, stream],
  );
  const shown = useMemo(() => display(state.text), [state.text]);
  // while text is selected the output holds still: a redraw would drop the selection
  const [held, setHeld] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const theme = useTheme();
  const muted = { color: theme.termMuted, ...typo.footnote } as const;
  return (
    <View style={{ flex: 1, backgroundColor: theme.termBg }}>
      {held !== null && (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', padding: 10, backgroundColor: theme.termBar }}>
          <Text style={{ ...muted, flex: 1 }}>
            {held === shown ? 'Output is paused. Select text, or copy it all.' : 'Output is paused; there is newer output.'}
          </Text>
          <Button
            secondary
            title="Copy all"
            onPress={() => {
              setCopyFailed(false);
              Share.share({ message: held }).then(
                () => undefined,
                () => setCopyFailed(true),
              );
            }}
          />
          <Button
            secondary
            title="Done"
            onPress={() => {
              setHeld(null);
              setCopyFailed(false);
            }}
          />
        </View>
      )}
      {copyFailed && <ErrorLine text="The output could not be copied." />}
      <View style={{ flex: 1 }} {...pinch}>
        <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
          <Text style={muted}>A shell in this chat's folder on your computer.</Text>
          {phase === 'opening' && <Text style={muted}>Opening… If your computer asks to allow the terminal, approve it there.</Text>}
          <ErrorLine text={error} />
          {phase === 'failed' && <Button secondary title="Retry" onPress={open} />}
          {note && <Text style={muted}>{note}</Text>}
          {phase === 'open' && !shown && !state.exit && <Text style={muted}>No output yet.</Text>}
          {!!shown && (
            <Text
              selectable={held !== null}
              accessibilityHint="Long press to hold the output for selecting"
              // while held, a long press belongs to the selection, not to a new snapshot
              onLongPress={held === null ? () => setHeld(shown) : undefined}
              style={{ color: theme.termInk, fontFamily: monoFamily(), fontSize, lineHeight: Math.round((fontSize * 17) / 12) }}
            >
              {held ?? shown}
            </Text>
          )}
          {state.exit && <Text style={muted}>{state.exit}</Text>}
        </ScrollView>
      </View>
      {phase === 'open' && !state.exit && <TerminalInput write={write} idle={() => queued.current === 0} />}
    </View>
  );
}

/** The Mac refuses this to a device that does not follow the chat or has the switch off, so the screen follows the chat and asks first; Back is always there. */
export function Terminal(props: { runtime: MobileRuntime; chatId: string; back: () => void; title?: string; subtitle?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.page}>
      <ScreenHeader title="Terminal" subtitle={props.title ?? props.subtitle} back={props.back} />
      <Followed runtime={props.runtime} chatId={props.chatId}>
        <MirrorGate runtime={props.runtime}>
          <TerminalBody runtime={props.runtime} chatId={props.chatId} />
        </MirrorGate>
      </Followed>
    </View>
  );
}
