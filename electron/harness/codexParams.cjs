// What a Codex turn runs with: permission and sandbox params, the message as app-server input, and a chat's own prefs.
const { userInput } = require('../../shared/userInput.mjs');
const { withAttachedFiles } = require('../../shared/attachedFiles.mjs');
const { historyContext, HISTORY_CONTEXT_KEY } = require('../../shared/computerHistory.mjs');
const { isMomoBlock, MOMO_CONTEXT_KEY } = require('../../shared/momoContext.mjs');
const { effectiveModel } = require('../../shared/modelChoice.mjs');

function permissionParams(mode) {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' };
    case 'auto-review':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' };
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
  }
}
function sandboxPolicyFor(mode, cwd) {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'full-access':
      return { type: 'dangerFullAccess' };
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: cwd ? [cwd] : [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}

/**
 * A message as app-server UserInput items; a referenced Chrome tab becomes the Browser plugin's tab mention.
 * Codex does not read a `mention` item as content (it is for apps and plugins), so a file or folder a Host staged for the
 * message (`staged`, host/src/chatEffects.mjs) is also named by its path in a hidden block ahead of the text
 * (shared/attachedFiles.mjs; the thread strips it, shared/userText.mjs). This Mac's own attachments are unchanged.
 */
function buildInput(text, attachments = []) {
  const input = userInput(text, attachments, { tabsFor: 'codex-browser-plugin' });
  const paths = attachments
    .filter((a) => a.kind === 'file' && a.staged === true && typeof a.path === 'string' && a.path)
    .map((a) => a.path);
  if (!paths.length) return input;
  const at = input.findIndex((i) => i.type === 'text');
  if (at < 0) return [{ type: 'text', text: withAttachedFiles('', paths), text_elements: [] }, ...input];
  return input.map((i, n) => (n === at ? { ...i, text: withAttachedFiles(String(i.text), paths) } : i));
}

/**
 * The memories the user shared with a message, as the turn's untrusted additionalContext (kept out of the message the
 * thread shows and records), or nothing.
 * @param {any[]} [attachments]
 * @returns {{ additionalContext?: Record<string, { kind: 'untrusted', value: string }> }}
 */
function historyParams(attachments = []) {
  const value = historyContext(attachments);
  return value ? { additionalContext: { [HISTORY_CONTEXT_KEY]: { kind: 'untrusted', value } } } : {};
}

/**
 * turn/start params with MoMo's memory (electron/momo/contract/context.cjs) in the turn's untrusted additionalContext, beside
 * any shared memories; the params as they were without a block.
 * @template {{ additionalContext?: Record<string, { kind: 'untrusted', value: string }> }} P
 * @param {P} params
 * @param {string | null} block
 * @returns {P}
 */
function withMomoParams(params, block) {
  if (!isMomoBlock(block)) return params;
  return {
    ...params,
    additionalContext: { ...params.additionalContext, [MOMO_CONTEXT_KEY]: { kind: 'untrusted', value: /** @type {string} */ (block) } },
  };
}

/**
 * What a chat's turn runs with: its approval policy, reviewer and sandbox, as turn/start and thread/settings/update take
 * them. `opts` are a message's own picks, which win over `prefs`; Plan runs on the permission it was entered from.
 * @param {any} prefs @param {string | null | undefined} cwd @param {any} [opts]
 */
function permissionSettings(prefs, cwd, opts = {}) {
  const requestedPermission = opts.permission ?? prefs.permission;
  const permission = requestedPermission === 'plan' ? (prefs.planBasePermission ?? 'default') : requestedPermission;
  const additionalDirectories = opts.additionalDirectories ?? prefs.additionalDirectories;
  const perm = permissionParams(permission);
  return {
    approvalPolicy: perm.approvalPolicy,
    approvalsReviewer: perm.approvalsReviewer,
    sandboxPolicy: {
      ...sandboxPolicyFor(permission, cwd),
      ...(permission !== 'read-only' && permission !== 'full-access' && additionalDirectories
        ? { writableRoots: [...new Set([...(cwd ? [cwd] : []), ...additionalDirectories])] }
        : {}),
    },
  };
}

/** What permissionSettings reads from a chat's config or the prefs, as a key that changes when its result can. */
const permissionKey = (source) =>
  JSON.stringify([source?.permission ?? null, source?.planBasePermission ?? null, source?.additionalDirectories ?? null]);

/** The same model choice for explicit turns and native runs on a thread's own settings. */
function modelSettings(prefs, opts = {}, defaults = {}) {
  const requestedPermission = opts.permission ?? prefs.permission;
  const model = effectiveModel(opts.model ?? prefs.model, defaults.defaultModel, defaults.model);
  const effort = opts.effort ?? prefs.effort;
  return {
    model,
    effort,
    serviceTier: prefs.serviceTier,
    // the mode is the thread's until changed, so every turn says which one it is (D-13)
    collaborationMode: {
      mode: opts.plan || requestedPermission === 'plan' ? 'plan' : 'default',
      settings: {
        model: model ?? '',
        reasoning_effort: effort ?? defaults.effort ?? null,
        developer_instructions: null,
      },
    },
  };
}

/** A queued message as turn/start params; Automatic uses the current native recommendation. */
function turnParams(threadId, clientId, item, prefs, cwd, defaults = {}) {
  const opts = item.opts || {};
  return {
    threadId,
    clientUserMessageId: clientId,
    input: buildInput(opts.prefix ? `${opts.prefix}\n\n${item.text}` : item.text, item.attachments || []),
    ...historyParams(item.attachments || []),
    ...modelSettings(prefs, opts, defaults),
    ...permissionSettings(prefs, cwd, opts),
  };
}

/**
 * The prefs a chat's turn uses: its own model, effort and service tier where it set them (a key
 * that is there, even null, wins), the user's defaults for the rest. Two chats never share them (D-29).
 */
function chatPrefs(prefs, config) {
  const out = { ...prefs };
  if (config && typeof config === 'object')
    for (const k of ['model', 'effort', 'serviceTier', 'permission', 'planBasePermission', 'additionalDirectories'])
      if (k in config) out[k] = config[k] ?? null;
  return out;
}

module.exports = {
  permissionParams,
  permissionSettings,
  permissionKey,
  modelSettings,
  sandboxPolicyFor,
  buildInput,
  turnParams,
  chatPrefs,
  historyParams,
  withMomoParams,
};
