// The agent page's content: each sub-agent's own transcript, by MoPilot chat id and AgentRun key, filled live or on demand by the harness adapters.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { identityKey } from '../../shared/identityKey.mjs';
import type { AgentRun } from '../lib/agentRun';
import { errorText } from '../lib/ignored';
import type { AgentItem } from '../../shared/model/window';
export type { AgentItem } from '../../shared/model/window';

export interface AgentThread {
  items: AgentItem[];
  /** the adapter is fetching the stored transcript */
  loading: boolean;
  error: string | null;
  /** items arrive live from the running session (no load needed) */
  live: boolean;
  /** the model the agent ran on, when only its stored transcript says so */
  model: string | null;
}

/** Reads a finished or not-yet-seen agent's transcript from where its harness stores it. */
export type AgentThreadLoad = AgentItem[] | { items: AgentItem[]; model: string | null };
export type AgentThreadLoader = (chatId: string, run: AgentRun) => Promise<AgentThreadLoad>;

const EMPTY: AgentThread = Object.freeze({ items: [], loading: false, error: null, live: false, model: null }) as AgentThread;
const threads = new Map<string, AgentThread>();
const loads = new Map<string, symbol>();
const listeners = new Set<() => void>();
let resolveLoader: (chatId: string, run: AgentRun) => AgentThreadLoader | null = () => null;

const id = (chatId: string, key: string) => identityKey(chatId, key);
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};

/** The current transcript of one agent; an empty, idle one when nothing is known yet. */
export const agentThread = (chatId: string, key: string): AgentThread => threads.get(id(chatId, key)) ?? EMPTY;

function put(chatId: string, key: string, patch: Partial<AgentThread>) {
  const prev = agentThread(chatId, key);
  threads.set(id(chatId, key), { ...prev, ...patch });
  emit();
}

/**
 * Replace an agent's items as its session streams them. Items that did not change keep their identity
 * (pass the same objects), so settled rows don't re-render.
 */
export function putAgentItems(chatId: string, key: string, items: AgentItem[]) {
  loads.delete(id(chatId, key));
  put(chatId, key, { items, live: true, loading: false, error: null });
}

/** Record the model a stored transcript shows the agent ran on (a replayed run carries none of its own). */
export function putAgentModel(chatId: string, key: string, model: string) {
  put(chatId, key, { model });
}

/** Choose the loader for a chat (the store wires this to the chat's current adapter). */
export function setAgentThreadLoaderResolver(f: (chatId: string, run: AgentRun) => AgentThreadLoader | null) {
  resolveLoader = f;
}

/** Load an agent's stored transcript once, unless it is streaming live or already loaded or loading. */
export async function loadAgentThread(chatId: string, run: AgentRun): Promise<void> {
  const cur = agentThread(chatId, run.key);
  if (cur.live || cur.loading || cur.items.length || run.transcript === 'summary') return;
  const loader = resolveLoader(chatId, run);
  if (!loader) return;
  const slot = id(chatId, run.key);
  const load = Symbol();
  loads.set(slot, load);
  const current = () => loads.get(slot) === load;
  put(chatId, run.key, { loading: true, error: null });
  try {
    const result = await loader(chatId, run);
    // A live stream retires either outcome from this read.
    if (current()) put(chatId, run.key, { ...(Array.isArray(result) ? { items: result } : result), loading: false });
  } catch (e) {
    if (current()) put(chatId, run.key, { loading: false, error: errorText(e) });
  } finally {
    if (current()) loads.delete(slot);
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Re-render when any agent transcript in the store changes (a nested agent's status lives in its parent's transcript). */
export function useAgentThreadsVersion(): number {
  return useSyncExternalStore(subscribe, () => version);
}

/** An agent's transcript for the agent page, loading the stored one when the session isn't streaming it. */
export function useAgentThread(chatId: string, run: AgentRun | null): AgentThread {
  const key = run?.key ?? '';
  const thread = useSyncExternalStore(subscribe, () => (run ? agentThread(chatId, key) : EMPTY));
  // the load starts once per agent; later changes to its run (a streaming heartbeat) must not start another
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (key && latest.current) void loadAgentThread(chatId, latest.current);
  }, [chatId, key]);
  return thread;
}
