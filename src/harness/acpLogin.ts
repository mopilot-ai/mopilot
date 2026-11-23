// How a basic (ACP) harness signs in in a terminal, from what it says about its auth methods: the terminal-auth command
// in a method's _meta, ACP's terminal auth method (the harness's own binary with the method's args and env), else the
// login command its quirks name. Pure: the callers open the terminal.
import type { BasicHarnessStatus as BasicHarness } from '../lib/native';
import { DIRECTORY_PATH } from '../lib/registryCopy';

/** A terminal sign-in: the command, its tab's title, and environment the harness asked for (only when it did). */
export type LoginTerminal = { command: string[]; title: string; env?: Record<string, string> };
export type LoginUnavailable = { command: null; title: string; reason: string };
type LoginDecision = LoginTerminal | LoginUnavailable;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** The method's args and env as the harness sent them: strings only, env only when it names something. */
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
function withEnv(t: LoginTerminal, env: unknown): LoginTerminal {
  const vars = isRecord(env) ? Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string') : [];
  return vars.length ? { ...t, env: Object.fromEntries(vars) } : t;
}

/** A managed auth capability can be explicitly unavailable; it must not fall back to the ACP launcher. */
const authBinary = (h: BasicHarness) => (h.authBin === undefined ? h.bin : h.authBin);
const executableName = (file: string) => file.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd)$/i, '');
const unavailable = (
  h: BasicHarness,
  reason = `Open ${DIRECTORY_PATH} and choose Repair for ${h.label}, then try signing in again.`,
): LoginUnavailable => ({ command: null, title: `${h.label} login`, reason });

/** Every entry point distinguishes terminal refusal from an authentication method handled over ACP. */
export function dispatchLogin(
  decision: LoginDecision | null,
  actions: { terminal: (terminal: LoginTerminal) => unknown; authenticate: () => unknown; unavailable: (reason: string) => unknown },
) {
  if (!decision) return actions.authenticate();
  if (decision.command === null) return actions.unavailable(decision.reason);
  return actions.terminal(decision);
}

/**
 * A method's own terminal sign-in: the terminal-auth command in its _meta, else ACP's terminal auth method (type
 * 'terminal', at the top as Kimi Code sends it or in _meta as Qwen Code does), which runs the harness's own binary with
 * the method's args and env. Null means ACP authenticate; an unavailable terminal owner returns a visible refusal.
 */
function methodTerminal(h: BasicHarness, m: BasicHarness['authMethods'][number]): LoginDecision | null {
  const term = m._meta?.['terminal-auth'];
  // Declared own names and the exact launcher path share the installed owner; explicit other helpers keep their command.
  const bin = (c: string) => {
    const own =
      c === h.bin ||
      (!/[\\/]/.test(c) && [h.bin, ...(h.descriptor?.bins ?? [])].some((file) => file && executableName(file) === executableName(c)));
    return own ? authBinary(h) : c;
  };
  if (term?.command !== undefined) {
    if (typeof term.command !== 'string' || !term.command || term.command.includes('\0'))
      return unavailable(h, `${h.label} sent an invalid terminal sign-in command. Update or Repair it before trying again.`);
    const command = bin(term.command);
    return command
      ? withEnv({ command: [command, ...strings(term.args)], title: term.label ?? `${h.label} login` }, term.env)
      : unavailable(h);
  }
  const typed = m.type === 'terminal' ? m : m._meta?.type === 'terminal' ? m._meta : null;
  const owner = authBinary(h);
  if (typed && owner) return withEnv({ command: [owner, ...strings(typed.args)], title: `${h.label} login` }, typed.env);
  if (typed && h.authBin === null) return unavailable(h);
  return null;
}

/**
 * The terminal command for signing in: the method's own terminal sign-in, else the quirks' loginCommand. Null when the
 * method signs in over ACP authenticate instead; a terminal refusal stays distinct for every UI entry point.
 */
export function loginCommand(h: BasicHarness, methodId: string | null): LoginDecision | null {
  const m = h.authMethods.find((x) => x.id === methodId);
  const own = m ? methodTerminal(h, m) : null;
  if (own) return own;
  const owner = authBinary(h);
  if (h.login && owner) return { command: [owner, ...h.login.slice(1)], title: `${h.label} login` };
  if (h.login && h.authBin === null) return unavailable(h);
  return null;
}

/** The harness's terminal login: the first method's own terminal sign-in, else its quirks' loginCommand. */
export function loginTerminal(h: BasicHarness) {
  for (const m of h.authMethods) {
    const own = methodTerminal(h, m);
    if (own) return own;
  }
  return loginCommand(h, null);
}
