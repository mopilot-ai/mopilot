// Local environments: the resolved config main reads (environment.toml, else Conductor's), and editing `.codex/environments/environment.toml`.

import { parse, stringify } from 'smol-toml';
import { errorText } from './ignored';
import { installedNative, native } from './native';

/**
 * Local environments: `<project>/.codex/environments/environment.toml`, the same file the
 * official app uses to set up new worktrees and to offer project actions. Sage edits this
 * platform's view of it (darwin, win32) and leaves every other platform's entries as they were.
 */
export interface EnvAction {
  name: string;
  icon: 'tool' | 'run' | 'debug' | 'test' | null;
  command: string;
  platform?: 'darwin' | 'linux' | 'win32';
}
export interface LocalEnvironment {
  version: number;
  name: string;
  setup: { script: string };
  cleanup?: { script: string };
  actions?: EnvAction[];
  /** the parsed file as read; writes start from it */
  raw?: Record<string, unknown>;
}

export const envPath = (root: string) => `${root}/.codex/environments/environment.toml`;

// per-platform scripts and actions: this OS's (darwin, win32, linux), else the shared one (the bridge's platform, as
// ./platform reads it; macOS where there is no bridge)
const platform: string = installedNative()?.platform || 'darwin';
const forPlatform = (a: { platform?: string } | null | undefined) => !a?.platform || a.platform === platform;
const scriptOf = (t: unknown) => {
  const table = t as (Record<string, { script?: unknown } | undefined> & { script?: unknown }) | null | undefined;
  return String(table?.[platform]?.script ?? table?.script ?? '');
};

/** This platform's view of an environment.toml's text, keeping the parsed file for the write back; throws on bad TOML. */
export function environmentOf(text: string): LocalEnvironment {
  const t = parse(text) as Record<string, unknown>;
  return {
    version: Number(t.version ?? 1),
    name: String(t.name ?? ''),
    setup: { script: scriptOf(t.setup) },
    cleanup: t.cleanup ? { script: scriptOf(t.cleanup) } : undefined,
    actions: Array.isArray(t.actions) ? t.actions.filter(forPlatform) : [],
    raw: t,
  };
}

/** A script table with this platform's script set: under e.g. `darwin` when the file has one, else the shared `script`. */
function withScript(table: unknown, script: string) {
  const t: Record<string, unknown> = table && typeof table === 'object' ? { ...table } : {};
  if (t[platform] && typeof t[platform] === 'object') t[platform] = { ...(t[platform] as object), script };
  else t.script = script;
  return t;
}

const clean = (a: EnvAction) => Object.fromEntries(Object.entries(a).filter(([, v]) => v != null && v !== ''));

/** The file's text for `env`: the raw file with only this platform's fields changed. */
export function stringifyEnvironment(env: LocalEnvironment): string {
  const doc: Record<string, unknown> = { ...(env.raw ?? {}) };
  doc.version = env.version || 1;
  doc.name = env.name;
  doc.setup = withScript(doc.setup, env.setup.script);
  if (doc.cleanup || env.cleanup?.script) doc.cleanup = withScript(doc.cleanup, env.cleanup?.script ?? '');
  // this platform's actions take the slots of the ones they replace; other platforms' stay where they were
  const edited = (env.actions ?? []).map(clean);
  const actions: unknown[] = [];
  let i = 0;
  for (const a of Array.isArray(doc.actions) ? doc.actions : []) {
    if (!forPlatform(a)) actions.push(a);
    else if (i < edited.length) actions.push(edited[i++]);
  }
  actions.push(...edited.slice(i));
  if (actions.length) doc.actions = actions;
  else delete doc.actions;
  return stringify(doc) + '\n';
}

/**
 * The project's environment, or null when it has no environment.toml. A file that is there but isn't valid TOML
 * rejects, as one that can't be read does: taken for none, the editor would open blank and Save would replace it
 * (with other platforms' scripts and actions in it).
 */
export async function readEnvironment(root: string): Promise<LocalEnvironment | null> {
  const text = await native.fs.readText(envPath(root));
  if (!text) return null;
  try {
    return environmentOf(text);
  } catch (e) {
    // the parser's first line (the rest is a code frame)
    throw new Error(`${envPath(root)} isn't valid TOML (${errorText(e).split('\n')[0]}). Fix it in a text editor`);
  }
}

export async function writeEnvironment(root: string, env: LocalEnvironment) {
  const r = await native.env.write(root, stringifyEnvironment(env));
  if (!r.ok) throw new Error(`Couldn't save the environment: ${r.error}`);
}

/**
 * A project's environment as main resolves it (electron/platform/environmentSource.cjs): environment.toml, else
 * Conductor's `.conductor/settings.local.toml` over `.conductor/settings.toml`, else its legacy `conductor.json`.
 */
export interface ResolvedEnvironment {
  setup: string;
  cleanup: string;
  actions: EnvAction[];
  /** gitignore-style patterns of ignored files a new worktree should get */
  copy: string[];
  copySource: 'worktreeinclude' | 'conductor' | 'default' | null;
  /** why `.worktreeinclude`, which is there, could not be read */
  copyError: string | null;
  /** the file family that supplies the scripts and actions; null when the project has none */
  source: 'environment' | 'conductor' | 'conductor-json' | null;
  files: string[];
  /** why environment.toml, which is there, could not be read */
  error: string | null;
  unreadable: { file: string; reason: string }[];
  /** "Found Conductor config we couldn't read: ..." ('' when all of it was read) */
  notice: string;
}

/**
 * The project's setup script, cleanup script and actions from whichever source main uses, so a window and main never
 * disagree. Rejects for an environment.toml that is there but can't be read (as readEnvironment does); Conductor config
 * that can't be read resolves with `notice` set.
 */
export async function resolveEnvironment(root: string): Promise<ResolvedEnvironment> {
  const r = await native.env.resolve(root);
  if (r.error !== null) throw new Error(r.error);
  return r;
}

/** Write environment.toml from the project's Conductor config (main refuses when the project already has one). */
export async function convertEnvironment(root: string) {
  const r = await native.env.convert(root);
  if (!r.ok) throw new Error(`Couldn't convert the Conductor config: ${r.error}`);
}
