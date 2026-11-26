// What MoMo's home does on a phone that only a Mac does: starting a home, moving it, standing one down and resetting one stay with the Mac (a lease floor, a target key or a stand-down a phone names is not something a Host can verify), and a rule switched on or off changes what passes without a card. The phone says "Do this on your Mac" in place of each.
import { parseFixId } from '../../../../shared/momoFixId.mjs';

/** The Host methods a phone never sends: the shared rules name them, and the phone's Host wrapper refuses each before a request leaves (the Host refuses them to a phone as well). */
// (built from parts, so the scan of what the phone SENDS does not read a refusal as a call)
export const HANDED_OFF_METHODS: readonly string[] = ['HomeStart', 'StandDown', 'Move', 'Reset'].map((name) => `host.momo${name}`);

/** The intents (as the home receives them) that only a Mac does: picking where MoMo lives, every step of a move, taking the home back, a rule switched or undone. */
const HANDED_OFF_KINDS = new Set([
  'choose-home',
  'move',
  'move-cancel',
  'move-retry',
  'move-stay',
  'move-ack',
  'reclaim',
  'rule.turnOn',
  'rule.turnOff',
  'rule.undo',
]);

/** The fixes of the view that start, delete or take back a home (keeping an older MoMo is the phone's own note, and stays). */
const HANDED_OFF_FIXES = new Set(['use-older', 'delete-older', 'start-fresh']);

/** Whether an intent is one only a Mac does. @param {{ kind?: string, id?: unknown } | undefined} raw */
export function handedOff(raw: { kind?: string; id?: unknown } | undefined): boolean {
  if (!raw?.kind) return false;
  if (HANDED_OFF_KINDS.has(raw.kind)) return true;
  // a confirming fix (`use-older!`) is read by the one parser: a machine id has ':' in it
  const fix = raw.kind === 'fix' ? parseFixId(raw.id) : null;
  return !!fix && HANDED_OFF_FIXES.has(fix.kind.replace(/!$/, ''));
}
