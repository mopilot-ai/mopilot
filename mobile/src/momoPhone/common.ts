// What MoMo's phone view models share: time words, machine and agent lookups, and the one-tap action shape.
import { say } from './say';
import type { Agent, Intent, PhoneView } from './types';

export type Action = { label: string; intent: Intent; strong?: boolean };
export type Dot = 'green' | 'amber' | 'red' | 'grey';

/** "Nov 24". */
export const shortDate = (ms: number) =>
  say('shortDate', { month: say(`month${new Date(ms).getMonth() + 1}`), day: new Date(ms).getDate() });

/** "1:12 PM" in the phone's own zone. */
export function clock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return say(h < 12 ? 'timeAm' : 'timePm', { hour: h % 12 || 12, minute: String(d.getMinutes()).padStart(2, '0') });
}

/** "6 min ago", "now", "2 h ago". */
export function ago(now: number, then: number): string {
  const min = Math.max(0, Math.floor((now - then) / 60000));
  if (min < 1) return say('now');
  return min < 60 ? say('minAgo', { count: min }) : say('hourAgo', { count: Math.floor(min / 60) });
}

export const homeName = (v: PhoneView) => v.view.home.machineName ?? say('yourMachine');
export const homeMachine = (v: PhoneView) => v.view.home.machines.find((m) => m.isHome);
export const homeId = (v: PhoneView) => v.view.home.homeMachineId ?? '';

const AGENT_NAMES: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
export const agentName = (agent: Agent) => AGENT_NAMES[agent];
export const agentOf = (display: string): Agent => (display.toLowerCase().includes('codex') ? 'codex' : 'claude');

/** "08:00" as "8:00 AM"; the contract's times are 24-hour in the home's zone. */
export function time12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return say(h < 12 ? 'timeAm' : 'timePm', { hour: h % 12 || 12, minute: String(m).padStart(2, '0') });
}
