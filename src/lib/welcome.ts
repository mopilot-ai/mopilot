// The welcome page's decisions, as pure functions: which agents it lists and in what order, how each first-class one
// can be connected, what stands between the user and it, and which one new chats start with. Install commands are the
// shared table's (shared/harnessInstall.mjs).
import type { HarnessKind } from '../../shared/model/harness';

export type FirstClass = 'codex' | 'claude';
/** How a first-class harness gets its model access: its vendor's subscription, an API key, or MoPilot credits. */
export type Pay = 'subscription' | 'apikey' | 'mopilot';

/** A basic harness's registry kind, from the id main lists it by. */
export const basicKind = (id: string): HarnessKind => `acp:${id}`;

/** The first-class harnesses, in the order the page lists them. */
export const FIRST_CLASS: readonly FirstClass[] = ['claude', 'codex'];

/** The ways to connect a first-class harness: its own subscription (named by the registry), an API key, credits (only
 * where the build has the MoPilot service); each says in a line what it means and who is paid (#2034). */
export function connectMethods(info: { subscription: string; subscriptionPlans: string; vendor: string }, credits = true) {
  const methods: { pay: Pay; label: string; hint: string }[] = [
    { pay: 'subscription', label: info.subscription, hint: `Use your ${info.subscriptionPlans} plan.` },
    { pay: 'apikey', label: 'API key', hint: `Pay ${info.vendor} per use with your own key.` },
  ];
  if (credits) methods.push({ pay: 'mopilot', label: 'MoPilot credits', hint: 'Pay as you go with credits from your MoPilot account.' });
  return methods;
}

/** The basic harnesses most people already pay for: listed first among the others. */
const FEATURED_BASICS = ['acp:copilot', 'acp:cursor', 'acp:gemini'];

/** The basic harnesses with the featured ones first, the rest in the order given. */
export function featuredFirst<T extends { kind: string }>(basics: readonly T[]): T[] {
  const rank = (b: T) => {
    const i = FEATURED_BASICS.indexOf(b.kind);
    return i < 0 ? FEATURED_BASICS.length : i;
  };
  return [...basics].sort((a, b) => rank(a) - rank(b));
}

/** Where an agent stands on this Mac: connected (it can run a chat), installed (not connected yet) or not installed. */
export type Presence = 'connected' | 'installed' | 'missing';

/** A first-class harness's presence, from its detected state: one still being detected counts as installed. */
export const firstPresence = (state: string, usable: boolean): Presence =>
  usable ? 'connected' : state === 'missing' ? 'missing' : 'installed';

/** A basic harness's presence, from main's admission list: one being checked has a binary main probes, so it is installed. */
export const basicPresence = (state: string): Presence =>
  state === 'admitted' ? 'connected' : state === 'missing' ? 'missing' : 'installed';

const RANK: Record<Presence, number> = { connected: 0, installed: 1, missing: 2 };

/**
 * The page's list, ranked by what is on this Mac: connected first, then installed, then missing, each in the order
 * given. A missing first-class harness stays listed; a missing basic one waits behind "N more".
 */
export function rankAgents<T extends { tier: 'first' | 'basic'; presence: Presence }>(agents: readonly T[]): { shown: T[]; more: T[] } {
  const ranked = agents.map((a, i) => ({ a, i })).sort((x, y) => RANK[x.a.presence] - RANK[y.a.presence] || x.i - y.i);
  const folded = (a: T) => a.tier === 'basic' && a.presence === 'missing';
  return { shown: ranked.filter(({ a }) => !folded(a)).map(({ a }) => a), more: ranked.filter(({ a }) => folded(a)).map(({ a }) => a) };
}

export type SetupNeed = 'checking' | 'install' | 'credential' | 'broken' | 'ready';

/** What stands between the user and a usable harness, from its detected state. */
export function setupNeed(
  state: 'detecting' | 'ready' | 'signin' | 'apikey' | 'missing' | 'error',
  usable: boolean,
  rejected = false,
): SetupNeed {
  if (usable) return 'ready';
  if (state === 'detecting') return 'checking';
  if (state === 'missing') return 'install';
  // installed but not working (it keeps quitting, or its version can't be used): a sign-in would not help; its
  // settings, where another binary is picked, would. A credential it refused is replaced by connecting another.
  if (state === 'error' && !rejected) return 'broken';
  return 'credential';
}

/**
 * Whether the welcome page opens: once nothing is still being looked for, while no harness can run a chat, or on a
 * new install where none of the first-class ones can, so Codex and Claude Code are offered even when a basic one
 * works (#2034). `welcomeDone` is the saved mark, read only once the prefs are loaded.
 */
export function welcomeDue(o: {
  checking: boolean;
  anyUsable: boolean;
  firstClassUsable: boolean;
  welcomeDone: boolean;
  /** left for Settings this launch (a CLI's location): not welcomed again over it */
  dismissed?: boolean;
}): boolean {
  return !o.checking && (!o.anyUsable || (!o.firstClassUsable && !o.welcomeDone && !o.dismissed));
}

/**
 * What the window shows below the title bar: the welcome page while it is open, the app once a harness can run a chat,
 * the launch's first moments while the harnesses are still looked for (until `capped`: that has taken long), and the
 * welcome page otherwise.
 */
export function launchGate(o: {
  welcoming: boolean;
  showApp: boolean;
  checking: boolean;
  capped: boolean;
}): 'welcome' | 'app' | 'checking' {
  if (o.welcoming) return 'welcome';
  if (o.showApp) return 'app';
  return o.checking && !o.capped ? 'checking' : 'welcome';
}

export type LaunchKind = 'ready' | 'basic-only' | 'nothing';

/** What the user has on first launch: a first-class harness, only admitted basic ones (D-42: the app still opens), or nothing. */
export function launchKind(codexOk: boolean, claudeOk: boolean, basicAdmitted: number): LaunchKind {
  if (codexOk || claudeOk) return 'ready';
  return basicAdmitted > 0 ? 'basic-only' : 'nothing';
}

/** Every connected agent, in the page's order: the usable first-class harnesses, then the admitted basic ones. */
export function connectedKinds(usable: Record<FirstClass, boolean>, basicStatus: readonly { id: string; state: string }[]): HarnessKind[] {
  const first = FIRST_CLASS.filter((h) => usable[h]);
  return [...first, ...basicStatus.filter((b) => b.state === 'admitted').map((b) => basicKind(b.id))];
}

/** The agents connected while the page was open, in the order they connected: `joined` with the new ones appended. */
export function joinedSince(
  joined: readonly HarnessKind[],
  connected: readonly HarnessKind[],
  atOpen: readonly HarnessKind[],
): HarnessKind[] {
  const fresh = connected.filter((k) => !atOpen.includes(k) && !joined.includes(k));
  return fresh.length ? [...joined, ...fresh] : (joined as HarnessKind[]);
}

/**
 * Which agent new chats start with: the first one connected on this page that still works, else the default the user
 * already has while it is connected, else the first connected.
 */
export function startWith(connected: readonly HarnessKind[], joined: readonly HarnessKind[], current: HarnessKind): HarnessKind | null {
  return joined.find((k) => connected.includes(k)) ?? (connected.includes(current) ? current : (connected[0] ?? null));
}
