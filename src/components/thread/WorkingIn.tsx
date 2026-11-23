// The floating "working in" stack beside the composer: a card per desktop app the latest turn controls (any harness, MoPilot's tools or a vendor's), with a live thumbnail that opens into a larger live view, the current step, how it ended and a way to bring the app forward.
import { visiblePoll } from '../../lib/visiblePoll';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/core';
import { useSession } from '../../store/session/useSession';
import { native } from '../../lib/native';
import { useAppIdentity, useAppNamesVersion } from '../../lib/appNames';
import { useDocked } from '../../lib/docked';
import { turnNarrationPriors } from '../../lib/agentNarration';
import { workingInOf, type WorkingApp, type WorkingStatus } from '../../lib/workingIn';
import { refusedApps } from '../../lib/controlRefusal';
import type { AppControlEntry } from '../../store/session/sessionState';
import { AppWindow, ArrowUpRight, Ban, CircleAlert, CircleCheck, CircleStop, Spinner } from '../ui/icons';

/** How often a working card asks main for a fresh thumbnail (main also holds it to one a second). */
export const THUMB_POLL_MS = 1000;

/** A card's state: the turn's, or (an app computer use refused, #1724) refused whatever the turn did. */
type CardStatus = WorkingStatus | 'refused';
const STATUS_TEXT: Record<CardStatus, string> = {
  working: 'Working in',
  done: 'Done in',
  stopped: 'Stopped in',
  failed: 'Failed in',
  refused: 'Refused',
};

/** An ended card's status glyph and its tone class. */
const ENDED: Record<Exclude<CardStatus, 'working'>, { tone: string; Icon: typeof Ban }> = {
  done: { tone: 'ok', Icon: CircleCheck },
  stopped: { tone: 'stopped', Icon: CircleStop },
  failed: { tone: 'failed', Icon: CircleAlert },
  refused: { tone: 'failed', Icon: Ban },
};

/** The status before the step, in a slot as wide as the app's icon above it, so both lines' text starts together. */
function Badge({ status }: { status: CardStatus }) {
  if (status === 'working')
    return (
      <span className="working-in-badge" aria-hidden>
        <Spinner size={12} />
      </span>
    );
  const { tone, Icon } = ENDED[status];
  return (
    <span className={`working-in-badge ${tone}`} aria-hidden>
      <Icon size={12} />
    </span>
  );
}

type ThumbSize = 'card' | 'large';

/**
 * The app's window from main, asked once and then once a second while the turn works (main holds it to one a
 * second per size): the card's thumbnail, or the larger picture of the live view a person opened. A failed or
 * empty read keeps the last picture; an answer that lands after the card closed or went is dropped.
 */
function usePolledWindow(threadId: string, app: string, turnId: string, status: WorkingStatus, size: ThumbSize, enabled: boolean) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [bundleId, setBundleId] = useState<string | null>(null);
  useEffect(() => {
    const ask = native.computer.workingThumb;
    // a closed view forgets its last picture, so opening it again never starts on an old frame (the card's own
    // picture stays, so closing the view never blanks the header)
    if (!enabled && size === 'large') setThumb(null);
    if (!ask || !enabled) return;
    let gone = false;
    let pending = false;
    const pull = () => {
      if (pending) return;
      pending = true;
      return ask(threadId, app, turnId, size)
        .then(
          (v) => {
            if (gone) return;
            if (v.thumbnail) setThumb(v.thumbnail);
            if (v.bundleId) setBundleId(v.bundleId);
          },
          () => {
            /* no picture this time: the last one stays */
          },
        )
        .finally(() => {
          pending = false;
        });
    };
    // once more when the turn ends: the card keeps the window as it was left (cannot reject: pull keeps the
    // last picture when a read fails)
    void pull();
    const stop =
      status === 'working' ? visiblePoll(`working-in:${threadId}:${app}`, THUMB_POLL_MS, () => void pull(), { wake: false }) : null;
    return () => {
      gone = true;
      stop?.();
    };
  }, [threadId, turnId, app, status, size, enabled]);
  return { thumb, bundleId };
}

/**
 * One app: the live window (MoPilot's own background thumbnail when it has one, else a capture main takes
 * at most once a second, only with Screen Recording already granted, else the step's last screenshot), a
 * window glyph when there is no picture, then the app's icon and name over the status and step. A click opens
 * the window larger inside MoPilot, as Claude's Watch does, and closes it again; the arrow beside it brings the
 * app to the front (#2045).
 */
function WorkingCard({
  threadId,
  turnId,
  a,
  status,
  live,
  open,
  onToggle,
}: {
  threadId: string;
  turnId: string;
  a: WorkingApp;
  status: WorkingStatus;
  live: AppControlEntry | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const { name, icon } = useAppIdentity(a.app);
  // an open view's larger picture also fills the header: one capture a second, not two
  const small = usePolledWindow(threadId, a.app, turnId, status, 'card', !a.refused && !open);
  const large = usePolledWindow(threadId, a.app, turnId, status, 'large', open && !a.refused);
  const image = a.refused ? null : (live?.thumbnail ?? large.thumb ?? small.thumb ?? a.shot);
  const shown: CardStatus = a.refused ? 'refused' : status;
  const label = `${STATUS_TEXT[shown]} ${name}`;
  // the card already names the app: its step reads "Clicked", not "Clicked in Notes"
  const step = a.step.endsWith(` in ${name}`) ? a.step.slice(0, -` in ${name}`.length) : a.step;
  const bundleId = live?.bundleId ?? large.bundleId ?? small.bundleId;
  const big = large.thumb ?? image;
  return (
    <div className="working-in-card" data-status={shown} data-path={a.path} data-open={open || undefined}>
      <div className="working-in-head">
        <button
          type="button"
          className="working-in-main"
          title={a.refused ? label : `${label} · ${open ? 'Hide' : 'Show'} live view`}
          aria-label={`${label}: ${step}`}
          aria-expanded={a.refused ? undefined : open}
          disabled={a.refused}
          onClick={(e) => e.nativeEvent.isTrusted && onToggle()}
        >
          {image ? (
            <img className="working-in-thumb" src={image} alt={`Live view of ${name}`} />
          ) : (
            <span className="working-in-thumb working-in-icon">
              <AppWindow size={20} />
            </span>
          )}
          <span className="working-in-text">
            <span className="working-in-app">
              {icon ? (
                <img className="working-in-app-icon" src={icon} alt="" />
              ) : (
                <AppWindow size={14} className="working-in-app-icon" aria-hidden />
              )}
              <span className="working-in-name">{name}</span>
            </span>
            <span className="working-in-step" aria-live="polite">
              <Badge status={shown} />
              <span className="working-in-step-text">{step}</span>
            </span>
          </span>
        </button>
        {!a.refused && (
          <button
            type="button"
            className="icon-btn sm working-in-front"
            title={`Bring ${name} to the front`}
            aria-label={`Bring ${name} to the front`}
            onClick={(e) => e.nativeEvent.isTrusted && native.computer.bringToFront?.(a.app, bundleId)}
          >
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
      {open && !a.refused && (
        <div className="working-in-live">
          {big ? (
            <>
              <img src={big} alt={`Live view of ${name}`} />
              {status === 'working' && <span className="working-in-live-badge">Live</span>}
            </>
          ) : (
            <span className="working-in-live-empty">No live view</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Beside the composer while a turn controls desktop apps, and with its end state until the next turn starts. */
export function WorkingInStack({ threadId }: { threadId: string }) {
  const turns = useStore((s) => s.runtime[threadId]?.turns);
  const turn = turns?.at(-1);
  // the app bindings earlier turns left in Codex's computer-use kernel name a later turn's `app.click()`
  // a step names its app once main resolved it (lib/appNames.ts)
  const names = useAppNamesVersion();
  // the apps computer use refused in the turn (the chat's saved notes) show as refused (#1724)
  const notes = useStore((s) => s.chatNotes[threadId]);
  const w = useMemo(() => {
    void names;
    return turns && turn ? workingInOf(turn, turnNarrationPriors(turns).get(turn.id), refusedApps(notes, turns)) : null;
  }, [turns, turn, names, notes]);
  const live = useSession(threadId).appControl?.apps;
  // docked as the computer-use panel the stack would cover the chat, and the strip names the app (src/lib/docked.ts)
  const docked = useDocked();
  // the one app whose live view is open; it closes for good when its app leaves the stack, the chat changes or
  // the window docks (nothing then shows it, so nothing captures it)
  const [opened, setOpened] = useState<{ threadId: string; app: string } | null>(null);
  const openApp = opened?.threadId === threadId ? opened.app : null;
  const isOpen = (a: WorkingApp) => !a.refused && a.app.toLowerCase() === openApp;
  const stillShown = !docked && !!w?.apps.some(isOpen);
  useEffect(() => {
    if (opened && !stillShown) setOpened(null);
  }, [opened, stillShown]);
  if (!w || docked) return null;
  return (
    <div className="working-in-stack" data-status={w.status} data-open={stillShown || undefined}>
      {w.apps.map((a) => (
        <WorkingCard
          key={JSON.stringify([threadId, turn?.id, a.app])}
          threadId={threadId}
          turnId={turn!.id}
          a={a}
          status={w.status}
          live={live?.find((e) => e.app.toLowerCase() === a.app.toLowerCase())}
          open={isOpen(a)}
          onToggle={() => setOpened(isOpen(a) ? null : { threadId, app: a.app.toLowerCase() })}
        />
      ))}
    </div>
  );
}
