// MoMo's channels and groups in a window (A2): the list main keeps (electron/momo/channels.cjs), read again when main says it changed and when the window comes back, and the calls that change it. `enabled` is false while `momo.channels` is off or the list can't be read yet: nothing of channels is drawn then. A call never throws: it resolves the answer, or the reason in the user's words.
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { errorText } from '../../../lib/ignored';
import type { MomoChannel, MomoChannelGroup } from '../../../lib/native/contracts/momoChannels';

export interface MomoChannelsState {
  enabled: boolean;
  channels: MomoChannel[];
  groups: MomoChannelGroup[];
  /** how many more channels may be made */
  room: number;
  /** why the last read failed, or null */
  error: string | null;
  reload: () => void;
}

const NONE = { enabled: false, channels: [] as MomoChannel[], groups: [] as MomoChannelGroup[], room: 0 };

export function useMomoChannels(): MomoChannelsState {
  const [state, setState] = useState(NONE);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const read = useCallback(() => {
    // the newest read wins
    const seq = ++latest.current;
    native.momoChannels.list().then(
      (r) => {
        if (seq !== latest.current) return;
        if (r.ok) {
          setState({ enabled: r.enabled, channels: r.channels, groups: r.groups, room: r.room });
          setError(null);
        } else setError(r.error);
      },
      (e: unknown) => seq === latest.current && setError(errorText(e)),
    );
  }, []);
  useEffect(() => {
    read();
    const off = native.momoChannels.onChanged(read);
    return () => {
      latest.current = -1;
      off();
    };
  }, [read]);
  return { ...state, error, reload: read };
}

/** A call's answer as the dialogs use it: the value, or the words that say why not. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs one call of window.native.momoChannels; never throws. */
export async function channelCall<R extends { ok: boolean }, T>(
  run: () => Promise<R>,
  pick: (r: Extract<R, { ok: true }>) => T,
): Promise<Outcome<T>> {
  try {
    const r = await run();
    return r.ok
      ? { ok: true, value: pick(r as Extract<R, { ok: true }>) }
      : { ok: false, error: (r as unknown as { error: string }).error };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}
