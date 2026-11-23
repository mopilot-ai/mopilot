// Computer access's wording for Settings (#1364): what each scope is called, a device's scopes in a line, the time an
// offer has left, and an access log line as a sentence. Pure.
import type { AccessLogLine, AccessScopes } from './native/computerAccess';
import type { SageApprovalAnswer, SageApprovalParams } from './native/contracts/control';

/** The scopes a person picks for a device (files come later). */
export const SCOPE_CHOICES: readonly { id: keyof AccessScopes; label: string }[] = [
  { id: 'browser', label: 'Built-in browser' },
  { id: 'chrome', label: 'Your Chrome' },
  { id: 'apps', label: 'Apps' },
];

/** A device's scopes in a line: "Built-in browser, Apps", or "Nothing allowed". */
export function scopeLabels(s: AccessScopes): string {
  const on = SCOPE_CHOICES.filter((c) => s[c.id]).map((c) => c.label);
  return on.length ? on.join(', ') : 'Nothing allowed';
}

/** How long until `expiresAt`, as m:ss (0:00 once it passed). */
export function timeLeft(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const EVENT_TEXT: Record<AccessLogLine['event'], string> = {
  pairing: 'asked to pair',
  paired: 'was paired',
  denied: 'was not allowed to pair',
  connected: 'connected',
  disconnected: 'disconnected',
  refused: 'was refused',
  revoked: 'was removed',
  call: 'used',
  stop: 'was stopped',
  off: 'Computer access went off',
};

/** One access log line as a sentence: "10:42 · Laptop used browser_navigate (ok, 120 ms)". */
export function accessLogText(l: AccessLogLine): string {
  const time = new Date(l.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = l.deviceName ?? l.device ?? '';
  const what = l.event === 'off' ? EVENT_TEXT.off : `${who || 'A device'} ${EVENT_TEXT[l.event]}`;
  const tool = l.tool ? ` ${l.tool}` : '';
  const detail = [l.outcome, l.code && l.code !== l.outcome ? l.code : null, typeof l.ms === 'number' ? `${l.ms} ms` : null].filter(
    Boolean,
  );
  return `${time} · ${what}${tool}${detail.length ? ` (${detail.join(', ')})` : ''}`;
}

/** A card a paired device's chat raised on this Mac, in a line for Settings: what it asks to do. */
export function remoteCardText(p: Partial<SageApprovalParams> | null | undefined): string {
  switch (p?.kind) {
    case 'browserOrigin':
      return `Use ${p.origin ?? 'a site'} in the built-in browser (${p.level === 'write' ? 'read and write' : 'read only'})`;
    case 'computerConfirm':
      return `${p.verb ? `${p.verb[0].toUpperCase()}${p.verb.slice(1)}` : 'Do something that can’t be undone'}${p.summary ? `: ${p.summary}` : ''}`;
    case 'computerAccess':
      return `Control ${p.app?.name ?? 'an app'}`;
    case 'computerAccessSet':
      return `Use ${(p.apps ?? []).map((a) => a.name).join(', ') || 'apps'}`;
    case 'computerTakeover':
      return 'Take over the screen';
    default:
      return 'Something only its own device can show';
  }
}

/** Allow on this Mac for that card, as its own card would answer once; null when only the device can answer it. */
export function remoteCardAllow(p: Partial<SageApprovalParams> | null | undefined): SageApprovalAnswer | null {
  switch (p?.kind) {
    case 'browserOrigin':
    case 'computerAccess':
      return { decision: 'allow', scope: 'once', level: p.level };
    case 'computerConfirm':
    case 'computerTakeover':
      return { decision: 'allow' };
    case 'computerAccessSet':
      return { decision: 'allow', apps: (p.apps ?? []).map((a) => a.bundleId) };
    default:
      return null;
  }
}
