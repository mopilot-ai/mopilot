// Codex's Remote Control in the window: the app-server's link to the user's devices, read from main while a Codex chat shows it
// (the summary panel's Session section) and switched from there. It is the computer's, not a chat's, so every Codex chat shows the same one.
import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import { codexApi, type CodexRemoteControlClient, type CodexRemoteControlView } from '../../harness/adapters/codexApi';
import { errorText, noteIgnored } from '../../lib/ignored';
import { useEffectOn } from '../../lib/effects';
import { visiblePoll } from '../../lib/visiblePoll';
import { toast } from '../../store/core';

export type { CodexRemoteControlClient, CodexRemoteControlView };

/** How often the link is read again while a Codex chat shows it: main keeps it current from the app-server's notifications. */
const POLL_MS = 5000;
const OFF: CodexRemoteControlView = { status: 'disabled', environmentId: null, error: null };

const useView = create<{ view: CodexRemoteControlView | null }>(() => ({ view: null }));
let presses = 0;
let reads = 0;

async function read() {
  // an answer that began before a press, or before a newer read, is older than what the screen shows
  const press = presses;
  const mine = ++reads;
  try {
    const view = await codexApi.remoteControlRead();
    if (press === presses && mine === reads) useView.setState({ view });
  } catch (error) {
    noteIgnored("read Codex's Remote Control state", error);
    // Codex that isn't running has no link; the switch stays usable and a press says why it failed
    if (press === presses && mine === reads) useView.setState((s) => (s.view ? s : { view: OFF }));
  }
}

/** Turn the link on or off; a failure is said in a toast, never silent. */
export async function setCodexRemoteControl(on: boolean) {
  presses++;
  try {
    useView.setState({ view: await codexApi.remoteControlSet(on) });
  } catch (error) {
    toast(`Couldn't ${on ? 'turn on' : 'turn off'} Remote Control: ${errorText(error)}`, 'error');
  }
}

/** The link while `active` (a Codex chat shows it); null before the first read. */
export function useCodexRemoteControl(active: boolean): CodexRemoteControlView | null {
  const view = useView((s) => s.view);
  useEffectOn([active], () => {
    if (!active) return undefined;
    void read();
    return visiblePoll('codex-remote-control', POLL_MS, () => void read());
  });
  return view;
}

/** The devices paired with this computer, while the link is up (`connected`): read when it comes up and again on `refresh`. */
export function useRemoteControlClients(connected: boolean) {
  const [clients, setClients] = useState<CodexRemoteControlClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++request.current;
    codexApi.remoteControlClients().then(
      (list) => {
        if (mine !== request.current) return;
        setClients(list);
        setError(null);
      },
      (e) => mine === request.current && setError(errorText(e)),
    );
  }, []);
  useEffectOn([connected], () => {
    if (!connected) {
      request.current++;
      setClients(null);
      setError(null);
      return undefined;
    }
    refresh();
    // an answer that comes after the link went down or the page closed is not shown
    return () => void request.current++;
  });
  return { clients, error, refresh };
}

/** Take a device's access away; a failure is said in a toast. True when it is gone. */
export async function revokeRemoteControlClient(clientId: string): Promise<boolean> {
  try {
    await codexApi.remoteControlRevoke(clientId);
    return true;
  } catch (error) {
    toast(`Couldn't revoke the device: ${errorText(error)}`, 'error');
    return false;
  }
}

export type RemoteControlPairing =
  | { phase: 'loading' }
  | { phase: 'ready'; code: string; secondsLeft: number }
  | { phase: 'expired' }
  | { phase: 'error'; message: string };

/** How often a code's seconds left are redrawn; the code is asked about every other tick. */
const TICK_MS = 1000;

/** A pairing code for a device to type: asked for on open and on `restart`, counted down, and watched until a device uses it (`onClaimed`). */
export function useRemoteControlPairing(onClaimed: () => void) {
  const [pairing, setPairing] = useState<RemoteControlPairing>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const claimed = useRef(onClaimed);
  claimed.current = onClaimed;
  useEffectOn([attempt], () => {
    let live = true;
    let stop: (() => void) | undefined;
    setPairing({ phase: 'loading' });
    codexApi.remoteControlPairing().then(
      ({ code, expiresAt }) => {
        if (!live) return;
        if (!code) return setPairing({ phase: 'error', message: "Couldn't get a pairing code" });
        const left = () => Math.max(0, Math.round(expiresAt - Date.now() / 1000));
        setPairing({ phase: 'ready', code, secondsLeft: left() });
        let asking = false;
        let ticks = 0;
        stop = visiblePoll('codex-remote-pairing', TICK_MS, () => {
          const secondsLeft = left();
          if (secondsLeft === 0) {
            stop?.();
            return setPairing({ phase: 'expired' });
          }
          setPairing({ phase: 'ready', code, secondsLeft });
          if (++ticks % 2 || asking) return;
          asking = true;
          codexApi
            .remoteControlClaimed(code)
            .then(
              (used) => {
                if (!live || !used) return;
                stop?.();
                claimed.current();
              },
              (error) => noteIgnored('check a Remote Control pairing code', error),
            )
            .finally(() => void (asking = false));
        });
      },
      (error) => live && setPairing({ phase: 'error', message: errorText(error) }),
    );
    return () => {
      live = false;
      stop?.();
    };
  });
  return { pairing, restart: () => setAttempt((n) => n + 1) };
}
