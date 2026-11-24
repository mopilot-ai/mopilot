// The Host's policy resolver (plan U2): the owner layer a desktop client sends, kept in the data dir, merged with a managed layer (W2 supplies it) into the effective policy the Host enforces and reports.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_POLICY, ceilingFor, mergePolicy, parseOwnerPolicy, policyGeneration, withinCeiling } from '../../shared/host/policy.mjs';
import { SchemaError } from '../../shared/host/schema.mjs';
import { harnessAllowed, hostLayerOf } from '../../shared/host/managedLayer.mjs';
import { HostRefusal } from './hostFs.mjs';

const FILE = 'policy.json';
/** What a Host with no audit record does: nothing. */
const NO_AUDIT = { governed: () => true, note: () => undefined };
/** The line each governed request leaves, by method. */
const GOVERNED = /** @type {Record<string, string>} */ ({
  'chat.start': 'chat.started',
  'chat.send': 'chat.message',
  'chat.permit': 'permission.set',
});
const NAMES = /** @type {Record<string, string>} */ ({
  plan: 'Plan',
  'read-only': 'Read-only',
  default: 'Default',
  'auto-review': 'Auto-review',
  'full-access': 'Full access',
});

/**
 * @param {object} o
 * @param {string} [o.dataDir] where the owner document is kept; without one the policy lasts for this run only
 * @param {(m: string) => void} [o.report]
 * @param {() => void} [o.onChange] told after a new owner document is kept (what a limit or ceiling held may now go)
 * @param {() => any} [o.managed] a managed layer in `mergePolicy`'s shape, or null for a person
 * @param {{ effectivePolicy: () => { state: string, doc: any, organization: string | null, problem: string | null } }} [o.managedFile] the root-owned policy file's reader (./managedPolicyFile.mjs); a valid or fallback document is the managed layer
 * @param {{ governed: (e: any) => boolean, note: (e: any) => void }} [o.audit] the audit record (./audit.mjs): a governed request is written before it runs, a refusal is noted
 * @param {(harness: string) => boolean} [o.hasOrgLease] whether a harness holds an organization lease now (`hosts.credentials.orgOnly` refuses a chat without one)
 * @param {Pick<typeof fs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync'>} [o.io]
 */
export function createPolicy({
  dataDir,
  onChange = () => undefined,
  report = () => undefined,
  managed = () => null,
  managedFile,
  hasOrgLease = () => false,
  audit = NO_AUDIT,
  io = fs,
} = {}) {
  const file = dataDir ? path.join(dataDir, FILE) : null;
  /** The last owner document this Host accepted; a corrupt or absent file leaves the defaults. */
  let owner = parseOwnerPolicy({ version: DEFAULT_POLICY.version }, (m) => new SchemaError(m));
  /** Why the stored document was not used, for the status. @type {string | null} */
  let problem = null;
  if (file) {
    try {
      owner = parseOwnerPolicy(JSON.parse(String(io.readFileSync(file, 'utf8'))), (m) => new SchemaError(m));
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT') {
        problem = 'The stored policy could not be read, so the defaults apply.';
        report(`policy: ${problem} (${/** @type {Error} */ (error).message})`);
      }
    }
  }
  /** The managed document in force: a file's (or its strict fallback), null for a person. */
  const managedDoc = () => {
    const s = managedFile?.effectivePolicy();
    return s && s.state !== 'none' ? s.doc : null;
  };
  const layer = () => {
    const doc = managedDoc();
    return doc ? hostLayerOf(doc) : managed();
  };
  const effective = () => mergePolicy(owner, layer());
  /** The modes this process let through per chat, so a card answered after the ceiling dropped is re-checked. @type {Map<string, string>} */
  const modes = new Map();
  /** Keys only the managed file decides (no owner value to merge). */
  const lockedByFile = () => {
    const d = managedDoc();
    if (!d) return [];
    return [
      d.harnesses?.allow && 'harnesses.allow',
      d.hosts?.clients?.phone !== undefined && 'hosts.clients.phone',
      d.hosts?.clients?.home !== undefined && 'hosts.clients.home',
      d.hosts?.credentials?.orgOnly !== undefined && 'hosts.credentials.orgOnly',
      d.hosts?.roots && 'hosts.roots',
      d.audit && 'audit',
    ].filter(Boolean);
  };
  const refuse = (/** @type {string} */ key, /** @type {string} */ message) => new HostRefusal('policy_refused', message, { key });
  return {
    /** The permission mode a chat was last set to by anyone (its start or a later `chat.permit`), or none. @param {string} chatId */
    modeOf: (chatId) => modes.get(chatId),
    /** The document the Host enforces now, and the keys the managed layer decides. */
    effective,
    /** Replaces the owner layer with an accepted document; writes are applied in the order they arrive, so the later document is the one that stays. @param {any} doc @returns {{ generation: string }} */
    set(doc) {
      if (file) {
        io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        io.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
        io.renameSync(tmp, file);
      }
      owner = doc;
      problem = null;
      onChange();
      return { generation: policyGeneration(effective().doc) };
    },
    /** The `policy` block of `host.status`. */
    status() {
      const { doc, locked } = effective();
      const file = managedFile?.effectivePolicy();
      const why = problem ?? file?.problem ?? null;
      return {
        generation: policyGeneration(doc),
        managed: !!layer(),
        ...(file?.organization ? { organization: file.organization } : {}),
        locked: [...locked, ...lockedByFile()],
        ...(why ? { problem: why } : {}),
      };
    },
    /** The most trusting permission mode the rules allow now (the owner's and the organization's, the stricter): read by the chat families at every turn. */
    ceiling: () => effective().doc.permissionMax,
    /**
     * Refuses a permission mode above what this kind of client may set (the ceiling, and the phone's own cap).
     * @param {string} mode @param {string} kind `desktop`, `phone` or `cli`
     */
    checkMode(mode, kind) {
      const max = ceilingFor(effective().doc.permissionMax, kind);
      if (withinCeiling(mode, max)) return;
      throw new HostRefusal(
        'policy_refused',
        `${NAMES[mode] ?? mode} is not allowed on this machine. The most it allows is ${NAMES[max]}.`,
        { key: 'permissionMax', max },
      );
    },
    /**
     * Checks a request against the rules before it runs (a mode above the ceiling never reaches the harness), then writes its audit line: with `audit.required` a line that cannot be written refuses it. A refusal is noted too.
     * @param {string} method @param {any} params @param {string} kind @param {{ fingerprint?: string, name?: string, kind?: string } | null} [who]
     */
    checkRequest(method, params, kind, who = null) {
      const line = { chat: params.chatId, harness: params.harness, by: who ?? { kind } };
      try {
        this.rules(method, params, kind);
      } catch (error) {
        const e = /** @type {any} */ (error);
        audit.note({
          ...line,
          kind: GOVERNED[method] ?? 'permission.set',
          what: { decision: 'refused', code: e.code, key: e.details?.key },
        });
        throw error;
      }
      if (!GOVERNED[method]) return;
      audit.governed({ ...line, kind: GOVERNED[method], what: { mode: params.permission ?? params.value } });
      if (method === 'chat.start' && params.permission)
        audit.governed({ ...line, kind: 'permission.set', what: { mode: params.permission } });
    },
    /** The rules themselves, with no record kept. @param {string} method @param {any} params @param {string} kind */
    rules(method, params, kind) {
      const doc = managedDoc();
      if (method === 'chat.start') {
        if (doc) this.checkHarness(params.harness);
        if (params.permission) this.checkMode(params.permission, kind);
        // the mode Plan runs its tools under is a mode like any other
        if (params.planBase && params.permission === 'plan') this.checkMode(params.planBase, kind);
        if (doc?.hosts?.credentials?.orgOnly && !hasOrgLease(params.harness))
          throw refuse('hosts.credentials.orgOnly', 'Organization sign-in required.');
        if (params.permission && params.chatId) modes.set(params.chatId, params.permission);
      }
      if (method === 'chat.permit') {
        this.checkMode(params.value, kind);
        modes.set(params.chatId, params.value);
      }
      // a message to a chat whose mode was set above a ceiling that has dropped since is refused when the agent keeps its own mode (an ACP one, `acp:<agent>:<id>`), which the Host cannot clamp; Claude Code and Codex turns are clamped to the ceiling by their families instead
      if (method === 'chat.send' && String(params.chatId).startsWith('acp:') && modes.has(params.chatId))
        this.checkMode(/** @type {string} */ (modes.get(params.chatId)), 'desktop');
      // a card answered after the ceiling dropped: the chat's mode is checked again before the answer runs
      if (method === 'chat.answer' && modes.has(params.chatId)) this.checkMode(/** @type {string} */ (modes.get(params.chatId)), kind);
      if (method === 'host.clientAdd' && params.kind === 'home' && doc?.hosts?.clients?.home === false)
        throw refuse('hosts.clients.home', 'Your organization does not allow MoMo to use this machine.');
      if (method === 'host.clientAdd' && params.kind === 'phone' && doc?.hosts?.clients?.phone === false)
        throw refuse('hosts.clients.phone', 'Your organization does not allow a phone on this machine.');
      if (method === 'host.modelKey' && params.key !== null && doc?.hosts?.credentials?.orgOnly)
        throw refuse('hosts.credentials.orgOnly', 'Organization sign-in required.');
    },
    /**
     * Whether managed policy lets this Host have a client of this kind: the code-pair service asks before it offers a code and again before it adds a controller (it never goes through `host.clientAdd`). `false` is a switch an organization turned off; absent is allowed.
     * @param {'phone' | 'controller'} kind
     */
    allowsClient: (kind) => managedDoc()?.hosts?.clients?.[kind] !== false,
    /** A scheduled run starts through the same rules as `chat.start`; it runs on the machine's own login, which `orgOnly` forbids. @param {{ harness: string, permission?: string }} p */
    checkScheduled(p) {
      this.rules('chat.start', { harness: p.harness, permission: p.permission }, 'cli');
      if (managedDoc()?.hosts?.credentials?.orgOnly) throw refuse('hosts.credentials.orgOnly', 'Organization sign-in required.');
      audit.governed({ kind: 'chat.started', harness: p.harness, by: { kind: 'cli' }, what: { kind: 'schedule' } });
    },
    /** @param {string} harness */
    checkHarness(harness) {
      if (harnessAllowed(managedDoc(), harness)) return;
      throw refuse('harnesses.allow', 'Your organization does not allow that agent on this machine.');
    },
    /** The folders a managed policy confines this Host to, or undefined for the Host's own choice. */
    roots: () => managedDoc()?.hosts?.roots,
    /** `host.policy`: only a desktop or CLI client may replace the owner layer. @param {any} params @param {string} kind */
    replace(params, kind) {
      // only a computer of the owner's own: a phone or a Mac paired by a code (a controller) may not
      if (kind !== 'desktop' && kind !== 'cli')
        throw new HostRefusal('policy_refused', 'Change this from the app on a computer.', { key: 'caller', kind });
      const done = this.set(params.doc);
      audit.note({ kind: 'policy.changed', by: { kind }, what: { generation: done.generation } });
      return done;
    },
    /** The audit record's settings: only the managed layer sets them, so the owner cannot lower them. */
    auditSettings: () => managedDoc()?.audit ?? {},
    /** The effective generation, which each audit line names. */
    generation: () => policyGeneration(effective().doc),
    /** What the approval engine (U1) reads: the approval timings and the notification settings. */
    approvalSettings() {
      const { approvals, notify } = effective().doc;
      return { approvals, notify };
    },
  };
}
