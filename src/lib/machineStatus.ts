// A machine's one status line in Settings › My machines: the first state that matches gives its dot, its words and at most one action ("Online · Claude Code, Codex"; "Codex needs sign-in · Sign in"; "Offline · seen 2 h ago"). One rule per state, so a new state (a Host's own report) is one more entry in MACHINE_STATES.
import type { HostMachineRow, MachineAgent } from './hostMachines';
import type { HostSigninView } from './hostSignin';
import type { HostInstallView } from './hostInstall';
import { RUNNING } from './hostSignin';
import { signinStatus } from './hostSigninCopy';
import { startLabel } from '../../shared/host/signinWords.mjs';
import { installLine } from './hostInstall';
import {
  KEEP_RUNNING_HINT,
  LINGER_HINT,
  LEAD_STATES,
  LOCAL_NETWORK_HINT,
  TAIL_STATES,
  installableAgents,
  installOffers,
  seenAgo,
  shownAgents,
} from '../../shared/host/machineLine.mjs';

export type MachineDot = 'ok' | 'warn' | 'off';
/** The one thing the row asks the person to do, for one agent. */
export type MachineAction = { kind: 'signin' | 'install'; agent: MachineAgent; label: string; expired?: boolean };
/** `title`: the registry's own sentence, as the line's tooltip, when the line says it shorter. */
export type MachineStatusLine = {
  dot: MachineDot;
  text: string;
  action?: MachineAction;
  title?: string;
  update?: { label: string };
  check?: { label: string };
};

/** What the row knows besides the machine: the clock, the sign-in it speaks about, and an install under way on it. */
export type MachineStatusContext = {
  now: number;
  signin: { agent: MachineAgent; view: HostSigninView } | null;
  installing: HostInstallView | undefined;
};
export type MachineState = {
  id: string;
  match: (m: HostMachineRow, c: MachineStatusContext) => boolean;
  line: (m: HostMachineRow, c: MachineStatusContext) => MachineStatusLine;
};

export { seenAgo, installableAgents, installOffers, LOCAL_NETWORK_HINT, KEEP_RUNNING_HINT, LINGER_HINT };

const ready = (m: HostMachineRow) => shownAgents(m.agents).filter((a) => a.state === 'ready');

/** In order: the first state that matches says the line. The last one always matches. */
export const MACHINE_STATES: readonly MachineState[] = [
  // a machine that does not answer (shared with the phone: shared/host/machineLine.mjs)
  ...(LEAD_STATES as readonly MachineState[]),
  {
    id: 'installing',
    match: (_m, c) => !!c.installing,
    line: (m, c) => ({ dot: ready(m).length ? 'ok' : 'warn', text: installLine(c.installing) }),
  },
  {
    id: 'signing-in',
    match: (_m, c) => !!c.signin,
    line: (_m, c) => {
      const { agent, view } = c.signin!;
      // the same plain words as the chat's sign-in card (hostSigninCopy.ts): the agent is named once, the code shown, a vendor's own words only as the tooltip
      const said = signinStatus(view, agent.label);
      // a cancelled one has nothing of its own to say: the agent still needs its sign-in
      const line = said ? `${said.text}${said.code ? `: ${said.code}` : ''}` : `${agent.label} needs sign-in`;
      const text = line.includes(agent.label) ? line : `${agent.label}: ${line}`;
      const title = said?.details ? { title: said.details } : {};
      // one under way shows its own code field and Cancel; one that ended without signing in is started again
      if (RUNNING.has(view.state)) return { dot: 'warn', text, ...title };
      return {
        dot: 'warn',
        text,
        ...title,
        action: {
          kind: 'signin',
          agent,
          label: startLabel(view.state),
          expired: view.state === 'expired',
        },
      };
    },
  },
  // the machine's Host updating from the app, and an old one that can be (the machine answers: an offline one is a state above)
  {
    id: 'host-update',
    match: (m) => m.update === 'running' || m.update === 'waiting' || m.update === 'failed' || m.hostStale === true || m.hostNewer === true,
    line: (m) => {
      if (m.update === 'running')
        return { dot: 'warn', text: 'Updating Host…', ...(m.updateError && { title: `Last try: ${m.updateError}` }) };
      if (m.update === 'waiting') return { dot: 'warn', text: 'Updates when idle', title: `Waiting for ${m.name} to finish its work.` };
      if (m.update === 'failed' && m.updateNeedsPair)
        return {
          dot: 'warn',
          text: 'Pair again',
          title: `${m.updateError || 'This Mac is not paired with the Host.'} Add this machine again with its pairing code.`,
        };
      if (m.update === 'failed')
        return { dot: 'warn', text: 'Update failed', title: m.updateError || undefined, update: { label: 'Try again' } };
      // Update would replace a Host newer than this app with the app's older build (#4923)
      if (m.hostNewer) return { dot: 'warn', text: 'Host is newer · Update MoPilot' };
      const what = m.hostDiffers ? 'Host differs from this app' : 'Host is out of date';
      // a machine added by command has no ssh to send the build over (#4912): its Host is updated there
      if (m.id.startsWith('relay:'))
        return {
          dot: 'warn',
          text: `${what} · Update it on the machine`,
          title: 'No ssh from here. Run the update command on the machine.',
        };
      return {
        dot: 'warn',
        text: what,
        ...(m.hostDiffers && { title: 'Update replaces the Host with this app’s build.' }),
        update: { label: 'Update' },
      };
    },
  },
  // what the machine's agents are ready for, and a reason otherwise (shared with the phone)
  ...(TAIL_STATES as readonly MachineState[]),
];

export function machineStatus(m: HostMachineRow, c: MachineStatusContext): MachineStatusLine {
  // the last state matches every machine
  return (MACHINE_STATES.find((s) => s.match(m, c)) as MachineState).line(m, c);
}

/** Whether a refusal's sentence asks for the machine's Host to be updated ("Update the Host on that machine.", "Update Host on that machine to use this Mac’s sign-in.", "Update {machine} to switch agents.", "... Update it."). */
export const asksHostUpdate = (text: string | null | undefined): boolean =>
  !!text && /\bUpdate (the )?Host\b|\bto switch agents\b|\bUpdate it\.?$/.test(text);

/** The row's Host-update state for a machine, as a chat shows it beside a sentence that asks for the update: the same line the row says (so a button exists exactly where the row's Update does), or null when the row has no such state. */
export function hostUpdateLine(m: HostMachineRow): MachineStatusLine | null {
  const c: MachineStatusContext = { now: Date.now(), signin: null, installing: undefined };
  const state = MACHINE_STATES.find((s) => s.match(m, c)) as MachineState;
  return state.id === 'host-update' ? state.line(m, c) : null;
}
