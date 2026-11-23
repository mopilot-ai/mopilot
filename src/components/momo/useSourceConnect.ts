// The one implementation of a Calendar or Reminders connect (#2999): what Connect and Open System Settings do, the phase a row or card is in (sourceConnect.ts rowPhase) and the check when the window comes back to the front after System Settings. Settings › MoMo › Sources (SourcesSection.tsx), the chat's connect card (MomoConnectCard.tsx) and the line under a routine (RoutineConnectNote.tsx) use it. useMomoSource reads the source's state from main and again whenever a source changes.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useWindowListener } from '../../lib/effects';
import { errorText, noteIgnored } from '../../lib/ignored';
import { native } from '../../lib/native';
import type { MomoSource, MomoSourceId } from '../../lib/native/contracts/momoSources';
import { ASK_LINE_DELAY_MS, connectNotice, openPrivacyPane, rowPhase, type RowPhase } from './sourceConnect';

export type SourceConnect = {
  phase: RowPhase;
  /** a real failure (red): the text main or the bridge gave */
  problem: string | null;
  busy: boolean;
  connect: () => Promise<void>;
  openSettings: () => void;
};

/** `watching`: main has the privacy pane open and finishes the connect when the switch goes on. `onChanged`: the source may have changed, read it again. */
export function useSourceConnect(o: {
  id: MomoSourceId;
  label: string;
  connected: boolean;
  /** connected in MoMo, but macOS refuses it (main's `needsGrant`): the row is not connected until it is allowed again */
  grantLost?: boolean;
  watching: boolean;
  onChanged: () => void;
}): SourceConnect {
  const { id, label, connected, grantLost = false, watching, onChanged } = o;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  /** macOS refused or never showed its prompt: the switch in System Settings is the way */
  const [off, setOff] = useState(false);
  /** a wait for this row has run: when it is over and the row is still off, it says so */
  const [sawWatching, setSawWatching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (watching) setSawWatching(true);
  }, [watching]);
  const phase = rowPhase({ connected: connected && !grantLost, lost: connected && grantLost, asking, off, watching, sawWatching });
  const pending = phase === 'needs' || phase === 'waiting' || phase === 'stalled';
  // back in the app after System Settings: read the grant now, no matter whether the wait is still running
  const checking = useRef(false);
  useWindowListener('focus', () => {
    if (!pending || checking.current) return;
    checking.current = true;
    native.momoSources
      .recheck(id)
      .then((r) => {
        if (r.ok && r.connected) onChanged();
      })
      .catch((e: unknown) => noteIgnored('check a macOS grant when the window came back', e))
      .finally(() => {
        checking.current = false;
      });
  });
  const connect = async () => {
    setBusy(true);
    setProblem(null);
    // Files has no macOS prompt to wait for (a folder is picked in Settings), so only Calendar and Reminders show the Allow line
    const timer = id === 'files' ? null : setTimeout(() => setAsking(true), ASK_LINE_DELAY_MS);
    try {
      const r = await native.momoSources.connect(id);
      if (!r.ok) setProblem(r.error);
      else {
        const notice = connectNotice(r, label);
        if (r.waiting || r.grant === 'denied' || notice?.privacy) setOff(true);
        else if (notice) setProblem(notice.text);
      }
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      if (timer) clearTimeout(timer);
      setAsking(false);
      setBusy(false);
      onChanged();
    }
  };
  // the pane opens whatever macOS answered last (even none, when its prompt never showed), and main waits for the switch
  const openSettings = () => {
    setProblem(null);
    // a wait that is still running stays the one this row has seen; otherwise the pane starts a new one
    setSawWatching(watching);
    void openPrivacyPane(id).then((why) => {
      if (why) setProblem(why);
      onChanged();
    });
  };
  return { phase, problem, busy, connect, openSettings };
}

/** One source as main has it, and whether main is waiting for its macOS switch; read again whenever a source changes. */
export function useMomoSource(id: MomoSourceId): { source: MomoSource | null; watching: boolean; reload: () => void } {
  const [source, setSource] = useState<MomoSource | null>(null);
  const [watching, setWatching] = useState(false);
  /** the newest load: a change while one runs starts another, and only the newest one's answer is shown */
  const latest = useRef(0);
  const load = useCallback(async () => {
    const seq = ++latest.current;
    try {
      const r = await native.momoSources.list();
      if (seq !== latest.current || !r.ok) return;
      setSource(r.sources.find((s) => s.id === id) ?? null);
      setWatching((r.waiting ?? []).includes(id));
    } catch (e) {
      noteIgnored("read MoMo's sources for a connect row", e);
    }
  }, [id]);
  useEffect(() => {
    void load();
    return native.momoSources.onChanged(() => void load());
  }, [load]);
  return { source, watching, reload: () => void load() };
}
