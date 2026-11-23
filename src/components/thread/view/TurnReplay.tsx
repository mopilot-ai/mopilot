// Replay on a turn (#3571, G5): when the user records turn replays and this turn used the built-in browser, a button in its actions opens the turn's trace: its frames on a scrubber, the steps beside them, and the console and request counts.
import { useEffect, useState } from 'react';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { isEnabled } from '../../../lib/flags';
import { Tooltip } from '../../ui/Popover';
import { Modal } from '../../ui/Modal';
import { History, Pause, Play } from '../../ui/icons';
import { type TurnTrace, actionAtFrame, actionLine, frameOfAction, frameUrl, traceOfTurn } from '../../../lib/turnTrace';
import styles from './turnReplay.module.css';

/** Each chat's traces, read once and again when one is saved. */
const cache = new Map<string, Promise<TurnTrace[]>>();
const listeners = new Set<(chatId: string) => void>();
let listening = false;

/** The chat's saved traces (empty while none), refreshed when main saves one for it. */
export function useTurnTraces(chatId: string, on: boolean): TurnTrace[] {
  const [traces, setTraces] = useState<TurnTrace[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () => {
      if (!cache.has(chatId))
        cache.set(
          chatId,
          native.browser.turnTraces(chatId).catch((error: unknown) => {
            // no Replay for the chat's turns this time; the turns themselves are unaffected
            noteIgnored('list the turn traces of a chat', error);
            return [];
          }),
        );
      void cache.get(chatId)?.then((t) => live && setTraces(t));
    };
    // the shared listener below dropped the chat's cached list: read it again
    const saved = (id: string) => {
      if (id === chatId) load();
    };
    if (!listening) {
      listening = true;
      native.browser.onTraceSaved((s) => {
        cache.delete(s.chatId);
        for (const fn of listeners) fn(s.chatId);
      });
    }
    listeners.add(saved);
    load();
    return () => {
      live = false;
      listeners.delete(saved);
    };
  }, [chatId, on]);
  return traces;
}

/** How long each frame shows while playing. */
const PLAY_MS = 250;

export function ReplayDialog({ trace, onClose }: { trace: TurnTrace; onClose: () => void }) {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const last = Math.max(0, trace.frames.length - 1);
  useEffect(() => {
    if (!playing) return;
    if (frame >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setFrame((f) => f + 1), PLAY_MS);
    return () => clearTimeout(t);
  }, [playing, frame, last]);
  const step = actionAtFrame(trace, frame);
  const url = frameUrl(trace, frame);
  const errors = trace.console.filter((c) => c.level === 'error').length;
  return (
    <Modal title="Replay" onClose={onClose}>
      <div className={styles.replay}>
        <div className={styles.stage}>
          {url ? <img src={url} alt={`Frame ${frame + 1}`} /> : <span className={styles.empty}>No frames</span>}
        </div>
        <div className={styles.controls}>
          <button
            className="icon-btn xs"
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!trace.frames.length}
            onClick={() => {
              if (!playing && frame >= last) setFrame(0);
              setPlaying(!playing);
            }}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <input
            type="range"
            aria-label="Frame"
            min={0}
            max={last}
            value={frame}
            disabled={!trace.frames.length}
            onChange={(e) => {
              setPlaying(false);
              setFrame(Number(e.target.value));
            }}
          />
          <span className={styles.count}>{trace.frames.length ? `${frame + 1}/${trace.frames.length}` : '0/0'}</span>
        </div>
        <ol className={styles.steps}>
          {trace.actions.map((a, i) => (
            <li key={`${a.at}-${a.tool}-${a.before}`}>
              <button
                className={`${styles.step} ${i === step ? styles.on : ''} ${a.ok ? '' : styles.failed}`}
                aria-current={i === step ? 'step' : undefined}
                onClick={() => {
                  setPlaying(false);
                  setFrame(frameOfAction(trace, i));
                }}
              >
                {actionLine(a)}
              </button>
            </li>
          ))}
        </ol>
        <div className={styles.meta}>
          {trace.requests} requests · {trace.console.length} console{errors ? ` (${errors} errors)` : ''}
        </div>
      </div>
    </Modal>
  );
}

/** The Replay button of a finished turn, shown only when the turn has a trace. */
export function TurnReplay({
  threadId,
  startedAt,
  completedAt,
}: {
  threadId: string;
  startedAt?: number | null;
  completedAt?: number | null;
}) {
  // read with the turn's render (as Settings reads it): a turn re-renders often enough for a switched flag to show
  const on = isEnabled('shared.browser.turnTrace') === true;
  const trace = traceOfTurn(useTurnTraces(threadId, on), startedAt, completedAt);
  const [open, setOpen] = useState(false);
  if (!on || !trace) return null;
  return (
    <>
      <Tooltip label="Replay">
        <button className="icon-btn xs" aria-label="Replay" onClick={() => setOpen(true)}>
          <History size={15} />
        </button>
      </Tooltip>
      {open && <ReplayDialog trace={trace} onClose={() => setOpen(false)} />}
    </>
  );
}
