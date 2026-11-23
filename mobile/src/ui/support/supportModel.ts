// What the support pages decide: the troubleshoot checklist with the one step that fails, and the Mac's and Host's states, read from facts the phone already holds; machine words come from shared/host/machineLine.mjs.
import { machineLine } from '../../../../shared/host/machineLine.mjs';
import type { LineMachine } from '../../../../shared/host/machineLine.d.mts';
import type { Machine } from '../../remote/machines';
import type { HostStatusVM } from '../items';
import { t } from './adapters';

export type CheckId = 'phone' | 'account' | 'relay' | 'mac' | 'app' | 'host';
export type CheckStatus = 'pass' | 'fail' | 'skip';
export type Check = {
  id: CheckId;
  label: string;
  status: CheckStatus;
  hint: string | null;
};
export type SupportKind =
  | 'ok'
  | 'phone-offline'
  | 'signed-out'
  | 'unpaired'
  | 'relay-down'
  | 'mac-asleep'
  | 'mac-closed'
  | 'host-deleted'
  | 'host-asleep'
  | 'host-waking'
  | 'host-away';
export type Diagnosis = {
  kind: SupportKind;
  title: string;
  hint: string | null;
  failing: CheckId | null;
};

/** Facts the phone already holds, with no ids or names of chats in them. */
export type SupportInput = {
  online: boolean;
  signedIn: boolean;
  relay: 'ok' | 'down' | 'unknown';
  mac: {
    name: string;
    paired: boolean;
    presence: 'online' | 'sleeping' | 'gone' | null;
  };
  /** The Host the page is about, when it is about one. */
  host: LineMachine | null;
  hostName?: string;
};

const WAKING = new Set(['creating', 'setting-up', 'connecting', 'waking']);

/** A Host's trouble, or null when it is reachable. */
export function hostKind(host: LineMachine): SupportKind | null {
  if (host.cloud === 'deleted') return 'host-deleted';
  if (host.cloud === 'asleep' || host.cloud === 'stopping') return 'host-asleep';
  if (host.cloud && WAKING.has(host.cloud)) return 'host-waking';
  return host.status === 'offline' ? 'host-away' : null;
}

/** The Host's own line, as the Mac words it for a phone. */
export const hostWords = (host: LineMachine, now: number) => machineLine(host, now, 'phone').text;

/** The Mac's list row as the shared line reads it. */
export function toLineMachine(m: Machine): LineMachine {
  return {
    status: m.status === 'needs-setup' ? 'attention' : m.status,
    note: '',
    agents: m.agents.map((a) => ({ id: a.id, label: a.label, state: a.state })),
    installable: [],
    lastSeen: m.lastSeen ?? null,
    localNetwork: '',
    waitingForLogin: m.waitingForLogin ?? null,
    id: m.id,
    cloud: m.cloud ?? null,
    canWake: false,
    waiting: m.waiting,
  };
}

type Probe = {
  id: CheckId;
  label: string;
  fail: { kind: SupportKind; title: string; hint: string | null } | null;
};

/** The checklist: each step passes, or the first that fails names the problem and the steps after it are skipped. */
export function runChecks(i: SupportInput, now: number): { checks: Check[]; diagnosis: Diagnosis } {
  const mac = i.mac.name;
  const bad = (kind: SupportKind, title: string, hint: string, vars = {}) => ({ kind, title: t(title, vars), hint: t(hint, vars) });
  const hostKindNow = i.host ? hostKind(i.host) : null;
  const probes: Probe[] = [
    {
      id: 'phone',
      label: t('check.phone'),
      fail: i.online ? null : bad('phone-offline', 'diag.phoneOffline', 'diag.phoneOfflineHint'),
    },
    {
      id: 'account',
      label: t('check.account'),
      fail: i.signedIn ? null : bad('signed-out', 'diag.signedOut', 'diag.signedOutHint'),
    },
    {
      id: 'relay',
      label: t('check.relay'),
      fail: i.relay === 'down' ? bad('relay-down', 'diag.relayDown', 'diag.relayDownHint') : null,
    },
    {
      id: 'mac',
      label: t('check.mac'),
      fail: !i.mac.paired
        ? bad('unpaired', 'diag.unpaired', 'diag.unpairedHint')
        : i.mac.presence === 'sleeping'
          ? bad('mac-asleep', 'diag.macAsleep', 'diag.macAsleepHint', {
              name: mac,
            })
          : null,
    },
    {
      id: 'app',
      label: t('check.app'),
      fail:
        i.mac.presence === 'gone'
          ? bad('mac-closed', 'diag.macClosed', 'diag.macClosedHint', {
              name: mac,
            })
          : null,
    },
  ];
  if (i.host && hostKindNow) {
    probes.push({
      id: 'host',
      label: t('check.host', { name: i.hostName ?? '' }),
      fail: {
        kind: hostKindNow,
        title: hostWords(i.host, now),
        hint: hostKindNow === 'host-away' ? t('diag.hostAwayHint') : null,
      },
    });
  } else if (i.host) {
    probes.push({
      id: 'host',
      label: t('check.host', { name: i.hostName ?? '' }),
      fail: null,
    });
  }
  let failed: Probe | null = null;
  const checks = probes.map<Check>((p) => {
    if (failed) return { id: p.id, label: p.label, status: 'skip', hint: null };
    if (p.fail) {
      failed = p;
      return { id: p.id, label: p.label, status: 'fail', hint: p.fail.hint };
    }
    return { id: p.id, label: p.label, status: 'pass', hint: null };
  });
  const diagnosis: Diagnosis = failed
    ? { ...(failed as Probe).fail!, failing: (failed as Probe).id }
    : {
        kind: 'ok',
        title: t('diag.ok'),
        hint: t('diag.okHint'),
        failing: null,
      };
  return { checks, diagnosis };
}

/** Plain text for sharing: the steps and their hints; no ids, no chat text. */
export function checksReport(checks: readonly Check[]): string {
  const mark = { pass: '✓', fail: '✗', skip: '–' } as const;
  return checks.map((c) => `${mark[c.status]} ${c.label}${c.hint ? ` — ${c.hint}` : ''}`).join('\n');
}

/** How a Host reads on the machine page: its own state first, then what the Mac's link adds. */
export function machineNotice(host: HostStatusVM, macPresence: 'online' | 'sleeping' | 'gone' | null): string | null {
  if (host.reach !== 'direct') return null;
  if (macPresence === 'sleeping') return t('machine.macAsleep');
  if (macPresence === 'gone') return t('machine.macAway');
  return null;
}
