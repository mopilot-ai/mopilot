// The user's own providers in the windows (electron/app/ipc/routing.cjs): the catalog with which providers have a key, and the saved model configs, read once for every component and again whenever any window changes one.
import { useSyncExternalStore } from 'react';
import { native } from './native';
import type { ModelConfigList, RoutingProvider } from './native/routing';
import { ignoring } from './ignored';

export interface RoutingView {
  providers: RoutingProvider[];
  /** 'unreadable': the saved keys can't be read, so none can be used or changed */
  keys: 'ok' | 'unreadable';
  configs: ModelConfigList['configs'];
  /** 'unreadable': the saved configs can't be read; `configs` are the ones last read, and changes are refused */
  state: ModelConfigList['state'];
  /** whether main answered yet */
  loaded: boolean;
}

const EMPTY: RoutingView = { providers: [], keys: 'ok', configs: [], state: 'ok', loaded: false };
let view: RoutingView = EMPTY;
const listeners = new Set<() => void>();
let started = false;
/** Each read's turn: an older read that answers late never replaces a newer one. */
let seq = 0;

/** Read the catalog and the configs again; never rejects (a failed read keeps what was shown). */
export async function reloadRouting(): Promise<void> {
  const mine = ++seq;
  try {
    const [p, c] = await Promise.all([native.routing.providers(), native.routing.configs()]);
    if (mine !== seq) return;
    view = { providers: p.providers, keys: p.keys, configs: c.configs, state: c.state, loaded: true };
    for (const l of listeners) l();
  } catch (e) {
    ignoring('read your own providers and model configs')(e);
  }
}

function subscribe(cb: () => void) {
  if (!started) {
    started = true;
    native.routing.onChanged(() => void reloadRouting());
    void reloadRouting();
  }
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** A subscription for a window that doesn't read the configs: nothing to stop. */
const idle = () => () => {
  /* nothing was started */
};

/** The providers and model configs, as main last said; read only while `wanted` (where this app can route at all). */
export function useRouting(wanted = true): RoutingView {
  return useSyncExternalStore(wanted ? subscribe : idle, () => (wanted ? view : EMPTY));
}

/** The providers a Claude Code request can be sent to now: those that speak Anthropic's or OpenAI's chat wire (Gemini comes later). */
export const claudeRoutable = (p: RoutingProvider) => p.wires.includes('anthropic') || p.wires.includes('openai-chat');
