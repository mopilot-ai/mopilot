// Linked-session configuration inherits the parent's adapter settings, while shared notes have one private directory per family.
const { fs: fsPort } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { cheaperModel } = require('../userWords.cjs');
const { familyOf, byFamily } = require('../contract/route.cjs');
const { appPermission } = require('../linkedPlan.cjs');
const { inheritedPermission } = require('../../harness/acp/inheritedPermission.cjs');
const { acpPlanOn } = require('../controllerEvents.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSIONS = ['plan', 'read-only', 'default', 'auto-review', 'full-access'];
/** The source adapter owns its settings; basic native model/effort selection has no portable contract. */
const SETTINGS = {
  claude: (live, _prefs, id) => live.claudeTurns.settings(id, {}),
  codex: (live, prefs, id) => ({ ...prefs, ...live.chats.records.get(id)?.meta?.config }),
  acp: (live, _prefs, id) => {
    const permission = inheritedPermission(live.controller.state?.get(id));
    return { ...live.chats.records.get(id)?.meta?.config, permission, planBasePermission: permission };
  },
};
const NATIVE_SELECTION = { codex: true, claude: true, acp: false };
const reportedPermission = (own, state) => (state.plan ? 'plan' : (appPermission(state.permission) ?? own.permission));
const CURRENT_PERMISSION = {
  codex: reportedPermission,
  claude: reportedPermission,
  acp: (own, state, live, kind) => (acpPlanOn(state.acp, live.controller.acpPlan?.(kind)) ? 'plan' : own.permission),
};

/** Never raises a setting whose relative cost or permission order is unknown. */
function boundedSettings(own, requested, sameFamily = true) {
  const ignored = [];
  let model = sameFamily ? (own.model ?? null) : null;
  let effort = sameFamily ? (own.effort ?? null) : null;
  const permission = own.permission ?? 'default';
  if (requested.model) {
    if (requested.userSelected || (sameFamily && (requested.model === model || cheaperModel(requested.model, model))))
      model = requested.model;
    else
      ignored.push(`Model "${requested.model}" was ignored: its cost is not known to be at or below the parent's model on this harness.`);
  }
  if (requested.effort) {
    const level = EFFORTS.indexOf(requested.effort);
    if (level >= 0 && (requested.userSelected || (sameFamily && level <= EFFORTS.indexOf(effort)))) effort = requested.effort;
    else ignored.push(`Effort "${requested.effort}" was ignored: it is not known to be at or below the parent's effort on this harness.`);
  }
  let mode = permission;
  if (requested.permission) {
    const rank = PERMISSIONS.indexOf(requested.permission);
    if (rank < 0 || rank > PERMISSIONS.indexOf(permission))
      throw new Error('A linked session cannot start with higher permissions than its parent');
    mode = requested.permission;
  }
  return { model, effort, permission: mode, ignored };
}

/** Main's adapter settings work with no chat window; an incompatible harness keeps its own native model default. */
function createChildOptions({ live, prefs }) {
  return async (parentId, kind, args) => {
    const p = prefs() || {};
    const parentKind = live.controller.ref(parentId).kind;
    const family = familyOf(parentKind);
    let own = byFamily(SETTINGS, parentKind)(live, p, parentId);
    const planBasePermission =
      own.planBasePermission ?? own.basePermission ?? (own.permission !== 'plan' ? own.permission : null) ?? 'default';
    const state = live.controller.state?.get(parentId);
    if (state) own = { ...own, permission: byFamily(CURRENT_PERMISSION, parentKind)(own, state, live, parentKind) };
    const same = family === familyOf(kind);
    const result = boundedSettings(own, args, same);
    if (!byFamily(NATIVE_SELECTION, kind)) {
      result.ignored.push(
        'This harness cannot automatically grant inherited or shared notes directories; accessing them may require native approval in current and future turns.',
      );
      if (args.model || args.effort || result.model || result.effort)
        result.ignored.push('This harness has no portable model or effort selector; the linked session uses its native defaults.');
      result.model = null;
      result.effort = null;
    }
    return {
      ...result,
      ...(result.permission === 'plan' ? { planBasePermission } : {}),
      ...(same && own.account ? { account: own.account } : {}),
      ...(Array.isArray(own.additionalDirectories) ? { additionalDirectories: [...own.additionalDirectories] } : {}),
    };
  };
}

/** Family identities are encoded as one filename component, so even a native id containing separators stays private. */
function createSharedNotes(directory, io = fsPort.promises) {
  const pending = new Map();
  // Creation and final retirement of one family's notes are ordered; unrelated families remain independent.
  const run = (rootId, action) => {
    const before = pending.get(rootId) ?? Promise.resolve();
    const next = before.then(action, action);
    pending.set(rootId, next);
    return next.finally(() => {
      if (pending.get(rootId) === next) pending.delete(rootId);
    });
  };
  const folder = (rootId) => {
    if (typeof rootId !== 'string' || !rootId) throw new Error('A notes directory needs a family identity');
    return path.join(directory, 'side-session-notes', Buffer.from(rootId).toString('base64url'));
  };
  return {
    directory: folder,
    prepare(rootId) {
      return run(rootId, async () => {
        const dir = folder(rootId);
        await io.mkdir(dir, { recursive: true, mode: 0o700 });
        return { path: dir, additionalDirectories: [dir] };
      });
    },
    // The journal owner calls this only after the last attached or detached reference has retired.
    cleanup(rootId, when = () => true) {
      return run(rootId, async () => {
        const dir = folder(rootId);
        if (!when()) return false;
        await io.rm(dir, { recursive: true, force: true });
        return true;
      });
    },
  };
}

/** Detached sessions retain their notes reference; deleting or archiving only the parent cannot remove it. */
async function cleanupSharedNotes(orch, rootId) {
  if (!rootId || !orch.o.cleanupNotes) return false;
  const live = (id) => orch.o.chats.records.has(id) && !orch.o.chats.isDeleted?.(id) && !orch.deleted?.has(id) && !orch.archived(id);
  const directory = orch.o.notesDirectory?.(rootId);
  const references = (settings) =>
    !!directory && Array.isArray(settings?.additionalDirectories) && settings.additionalDirectories.includes(directory);
  const unreferenced = () =>
    !live(rootId) &&
    !(orch.starting?.get(rootId) > 0) &&
    !Object.entries(orch.journal.data.children).some(
      ([id, child]) => (child.notesRoot === rootId || references(child.settings)) && (live(id) || orch.starting?.get(id) > 0),
    ) &&
    ![...orch.o.chats.records].some(([id, record]) => live(id) && references(record.meta?.config));
  if (!unreferenced()) return false;
  // The callback is checked again by the directory owner after earlier queued filesystem work settles.
  const retire = () => {
    if (!unreferenced()) return false;
    // Terminal deletion forbids metadata writes or restoration; only restorable records need grant revocation.
    for (const [id, record] of orch.o.chats.records)
      if (orch.o.chats.isDeleted?.(id) !== true && !live(id) && references(record.meta?.config)) {
        const config = record.meta.config;
        if (
          // patchMeta-changes: only a config that still references the directory is patched, so it changes
          !orch.o.chats.patchMeta(id, {
            config: { ...config, additionalDirectories: config.additionalDirectories.filter((dir) => dir !== directory) },
          })
        )
          return false;
      }
    if (Object.values(orch.journal.data.children).some((child) => references(child.settings)))
      orch.journal.change((data) => {
        for (const child of Object.values(data.children))
          if (references(child.settings))
            child.settings.additionalDirectories = child.settings.additionalDirectories.filter((dir) => dir !== directory);
      });
    return true;
  };
  return Promise.resolve()
    .then(() => orch.o.cleanupNotes(rootId, retire))
    .catch((error) => {
      noteIgnored('clean retired linked-session notes', error);
      return false;
    });
}

module.exports = { EFFORTS, PERMISSIONS, boundedSettings, createChildOptions, createSharedNotes, cleanupSharedNotes };
