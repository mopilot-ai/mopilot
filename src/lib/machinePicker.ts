// A machine's agents as the model picker's rows (#4907): the same names, states, usage and accounts This Mac's picker shows, read from what the Host reports; where the Host reports less, the row says so instead of showing an alias as a name.
import { claudeModels } from '../../shared/claudeModels.mjs';
import { missingHint, type HostLogin } from '../../shared/host/agentReadiness.mjs';
import type { MachineAgent } from './hostMachines';
import type { MachineModel } from '../../shared/host/models.mjs';

/** One model row, with the machine's own model it stands for. */
export interface MachineChoice {
  id: string;
  label: string;
  description?: string;
  note?: string;
  more?: boolean;
  model: MachineModel;
}

/** The versions Claude Code names in a description: "Opus 5.5 · …" or "Use the default model (currently Sonnet 4.5) · …". */
const CURRENTLY = /\(currently ([^)]+?)\)/i;
const FAMILY_VERSION = /^((?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*)(?![\w.])/i;

/** The model the agent's default entry names, or null when its description says none (an older Host, or a CLI that does not). */
export function resolvedDefault(description: string | undefined): string | null {
  const text = description?.trim() ?? '';
  // only a family with its version is a name: "(currently opus)" or a raw model id is an alias, which is never shown as one
  return FAMILY_VERSION.exec(CURRENTLY.exec(text)?.[1].trim() ?? text)?.[1] ?? null;
}

/**
 * The agent's models as rows, by the names and grouping This Mac gives Claude Code's (the version from the description, pinned versions under "More versions"). The default is shown as the model it is (`Opus 5.5`, with "Default" as a quiet note); when the Host does not say which that is, the row
 * says so. `currentOf` maps the model a pick resolves to onto its row: the default entry's row may be another row.
 */
export function machineChoices(models: MachineModel[], machine: string) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const own = (m: MachineModel, over: Partial<MachineChoice> = {}): MachineChoice => ({
    id: m.id,
    label: m.name,
    description: m.description,
    model: m,
    ...over,
  });
  // the names are read from each model's description where it names a version (an agent whose names already carry one is unchanged)
  const named = claudeModels(
    models.map((m) => ({ value: m.id, displayName: m.name, description: m.description ?? '', supportedEffortLevels: m.efforts })),
  );
  const choices = named.map((n: { id: string; label: string; description?: string; more?: boolean }) =>
    own(byId.get(n.id)!, {
      // the name the Host says the model is wins over one read from its description; a Host that says none leaves the description's
      label: byId.get(n.id)!.resolvedModel ?? n.label,
      description: n.description,
      more: n.more,
      ...(models.length > 1 && byId.get(n.id)!.default ? { note: 'Default' } : {}),
    }),
  );
  let target: string | null = null;
  const entry = byId.get('default');
  if (entry) {
    const resolved = entry.resolvedModel ?? resolvedDefault(entry.description);
    const same = resolved ? choices.find((c) => c.label.toLowerCase() === resolved.toLowerCase()) : undefined;
    if (same) {
      same.note = 'Default';
      target = same.id;
    } else {
      const shown = resolved ? { label: resolved, note: 'Default' } : { label: 'Default', note: `Model not reported by ${machine}` };
      choices.unshift(own(entry, { ...shown, description: undefined }));
    }
  }
  return {
    choices,
    /** the row the model `id` is shown as: the default entry shows as the row it resolves to */
    currentOf: (id: string | null | undefined) => (id === 'default' && target ? target : (id ?? null)),
    labelOf: (id: string | null | undefined) => choices.find((c) => c.id === (id === 'default' && target ? target : id))?.label ?? null,
  };
}

const left = (l: HostLogin) => {
  const used = Math.max(0, ...(l.usage ?? []).map((w) => w.usedPercent));
  return l.usage?.length ? `${Math.max(0, Math.round(100 - used))}% left` : null;
};

/** The login the agent runs on, as the Host reports it: the active one, else the only one. */
export const activeLogin = (agent: MachineAgent): HostLogin | null =>
  agent.logins?.find((l) => l.active) ?? (agent.logins?.length === 1 ? agent.logins[0] : null);

/** The action for the CLI's own profile, which the Host can sign in. Added profiles have their own sign-in. */
export function accountSigninAction(agent: MachineAgent) {
  const login = agent.logins?.find((l) => l.id === 'default');
  if (!login || login.state === 'ok') return null;
  const again = login.state === 'expired' || login.label.includes('@') || !!agent.loginAccount?.name;
  return { id: login.id, label: again ? 'Sign in again' : 'Sign in' };
}

/** The CLI profile's status from a fresh, paired Host status request. Unknown reports cannot authorize retry. */
export function reportedCliLoginState(report: unknown, harness: string): HostLogin['state'] | null {
  const status = report as { harnesses?: unknown } | null;
  if (!Array.isArray(status?.harnesses)) return null;
  const agent = status.harnesses.find((h) => h?.id === harness);
  if (agent?.detected !== true || agent.checking === true) return null;
  const login = Array.isArray(agent?.logins) ? agent.logins.find((l: { id?: unknown } | null) => l?.id === 'default') : null;
  const state = login?.state;
  // The CLI probe and the account report settle independently. A mismatch is not a confirmed sign-in or lapse.
  if (agent.signedIn === true && state === 'ok') return state;
  return agent.signedIn === false && (state === 'expired' || state === 'signedOut') ? state : null;
}

const BILLING = { subscription: 'Subscription', apiKey: 'API key' } as const;

/** What is wrong with a login, in a word, or null when it is fine: the first level shows it as well as the account list. */
export const standing = (l: HostLogin): 'Signed out' | 'Expired' | 'Limited' | null =>
  l.state === 'signedOut' ? 'Signed out' : l.state === 'expired' ? 'Expired' : l.limited ? 'Limited' : null;

/** The login the agent's line names: the one a chat would run on, unless a lent key or an organization's access is what it would use. */
const namedLogin = (agent: MachineAgent) => (agent.using === 'key' || agent.using === 'org' ? null : activeLogin(agent));

/** The usage or state line under a ready agent: who it runs as and what is left, else how the machine has it signed in. */
export function agentLine(agent: MachineAgent, machine: string): string {
  // what a chat started now would use comes first: a key this Mac lends or an organization's access, else the machine's own login
  if (agent.using === 'key') return 'Using the key this Mac lends';
  if (agent.using === 'org') return "Using your organization's access";
  const login = namedLogin(agent);
  // the CLI's own record of the account (a name and a plan, as the CLI wrote them) names it where the login has no email of its own
  const account = [agent.loginAccount?.name, agent.loginAccount?.plan].filter(Boolean).join(' · ');
  if (login)
    return [account && !login.label.includes('@') ? account : login.label, standing(login) ?? left(login)].filter(Boolean).join(' · ');
  return account || `Signed in on ${machine}`;
}

/** The second line of a row that cannot run: said once. A missing agent says where to install it (the local row's hint); a signed-out one says a cause only (keychain, refused login, checking, the named methods), never what its badge and Sign in button already say. */
export function notReadyLine(agent: MachineAgent, machine: string): string | null {
  if (agent.unsure === true) return agent.reason;
  if (agent.state === 'ready') return null;
  if (agent.state === 'missing') return missingHint(agent.label, { machine });
  return agent.reason && agent.reason !== `Sign in on ${machine}` ? agent.reason : null;
}

/** An agent's first-level row: its state word when it cannot run yet, and the line that says why or what it runs on. */
export function agentRow(agent: MachineAgent, machine: string) {
  const checking = agent.state === 'signin' && /^Checking/.test(agent.reason);
  const badge =
    agent.unsure === true
      ? { text: 'Couldn’t check', tone: 'warn' as const }
      : agent.state === 'ready'
        ? null
        : agent.state === 'missing'
          ? { text: 'Not installed', tone: 'err' as const }
          : { text: checking ? 'Checking…' : 'Signed out', tone: checking ? ('' as const) : ('warn' as const) };
  return {
    badge,
    usage: agent.state === 'ready' && agent.unsure !== true ? agentLine(agent, machine) : null,
    // a login with something wrong says it on the row the user sees first, in the warning colour
    usageTone: agent.state === 'ready' && namedLogin(agent) && standing(namedLogin(agent)!) ? 'warn' : '',
    why: notReadyLine(agent, machine),
    disabled: agent.state !== 'ready',
  };
}

/** The agent's logins as account rows: the account, how it is billed and its standing. */
export function loginRows(agent: MachineAgent) {
  return (agent.logins ?? []).map((l) => {
    const word = standing(l) ?? left(l) ?? 'Signed in';
    return {
      rowKey: l.id,
      name: l.label,
      desc: [BILLING[l.billing], word].join(' · '),
      tone: standing(l) ? 'warn' : 'ok',
      checked: l.id === activeLogin(agent)?.id,
    };
  });
}

/** The chip's effort word: the level the selection resolves to (never "Default": a model with levels always resolves to one, shared/host/models.mjs hostModelSelection); null for a model without levels. */
export function effortWord(effort: string | null, label: (e: string) => string): string | null {
  return effort ? label(effort) : null;
}
