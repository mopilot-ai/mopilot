// The phone's one client for the M3 methods (start, options, review, voice): owner-scoped requests and defensive reads of what the Mac returns, so screens stay thin.
import type { MobileRuntime } from '../contracts';
import { cancellable, sendChunks } from './upload';

/** A method this Mac does not offer (an older MoPilot); screens show the message and hide the control. */
export class Unavailable extends Error {}

/** `detail` is the Mac's line under an agent ("Uses your Claude login"), when it sends one. */
export type Harness = { id: string; label: string; detail?: string | null; unavailable?: boolean };
/** `branch` is the branch the project's folder is on, from a Mac that reports it (null when unknown or older). */
export type Project = { id: string; label: string; branch?: string | null };
export type Effort = { id: string; label: string };
/** `more`: the Mac files this model under "More models" (an older version of a family it lists by name); absent from an older Mac, which lists every model as current. */
export type Model = {
  id: string;
  label: string;
  description?: string | null;
  efforts: Effort[];
  defaultEffort: string | null;
  more?: boolean;
  /** The Mac says this model can run in auto mode */
  autoMode?: boolean;
};
export type PermissionRow = { id: string; label: string; detail: string; disabled?: string };
/** A login a new chat can run on; `signedOut` ones are listed so they are not silently missing, but cannot be picked. */
export type Account = {
  id: string;
  label: string;
  signedOut?: boolean /** the login has hit its limit and waits for its reset */;
  limited?: boolean;
};
export type Options = {
  models: Model[];
  accounts: Account[];
  model: string | null;
  effort: string | null;
  permissions: PermissionRow[];
  permission: string | null;
  /** The current permission as the Mac names it, also when the phone may not set it (full access, above the ceiling). */
  permissionLabel: string | null;
  /** The permissions the Mac offers that only the Mac may set (full access, above its ceiling), by their names. */
  macOnly: string[];
  /** An open chat only: the login it is pinned to (null: the agent's own choice, then `serving` is the one now used). */
  account?: { id: string | null; pinned: boolean; serving: string | null };
  /** An open chat only: whether its agent can hold a chat on its own login now (a Mac that does not say leaves it out). */
  perChat?: boolean;
};
/** `mirrors`: whether the Mac turned the terminal and screen on for this phone; null when it did not say. `renameChats` / `archiveChats` / `sideChats`: the Mac renames and archives chats and starts a side chat for the phone (absent on an older Mac). */
export type Capabilities = {
  methods: Set<string> | null;
  ceiling: string;
  mirrors?: boolean | null;
  renameChats?: boolean;
  archiveChats?: boolean;
  /** The Mac pages older rows from rows it holds, a slice per page: only such a Mac is asked to fill a chat's older rows in the background (#5379). */
  olderRowsHeld?: boolean;
  sideChats?: boolean;
};
/** Permission ids in the Mac's order, weakest first; a phone is never offered full access (bypass). */
const ORDER = ['read-only', 'default', 'auto-review', 'full-access'];
const NEVER = 'full-access';
const OFFLINE = 'Your computer is offline or asleep. Wake it and try again.';
const STALE = 'The connected computer changed. Try again.';
/** A request the connection lost or never answered (a relay that hangs). */
export const UNREACHED = "Couldn't reach your computer. Try again.";

export const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
export const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
export const list = (v: unknown) => (Array.isArray(v) ? v : []);
export const bad = (what: string): never => {
  throw new Error(`Could not read ${what} from your computer.`);
};

/** What a rejected request means for the user: an offline Mac says so, and a lost or unanswered request (or a bare code such as INVALID_STATE_ERR) says it did not reach the computer, instead of the runtime's transport errors. */
export function explain(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  if (/^(Computer is offline|Relay disconnected)/i.test(text)) return OFFLINE;
  return /^(relay acknowledgement timed out|Request timed out|Connection closed)/i.test(text) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(text)
    ? UNREACHED
    : text;
}

/**
 * A request bound to the computer the screen opened on: when the pair or generation changes while it is in flight, the answer is dropped
 * and the caller gets an error instead of data from another computer.
 */
export function ownedRequest(runtime: MobileRuntime, at: { selectedPair: string | null; generation: number } = runtime.snapshot()): Owned {
  const owned = async (method: string, params: Record<string, unknown> = {}) => {
    const now = () => runtime.snapshot();
    if (now().selectedPair !== at.selectedPair || now().generation !== at.generation) throw new Error(STALE);
    let result: unknown;
    try {
      result = await runtime.request(method, params);
    } catch (e) {
      // the original stays as the cause, so a screen can tell a request cut off in flight from one that never left
      throw new Error(explain(e), { cause: e });
    }
    if (now().selectedPair !== at.selectedPair || now().generation !== at.generation) throw new Error(STALE);
    return result;
  };
  return Object.assign(owned, { pair: at.selectedPair, generation: at.generation });
}
/** A request bound to one computer and connection; `pair` names the computer and `generation` the connection (absent on a request made outside `ownedRequest`). */
export type Owned = ((method: string, params?: Record<string, unknown>) => Promise<unknown>) & {
  readonly pair?: string | null;
  readonly generation?: number;
};

/** The methods this Mac advertises and its permission ceiling; null methods mean the Mac did not say, so a request is tried. */
const hellos = new WeakMap<Owned, Promise<Capabilities>>();
/** One machine.hello per connection: every screen that asks shares the first answer (a failed one is asked again). */
export function capabilities(request: Owned): Promise<Capabilities> {
  let hello = hellos.get(request);
  if (!hello) {
    hello = readCapabilities(request);
    hellos.set(request, hello);
    hello.catch(() => hellos.delete(request));
  }
  return hello;
}
async function readCapabilities(request: Owned): Promise<Capabilities> {
  const hello = rec(await request('machine.hello'));
  const caps = rec(hello?.capabilities);
  const methods = Array.isArray(caps?.methods) ? new Set(caps.methods.filter((m): m is string => typeof m === 'string')) : null;
  return {
    methods,
    ceiling: str(caps?.permissionCeiling) ?? 'auto-review',
    mirrors: typeof caps?.mirrors === 'boolean' ? caps.mirrors : null,
    renameChats: caps?.renameChats === true,
    archiveChats: caps?.archiveChats === true,
    olderRowsHeld: caps?.olderRowsHeld === true,
    sideChats: caps?.sideChats === true,
  };
}

/** Throws Unavailable when the Mac says it lacks the method. */
export function needs(caps: Capabilities | null, method: string, what: string) {
  if (caps?.methods && !caps.methods.has(method)) throw new Unavailable(`Update MoPilot on your computer to ${what} from your phone.`);
}

export async function loadStart(request: Owned): Promise<{ harnesses: Harness[]; projects: Project[]; caps: Capabilities }> {
  // a Mac that does not answer machine.hello is treated as unknown, and requests are tried
  const [caps, h, p] = await Promise.all([
    capabilities(request).catch(() => ({ methods: null, ceiling: 'auto-review' })),
    request('harnesses.list'),
    request('projects.list'),
  ]);
  const harnesses = list(rec(h)?.harnesses).flatMap((x) => {
    const r = rec(x);
    const id = str(r?.id);
    const detail = str(r?.detail);
    return id ? [{ id, label: str(r?.label) ?? id, ...(detail && { detail }) }] : [];
  });
  const projects = list(rec(p)?.projects).flatMap((x) => {
    const r = rec(x);
    const id = str(r?.id);
    const branch = str(r?.branch);
    return id ? [{ id, label: str(r?.name) ?? str(r?.label) ?? id, ...(branch && { branch }) }] : [];
  });
  return { harnesses, projects, caps };
}

/** The menus for a new chat on `harness`; a menu the Mac does not return stays empty, and the screen hides it. */
export async function loadOptions(request: Owned, harness: string, ceiling: string): Promise<Options> {
  return readOptions(await request('options.get', { harness }), ceiling);
}

/**
 * The menus an `options.get` reply holds, as a phone may use them: never full access, never above the Mac's ceiling.
 * `permissionLabel` names the current permission even when the phone may not set it, so a screen can say what it is.
 */
export function readOptions(reply: unknown, ceiling: string): Options {
  const r = rec(reply);
  if (!r) return bad('the options');
  const models = list(r.models).flatMap((x) => {
    const m = rec(x);
    const id = str(m?.id);
    if (!id) return [];
    const efforts = list(m?.efforts).flatMap((e) => {
      const eid = str(rec(e)?.id);
      return eid ? [{ id: eid, label: str(rec(e)?.label) ?? eid }] : [];
    });
    const description = str(m?.description);
    return [
      {
        id,
        // the model it resolves to, with its version, over the Mac's or Host's own label (never an alias)
        label: str(m?.resolvedModel) ?? str(m?.label) ?? id,
        ...(description && { description }),
        efforts,
        defaultEffort: str(m?.defaultEffort),
        ...(m?.more === true && { more: true }),
        ...(m?.autoMode === true && { autoMode: true }),
      },
    ];
  });
  const cap = ORDER.indexOf(ceiling);
  const permission = rec(r.permission);
  const current = str(permission?.value);
  let permissionLabel: string | null = null;
  const macOnly: string[] = [];
  const permissions = list(permission?.rows).flatMap((x) => {
    const row = rec(x);
    const id = str(row?.id);
    if (id && id === current) permissionLabel = str(row?.label) ?? id;
    if (!id) return [];
    // an id outside the Mac's own order is a harness mode; the Mac refuses what it cannot cap, so it is not offered
    const at = ORDER.indexOf(id);
    if (id === NEVER || at > cap) macOnly.push(str(row?.label) ?? id);
    if (id === NEVER || at < 0 || at > cap) return [];
    const disabled = str(row?.disabled);
    return [{ id, label: str(row?.label) ?? id, detail: str(row?.detail) ?? '', ...(disabled ? { disabled } : {}) }];
  });
  const accounts = list(r.accounts).flatMap((x) => {
    const a = rec(x);
    const id = str(a?.id);
    return id
      ? [
          {
            id,
            label: str(a?.label) ?? id,
            ...(a?.loggedIn === false && { signedOut: true }),
            ...(a?.limited === true && { limited: true }),
          },
        ]
      : [];
  });
  return {
    models,
    accounts,
    model: str(r.model),
    effort: str(r.effort),
    permissions,
    permission: permissions.some((p) => p.id === current) ? current : null,
    permissionLabel: current ? (permissionLabel ?? current) : null,
    macOnly,
    ...(rec(r.account) && {
      account: { id: str(rec(r.account)?.id), pinned: rec(r.account)?.pinned === true, serving: str(rec(r.account)?.serving) },
    }),
    ...(typeof r.perChat === 'boolean' && { perChat: r.perChat }),
  };
}

export type StartInput = {
  harness: string;
  text: string;
  projectId: string | null;
  model: string | null;
  effort: string | null;
  permission: string | null;
  account: string | null;
  worktree: boolean;
  /** A machine chat only: where its model access comes from (the Host enforces it; left out, the Host's own order applies) */
  credential?: { source: 'own' | 'key' | 'org'; login?: string };
  /** Same id for the same picks: the Mac starts one chat however many times it is sent. */
  startId: string;
  attachments: string[];
  /** Skills picked from the / menu, carried beside the text (this Mac only). */
  skills?: string[];
  /** Another machine the Mac runs chats on (a Host), and the folder there; absent for this Mac. */
  hostId?: string | null;
  folder?: string | null;
};

/** Starts a chat and returns its id; the caller opens it like any other chat. */
export async function startChat(request: Owned, input: StartInput): Promise<{ chatId: string; warning: string | null }> {
  const { permission, projectId, model, effort, account, worktree, hostId, folder, credential, ...rest } = input;
  // on another machine the chat runs in a folder there: no project, worktree or account of this Mac's goes with it
  const remote = !!hostId && hostId !== 'local';
  const r = rec(
    await request('chat.start', {
      ...rest,
      deadline: Date.now() + 30000,
      ...(remote ? { hostId, folder, ...(credential ? { credential } : {}) } : {}),
      ...(projectId && !remote ? { projectId } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(permission ? { permission } : {}),
      ...(account && !remote ? { account } : {}),
      ...(worktree && projectId && !remote ? { worktree: true } : {}),
    }),
  );
  // a start the Mac made but could not set up fully (its permission on a machine) says so; the chat exists either way
  return { chatId: str(r?.chatId) ?? bad('the new chat'), warning: str(r?.warning) };
}

/** A dictated clip sent to the Mac's engine in chunks; the text comes back for editing before it is sent. */
export async function transcribe(
  request: Owned,
  audio: { base64: string; mime: 'audio/wav' | 'audio/webm' },
  caps: Capabilities | null,
  signal: AbortSignal,
  /** The Mac's method that reads the recording: the coding chat's, or MoMo's own (momo.chat.transcribe). */
  method = 'chat.transcribe',
) {
  needs(caps, method, 'dictate');
  const { stream } = await sendChunks(
    request,
    { name: 'voice note', mime: audio.mime, base64: audio.base64 },
    'audio',
    () => undefined,
    signal,
  );
  const r = rec(await cancellable(request(method, { stream, mime: audio.mime }), signal));
  const text = typeof r?.text === 'string' ? r.text.trim() : bad('the transcript');
  if (!text) throw new Error('No speech was heard. Try again closer to the microphone.');
  return { text, saveError: str(r?.saveError) };
}
