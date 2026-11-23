// Each harness's route in the windows: main's answer (electron/harness/routes.cjs) kept once for every component, read again when a window comes to the front, and what each surface says about it.
import { useMemo, useSyncExternalStore } from 'react';
import { native } from '../lib/native';
import { getClaudeKey, subscribeClaudeKey } from './claudeKeyState';
import type { HarnessRouteEntry } from '../lib/native/routes';
import { abbreviateHome } from '../lib/paths';
import { ignoring } from '../lib/ignored';

let routes: HarnessRouteEntry[] = [];
const listeners = new Set<() => void>();
let started = false;

function set(list: HarnessRouteEntry[]) {
  routes = list;
  for (const l of listeners) l();
}

/** The first subscriber starts listening; focus reads the files again (a watcher can miss another tool's write). */
function start() {
  if (started) return;
  started = true;
  native.routes.onChanged(set);
  native.routes.list().then(set, ignoring("read the harnesses' routes"));
  window.addEventListener('focus', () => void native.routes.refresh().then(set, ignoring("read the harnesses' routes again")));
}

function subscribe(cb: () => void) {
  start();
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** One harness's route ('codex', 'claude', 'acp:<id>'), or null until main has read it; Claude Code's while it runs on Your own provider. */
export function useHarnessRoute(harness: string): HarnessRouteEntry | null {
  const read = useSyncExternalStore(subscribe, () => routes.find((r) => r.harness === harness) ?? null);
  const key = useSyncExternalStore(subscribeClaudeKey, getClaudeKey);
  return useMemo(() => (harness === 'claude' ? withRouted(read, routedOf(key)) : read), [harness, read, key]);
}

/**
 * A Claude Code route while MoPilot sends it through its own model router (Your own provider, electron/routing). The
 * harness's own config still wins where it names an endpoint or a cloud (the CLI applies its settings.json `env` over
 * the environment MoPilot starts it with), so then the route stays as read and says routing is off (`routedOff`);
 * otherwise it is MoPilot's route (`mopilot-routed`), named after the model config. A route that can't be read stays as it is.
 */
export function withRouted(route: HarnessRouteEntry | null, routed: { label: string } | null): HarnessRouteEntry | null {
  if (!route || !routed || route.kind === 'unknown') return route;
  if (route.reasons.includes('endpoint') || route.reasons.includes('cloud')) return { ...route, effects: [...route.effects, 'routedOff'] };
  return { ...route, kind: 'mopilot-routed', label: routed.label };
}

/** What Claude Code's key setting says of Your own provider: its name while it is the way Claude Code pays. */
export function routedOf(key: ReturnType<typeof getClaudeKey>): { label: string } | null {
  if (key?.mode !== 'routed') return null;
  return { label: key.routed?.name ?? 'a removed model config' };
}

/**
 * Whether a surface says anything: a route set outside MoPilot, a file that can't be read, a process on the old
 * config, or something the route turned off that stays off after it went.
 */
export function routeShown(r: HarnessRouteEntry | null): r is HarnessRouteEntry {
  return !!r && (r.kind !== 'direct' || r.stale.idle + r.stale.running > 0 || r.effects.length > 0);
}

/** "127.0.0.1:3425" from an origin. */
export const hostOf = (endpoint: string | null) => (endpoint ? endpoint.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') : null);

/** The tag beside a model or a usage reading: "via magpie", "via local gateway", "model set outside MoPilot". */
export function routeTag(r: HarnessRouteEntry): string | null {
  if (r.kind === 'unknown') return 'route unknown';
  if (r.kind === 'mopilot-routed') return `via ${r.label}`;
  if (r.kind !== 'external') return null;
  return r.label ? `via ${r.label}` : 'model set outside MoPilot';
}

/** The sentence that says where the harness's requests go and who set it. */
export function routeSentence(r: HarnessRouteEntry, harness: string): string {
  const file = r.file ? abbreviateHome(r.file) : null;
  const setIn = file ? ` ${file} sets this, not MoPilot.` : '';
  if (r.kind === 'unknown')
    return `MoPilot couldn't read ${file ?? 'the config'}${r.error ? ` (${r.error.replace(/^Couldn't read [^:]+: /, '')})` : ''}.${
      r.lastGood?.label ? ` It last read requests going through ${r.lastGood.label}.` : ''
    }`;
  if (r.kind === 'mopilot-routed')
    return `MoPilot sends ${harness}'s requests to your own provider (${r.label}) through its model router on this Mac, with the key you saved. That provider bills you, not your ${harness} sign-in.`;
  if (r.kind !== 'external') return '';
  if (r.cloud) return `${harness} runs on ${r.cloud}, so that cloud account pays, not your ${harness} sign-in.${setIn}`;
  const at = hostOf(r.endpoint);
  // a known tool by its name; anything else by where it is
  if (r.router)
    return `Requests from ${harness} go through ${r.label}${at ? ` at ${at}` : ''}. The model, the account that pays and the limits are ${r.label}'s, not your ${harness} sign-in's.${setIn}`;
  if (r.reasons.includes('endpoint'))
    return `Requests from ${harness} go to ${r.loopback ? `a local gateway at ${at}` : (at ?? 'a custom endpoint')} instead of ${harness}'s own service. The model, the account that pays and the limits are that endpoint's, not your ${harness} sign-in's.${setIn}`;
  return `${file ?? 'Its config'} sets the model to ${r.model}, which isn't one of ${harness}'s own models.`;
}

/** What Restart to apply says, or null while every process runs on the current config. */
export function staleText(r: HarnessRouteEntry, harness: string): string | null {
  const { idle, running } = r.stale;
  if (!idle && !running) return null;
  const lead = `The config changed after ${harness} started, so it still runs on the old one.`;
  if (!idle) return `${lead} Restart to apply once ${running === 1 ? 'its running chat finishes' : `its ${running} running chats finish`}.`;
  if (running)
    return `${lead} ${running === 1 ? 'A chat still working keeps' : `${running} chats still working keep`} the old config until you restart again.`;
  return lead;
}

/** What a reading of usage means while the harness's requests go somewhere else. */
/** Where requests go, in a sentence: the router's name, "a local gateway", the endpoint's host or the cloud; null when only the model changed. */
export function routeName(r: HarnessRouteEntry): string | null {
  if (r.kind === 'mopilot-routed') return r.label;
  if (r.kind !== 'external' || !r.label) return null;
  return !r.router && r.loopback ? 'a local gateway' : r.label;
}

export function usageRouteNote(r: HarnessRouteEntry, harness: string): string | null {
  const name = routeName(r);
  if (!name) return null;
  return `These limits are your ${harness} sign-in's. Requests now go through ${name}, which may bill another account, so this reading may not move as you chat.`;
}

type HeaderProvider = { label: string; firstParty?: boolean };
/**
 * The provider level of the model picker's header (harness/modelHeader.ts): a provider MoPilot chose for the
 * chat (MoPilot credits, a custom endpoint) is its route; otherwise the router the harness's own config names.
 */
export function headerProvider<P extends HeaderProvider>(
  chosen: P | null | undefined,
  r: HarnessRouteEntry | null,
): P | HeaderProvider | null {
  if (chosen && !chosen.firstParty) return chosen;
  return r?.kind === 'external' && r.label ? { label: r.label, firstParty: false } : (chosen ?? null);
}
