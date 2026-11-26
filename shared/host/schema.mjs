// Input validation and version gates for the Host control channel and session stream (docs: design/host/index.html, package 2.3): one parser per method, shared by the Mac app and the Host so the two cannot drift.
import { HISTORY_FEATURE, HISTORY_METHODS, historyParsers } from './history.mjs';
import { chatInputNeeds, chatInputParsers } from './chatInputs.mjs';
import { CARRY_BRANCH } from './codeCarry.mjs';
import { SchemaError, chatOf, optionOf } from '../remote/schema.mjs';
import { BROWSER_METHODS, browserParsers } from './browser.mjs';
import { DESKTOP_METHODS, desktopParsers } from './desktop.mjs';
import { TOOL_METHODS, toolParsers } from './toolRelay.mjs';
import { KEYED, isKey } from './credentials.mjs';
import { SWITCH_FEATURE } from './chatSwitch.mjs';
import { CONTINUE_FAMILIES_FEATURE } from './continue.mjs';
import { ORG_FEATURE, leaseOf } from './orgAccess.mjs';
import { cloneCredentialOf, signInHostsOf } from './gitSignInParams.mjs';
import { GIT_SIGNIN_FEATURE, gitLoginNeeds } from './gitLogin.mjs';
import { SCHEDULES_FEATURE, scheduleParsers } from './hostSchedules.mjs';
import { STREAM2_FEATURE } from './stream2.mjs';
import { READ_FEATURE, READ_METHODS, readParsers } from './readSchema.mjs';
import { IMAGE_FEATURE, CHAT_IMAGE_FEATURE, IMAGE_METHODS, imageParsers } from './images.mjs';
import { FILE_FEATURE } from './files.mjs';
import { formAnswerOf } from './formAnswer.mjs';
import { codeFilesIn, collectMethodFiles } from './methodFiles.mjs';
import { optionalName } from './clients.mjs';
import { POLICY_FEATURE, POLICY_METHODS, policyParsers } from './policy.mjs';
import { SPEND_FEATURE } from './spend.mjs';
import { APPROVALS_FEATURE, APPROVAL_METHODS, approvalParsers } from './approvals.mjs';
import { PROTOCOL, GateError, negotiate } from './protocol.mjs';
import { LOGINS_FEATURE } from './logins.mjs';
import { worktreeNeeds, worktreeParser } from './gitBranch.mjs';
import { SIDE_CHAT_FEATURE } from './sideChats.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { SchemaError, READ_FEATURE, PROTOCOL, GateError, negotiate };

/** A clone that carries the app's sign-in for one repository host: an older Host would drop the field and clone without it, so such a Host is refused (requireFeatures). */
export const CLONE_CREDENTIAL_FEATURE = 'cloneCredential';

/**
 * A chat of a harness family other than ACP puts its events on the stream tagged with that family (`codex`, `claude`); an end without this feature reads every
 * event as ACP's, so it is refused such a chat rather than served one it would misread.
 */
export const FAMILY_FEATURE = 'family';
/** The one family an end reads without the `family` feature: its events carry no tag, so they are ACP's. A wire-version rule, not a harness behavior. */
export const UNTAGGED_FAMILY = 'acp';
const bad = (/** @type {string} */ message) => new SchemaError(message);

/** An id a client mints for one side effect; the Host dedupes on it. */
/** How many new files one carry can name. */
const MAX_CARRY_PATHS = 2000;
const KEY = /^[\w.:-]{8,128}$/;
/** The name of a Host stream's numbering (host/src/stream.mjs). */
const GENERATION = /^[\w.:-]{1,128}$/;
const FEATURE = /^[a-z][\w.-]{0,63}$/;
const MAX_FEATURES = 64;
const MAX_PATH = 4096;
const MAX_URL = 2048;
const HARNESS = /^(codex|claude|acp:[\w.-]{1,64})$/;
/** A harness the Host signs in to: the id the Host's own status lists it under (an ACP harness a person defined has no prefix). */
const LOGIN_HARNESS = /^[\w.:-]{1,64}$/;
/** One of the sign-in methods the harness listed. */
const LOGIN_METHOD = /^[\w.:-]{1,128}$/;
/** A Host's id in the registry: `ssh:` and the destination the machine was added with (`user@host`, `user@[::1]`, a port after a colon). */
const HOST_ID = /^[\w.:@%[\]-]{1,128}$/;
/** The handoff a new native session opens with: bounded well under one frame. */
const MAX_HANDOFF = 4 * 1024 * 1024;
const MAX_MOVED = 256;

/** @param {unknown} v @param {RegExp} re @param {string} message */
function matchOf(v, re, message) {
  if (typeof v !== 'string' || !re.test(v)) throw bad(message);
  return v;
}
/** A harness a chat runs on. */
function harnessOf(/** @type {unknown} */ v) {
  const harness = String(v ?? '');
  if (!HARNESS.test(harness)) throw bad('Pick a harness for the new chat.');
  return harness;
}

/** The harness a sign-in request names. */
function loginHarnessOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !LOGIN_HARNESS.test(v)) throw bad('Pick a harness to sign in to.');
  return v;
}

/** The agent an install request names: an id the Host's own status lists, like a sign-in's. */
function installHarnessOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !LOGIN_HARNESS.test(v)) throw bad('Pick an agent to install.');
  return v;
}

const isCount = (/** @type {unknown} */ n) => Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0;

/** The epoch a chat request carries; a request with none is refused (it could not be told from a stale owner's). */
export function epochOf(/** @type {any} */ p) {
  if (!isCount(p.epoch)) throw bad('That request has no owner epoch.');
  return /** @type {number} */ (p.epoch);
}
/** The idempotency key of a request that changes something. */
export function keyOf(/** @type {any} */ p) {
  if (typeof p.key !== 'string' || !KEY.test(p.key)) throw bad('That request has no valid key.');
  return p.key;
}
/** `{ chatId, epoch }`: what every chat-scoped request names. */
const scoped = (/** @type {any} */ p) => ({ chatId: chatOf(p), epoch: epochOf(p) });
/** A side-effecting chat request: scope and key. */
const effect = (/** @type {any} */ p) => ({ ...scoped(p), key: keyOf(p) });
/** A path a request names: non-empty, no NUL, bounded. */
function pathOf(/** @type {unknown} */ v, /** @type {string} */ what) {
  if (typeof v !== 'string' || !v || v.length > MAX_PATH || v.includes('\0')) throw bad(`Pick ${what}.`);
  return v;
}
/** A repository address: https, ssh or scp-style, as a host (letters, digits, dots, dashes; never starting with a dash, which ssh would read as an option) and a path. https carries no user info (`user:token@`: a token in an address ends in `.git/config` and the process list), ssh may name a plain user. @param {unknown} v */
function repoOf(v) {
  const HOST = '[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?';
  const ok =
    typeof v === 'string' &&
    v.length <= MAX_URL &&
    !/[\s\u0000-\u001f]/.test(v) &&
    (new RegExp(`^https://${HOST}(?::\\d{1,5})?/`).test(v) ||
      new RegExp(`^ssh://(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?${HOST}(?::\\d{1,5})?/`).test(v) ||
      new RegExp(`^git@${HOST}:`).test(v));
  if (!ok) throw bad('That repository address is not one Git can clone.');
  return /** @type {string} */ (v);
}
/** A branch name: bounded, no control byte or space, and not shaped like an option (git checks the rest). */
function branchOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !v || v.length > 255 || /[\s\u0000-\u001f]/.test(v) || v.startsWith('-')) throw bad('Pick a branch name.');
  return v;
}
/** The temporary branch of a carry, and nothing else: a request cannot make the Host fetch or delete any other branch. */
function carryBranchOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !CARRY_BRANCH.test(v) || v.endsWith('.') || v.endsWith('.lock')) throw bad('That is not a carry branch.');
  return v;
}
/** The list of new files a user confirmed for a carry: none when absent, bounded. */
function pathsOf(/** @type {unknown} */ v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_CARRY_PATHS) throw bad('That list of files is not one.');
  return v.map((f) => pathOf(f, 'a file'));
}
/** How many unpushed commits the user agreed to publish with a carry: none when absent. */
function unpushedOf(/** @type {unknown} */ v) {
  if (v == null) return 0;
  if (!Number.isSafeInteger(v) || /** @type {number} */ (v) < 0) throw bad('That is not a number of commits.');
  return /** @type {number} */ (v);
}
/** A full commit id. */
function shaOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v)) throw bad('That is not a commit.');
  return v;
}
/** The id of a Host a continue names (itself a Host's registry id). */
function hostIdOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !HOST_ID.test(v)) throw bad('Pick a host to continue on.');
  return v;
}
/** The id a target Host gave a preparation; it has the shape of a key. */
function preparedIdOf(/** @type {any} */ p) {
  if (typeof p.preparedId !== 'string' || !KEY.test(p.preparedId)) throw bad('That continue has no valid preparation.');
  return p.preparedId;
}
/** The handoff a continue opens its new session with: text, never empty, bounded. */
function handoffOf(/** @type {unknown} */ v) {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_HANDOFF) throw bad('That continue has no usable handoff.');
  return v;
}
/** The chats the client moved away from a Host while it was offline (lost-host path): chat, the epoch that replaced it and the Host that took over. */
function movedOf(/** @type {unknown} */ v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_MOVED) throw bad('That host was sent moved chats it cannot read.');
  return v.map((m) => {
    if (!m || !isCount(m.epoch)) throw bad('That host was sent moved chats it cannot read.');
    return {
      chatId: chatOf(m),
      epoch: /** @type {number} */ (m.epoch),
      targetHostId: hostIdOf(m.targetHostId),
    };
  });
}

/** A peer's declared protocol: `{ minor, floor }` with floor <= minor. */
function protocolOf(/** @type {any} */ v) {
  if (!v || !isCount(v.minor) || !isCount(v.floor) || v.floor > v.minor) throw bad('That host declares no protocol version.');
  return { minor: /** @type {number} */ (v.minor), floor: /** @type {number} */ (v.floor) };
}
/** The features a peer declares; unknown names are kept (they simply never match), duplicates collapse. */
function featuresOf(/** @type {unknown} */ v) {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > MAX_FEATURES || !v.every((f) => typeof f === 'string' && FEATURE.test(f)))
    throw bad('That host declares features this app cannot read.');
  return [...new Set(v)];
}

/** An id an answer to a card names: a non-empty string within bounds. */
function answerId(/** @type {any} */ p, /** @type {string} */ name) {
  const v = p[name];
  if (typeof v !== 'string' || !v || v.length > 200) throw bad(`That answer has no valid ${name}.`);
  return v;
}

/** A text field of a pairing request: a string within `max` characters, else the request is malformed. */
function proofField(/** @type {any} */ p, /** @type {string} */ name, /** @type {number} */ max) {
  const v = p[name];
  if (typeof v !== 'string' || !v || v.length > max) throw bad(`That pairing request has no valid ${name}.`);
  return v;
}
/** The proof a client gives that it holds its key: the key, the challenge it answers and the signature over it. */
const proofOf = (/** @type {any} */ p) => ({
  publicKey: proofField(p, 'publicKey', 200),
  nonce: proofField(p, 'nonce', 64),
  signature: proofField(p, 'signature', 200),
});

/** The surfaces a Host can offer a chat. `desktop` is the Host's own desktop, served by lease (desktop.mjs); `cu` is the user's own Mac and no Host has it, so an app that does not know `desktop` never runs a Host chat's computer-use tools on its own desktop. */
export const CAPABILITY_KEYS = Object.freeze(['iab', 'cu', 'desktop', 'bu', 'shell']);

/** A Host's declared capabilities: every key is a boolean, and anything it does not declare as true is false (a missing surface is absent, never assumed). */
export function capabilitiesOf(/** @type {unknown} */ v) {
  const given = v && typeof v === 'object' ? /** @type {Record<string, unknown>} */ (v) : {};
  return /** @type {{ iab: boolean, cu: boolean, desktop: boolean, bu: boolean, shell: boolean }} */ (
    Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, given[k] === true]))
  );
}

/** @type {Record<string, (p: any) => any>} each method's params, checked and normalized; fields a method does not name are dropped */
const CORE_PARSERS = {
  'host.hello': (p) => ({
    protocol: protocolOf(p.protocol),
    features: featuresOf(p.features),
    capabilities: capabilitiesOf(p.capabilities),
    moved: movedOf(p.moved),
  }),
  // `signIn`: repository hosts whose git sign-in the answer should report (asked for, so the heartbeat never pays for it)
  'host.status': (p) => (p.signIn == null ? {} : { signIn: signInHostsOf(p.signIn) }),
  // sign-in: no chat, so no epoch or key; starting one joins the sign-in already under way, so a retry is harmless
  'host.login': (p) => {
    if (p.methodId != null && (typeof p.methodId !== 'string' || !LOGIN_METHOD.test(p.methodId)))
      throw bad('That is not a sign-in method.');
    return { harness: loginHarnessOf(p.harness), ...(p.methodId == null ? {} : { methodId: p.methodId }) };
  },
  'host.loginStatus': (p) => ({ harness: loginHarnessOf(p.harness) }),
  'host.loginCancel': (p) => ({ harness: loginHarnessOf(p.harness) }),
  'host.logout': (p) => ({ harness: loginHarnessOf(p.harness) }),
  // a model key lent for one harness's process, or taken back (null); a refusal never repeats the key
  'host.modelKey': (p) => {
    if (typeof p.harness !== 'string' || !Object.hasOwn(KEYED, p.harness)) throw bad('That agent takes no key.');
    if (p.key !== null && !isKey(p.key)) throw bad('That is not an API key.');
    return { harness: p.harness, key: p.key };
  },
  // an organization lease for one harness's process, or taken back (token null); a refusal never repeats the token
  'host.orgLease': (p) => {
    try {
      return leaseOf(p, Date.now());
    } catch (e) {
      throw bad(/** @type {Error} */ (e).message);
    }
  },
  // a line the person typed for the sign-in under way (the code Claude Code asks to be pasted); one line, bounded
  'host.loginInput': (p) => {
    if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 2048) throw bad('Type the code the sign-in asks for.');
    return { harness: loginHarnessOf(p.harness), text: p.text };
  },
  // installing an agent the Host lists as missing: no chat, so no epoch or key; starting one joins the install under way, so a retry is harmless
  'host.install': (p) => ({ harness: installHarnessOf(p.harness) }),
  'host.installStatus': (p) => ({ harness: installHarnessOf(p.harness) }),
  'host.installCancel': (p) => ({ harness: installHarnessOf(p.harness) }),
  // pairing (host/src/pairing.mjs): a challenge to sign, a one-time code that registers the signing key, and the proof a paired client gives on each connection
  'host.challenge': () => ({}),
  'host.pair': (p) => ({ ...proofOf(p), code: proofField(p, 'code', 64), ...optionalName(p) }),
  'host.auth': (p) => proofOf(p),
  ...chatInputParsers({ effect, pathOf, harnessOf, epochOf, bad }),
  ...historyParsers({ scoped, bad }),
  'chat.remove': (p) => effect(p),
  'chat.stop': (p) => ({ ...effect(p), ...(p.turnId == null ? {} : { turnId: String(p.turnId).slice(0, 200) }) }),
  'chat.permit': (p) => ({ ...effect(p), value: optionOf(p.value) }),
  // the answer to a card a turn waits on: the card's id and the option picked, none for a card dismissed
  'chat.answer': (p) => ({
    ...effect(p),
    requestId: answerId(p, 'requestId'),
    ...(p.optionId == null ? {} : { optionId: answerId(p, 'optionId') }),
    // the answer to a form card (shared/acpForm.mjs encodes it): what the person chose, for the Host to check against the form it asked
    ...(p.form == null ? {} : { form: formAnswerOf(p.form) }),
  }),
  'chat.subscribe': (p) => {
    if (p.fromRev != null && !isCount(p.fromRev)) throw bad('That resume point is not a revision.');
    if (p.generation != null && (typeof p.generation !== 'string' || !GENERATION.test(p.generation)))
      throw bad('That resume point names no valid stream.');
    return {
      ...scoped(p),
      ...(p.fromRev == null ? {} : { fromRev: p.fromRev }),
      ...(p.generation == null ? {} : { generation: p.generation }),
    };
  },
  // continue: prepare names the epoch the target will serve at. Commit and release are idempotent on the preparedId and are not run through the epoch guard (after a commit the guard would refuse the retry of a lost reply)
  'chat.prepareContinue': (p) => ({
    ...effect(p),
    harness: harnessOf(p.harness),
    cwd: pathOf(p.cwd, 'a folder'),
    handoff: handoffOf(p.handoff),
  }),
  'chat.commitContinue': (p) => ({
    chatId: chatOf(p),
    expectedEpoch: epochOf({ epoch: p.expectedEpoch }),
    targetHostId: hostIdOf(p.targetHostId),
    preparedId: preparedIdOf(p),
  }),
  'chat.release': (p) => ({ ...scoped(p), preparedId: preparedIdOf(p) }),
  // no path: the Host's first root, where a picker starts
  'fs.list': (p) => ({ ...(p.path == null ? {} : { path: pathOf(p.path, 'a folder') }), hidden: p.hidden === true }),
  'git.clone': (p) => ({
    key: keyOf(p),
    url: repoOf(p.url),
    dest: pathOf(p.dest, 'a folder to clone into'),
    ...(p.branch == null ? {} : { branch: branchOf(p.branch) }),
    ...(p.credential == null ? {} : { credential: cloneCredentialOf(p.credential, p.url) }),
  }),
  'git.carryPush': (p) => ({
    key: keyOf(p),
    path: pathOf(p.path, 'a folder'),
    untracked: pathsOf(p.untracked),
    unpushed: unpushedOf(p.unpushed),
  }),
  'git.carryPlan': (p) => ({ path: pathOf(p.path, 'a folder') }),
  'git.carryApply': (p) => ({
    key: keyOf(p),
    path: pathOf(p.path, 'a folder'),
    branch: carryBranchOf(p.branch),
    commit: shaOf(p.commit),
    parent: shaOf(p.parent),
    sourceBranch: p.sourceBranch == null ? null : branchOf(p.sourceBranch),
  }),
  'git.carryDrop': (p) => ({ path: pathOf(p.path, 'a folder'), branch: carryBranchOf(p.branch) }),
  'git.inspect': (p) => ({
    path: pathOf(p.path, 'a folder'),
    ...(p.sidebar === true && { sidebar: true }),
    ...(p.checkout === true && { checkout: true }),
  }),
  ...readParsers(pathOf, bad),
  ...imageParsers(effect, scoped, bad),
  'git.worktree': worktreeParser(keyOf, pathOf, branchOf),
  ...browserParsers(scoped, bad),
  ...desktopParsers(scoped, bad),
  ...scheduleParsers,
  ...toolParsers(scoped, bad),
  ...policyParsers(bad),
  ...approvalParsers,
};

/** The wire methods that live one per file in `methods/`: found by folder, so a feature adds its own file and edits no list here. */
const FOLDER = (() => {
  const req = createRequire(import.meta.url);
  const kit = { bad, scoped, effect, pathOf, matchOf };
  return collectMethodFiles(
    codeFilesIn(path.join(path.dirname(fileURLToPath(import.meta.url)), 'methods')),
    (f) => req(`./methods/${f}`),
    kit,
    (m) => Object.hasOwn(CORE_PARSERS, m),
  );
})();

/** Every method's params parser, checked and normalized; fields a method does not name are dropped. @type {Record<string, (p: any) => any>} */
export const PARSERS = { ...CORE_PARSERS, ...FOLDER.parsers };
/** The methods a connection must be paired to call, as their own files declare (server.mjs adds them to its explicit list). */
export const FOLDER_PAIRED_ONLY = Object.freeze([...FOLDER.paired]);

/**
 * What this build can do. A feature is on only when both ends declare it. A feature of its own file in `methods/` joins these. `epoch` and `dedupe` are the ones a chat
 * request cannot be safe without; `isolation` keeps one chat's tools from another's.
 */
const CORE_FEATURES = [
  'journalLifecycle',
  SIDE_CHAT_FEATURE,
  HISTORY_FEATURE,
  'epoch',
  'dedupe',
  'isolation',
  'lanes',
  'browser',
  'desktop',
  'origin', // a message says whether a person wrote it (`human`), and the turn it starts carries that
  'family',
  'tools',
  'logout',
  'credentials',
  // the choice of credential a chat start carries, and the refusals of a Host that keeps it (shared/host/logins.mjs)
  LOGINS_FEATURE,
  'install',
  ORG_FEATURE,
  SCHEDULES_FEATURE,
  // sub-agent words, live command output and chat state on the stream (./stream2.mjs); an end without it is not sent them
  STREAM2_FEATURE,
  CLONE_CREDENTIAL_FEATURE,
  GIT_SIGNIN_FEATURE,
  READ_FEATURE,
  IMAGE_FEATURE,
  // a chat's picture is read by every client currently paired with the Host, not only the one that sent it (host/src/imageProtocol.mjs)
  CHAT_IMAGE_FEATURE,
  // files and folders in a message, on the image channel (./files.mjs)
  FILE_FEATURE,
  POLICY_FEATURE,
  SPEND_FEATURE,
  APPROVALS_FEATURE,
  // a continue to this Host is taken for every family it can start a chat with, not ACP only (a Host that cannot, offers it not: see helloParams)
  CONTINUE_FAMILIES_FEATURE,
];
export const FEATURES = Object.freeze([...CORE_FEATURES, ...FOLDER.features.filter((f) => !CORE_FEATURES.includes(f))]);
/** The features a method needs from both ends; a peer without one is refused, never served in a degraded way. */
const CORE_REQUIRES = {
  'chat.start': ['epoch', 'dedupe', 'isolation'],
  ...Object.fromEntries(IMAGE_METHODS.map((m) => [m, ['epoch', IMAGE_FEATURE]])),
  'chat.remove': ['epoch', 'dedupe', 'journalLifecycle'],
  'chat.send': ['epoch', 'dedupe'],
  'chat.stop': ['epoch', 'dedupe'],
  'chat.permit': ['epoch', 'dedupe'],
  'chat.answer': ['epoch', 'dedupe'],
  'chat.subscribe': ['epoch', 'lanes'],
  ...Object.fromEntries(HISTORY_METHODS.map((m) => [m, ['epoch', HISTORY_FEATURE]])),
  'chat.prepareContinue': ['epoch', 'dedupe'],
  'chat.commitContinue': ['epoch', 'dedupe'],
  'chat.release': ['epoch', 'dedupe'],
  // an older Host has no sign-out: the app says so for that machine instead of reading a refusal as signed out
  'host.logout': ['logout'],
  // a key lent to a Host that cannot hold it would be dropped there: such a Host is refused, and the turn runs on its own sign-in
  'host.modelKey': ['credentials'],
  // an organization lease (orgAccess.mjs) sent to a Host that cannot hold it would be dropped there: such a Host is refused, and the row says so
  'host.orgLease': [ORG_FEATURE],
  'git.clone': ['dedupe'],
  'git.worktree': ['dedupe'],
  ...Object.fromEntries(READ_METHODS.map((m) => [m, [READ_FEATURE]])),
  'git.carryPush': ['dedupe'],
  'git.carryApply': ['dedupe'],
  // installing a missing agent on the Host (host/src/agentInstall.mjs): an older Host has no such method, so it is refused rather than sent
  'host.install': ['install'],
  // a Host that keeps no schedules is never sent one: the app fires the task itself (#2709 phase 2)
  'host.scheduleSync': [SCHEDULES_FEATURE],
  'host.scheduleRuns': [SCHEDULES_FEATURE],
  'host.installStatus': ['install'],
  'host.installCancel': ['install'],
  // a chat's tabs in the Host's browser (browser.mjs): the owner's epoch gates them; they are not deduped (a click twice is two clicks)
  ...Object.fromEntries(BROWSER_METHODS.map((m) => [m, ['epoch', 'browser']])),
  // a chat's lease on the Host's desktop (desktop.mjs): the owner's epoch gates them; calls are not deduped by key (a call id makes a resend safe)
  ...Object.fromEntries(DESKTOP_METHODS.map((m) => [m, ['epoch', 'desktop']])),
  // the app answers the tool calls of a harness that runs on the Host (toolRelay.mjs); an app or Host without it is refused, never served half
  ...Object.fromEntries(TOOL_METHODS.map((m) => [m, ['tools']])),
  ...Object.fromEntries(POLICY_METHODS.map((m) => [m, [POLICY_FEATURE]])),
  ...Object.fromEntries(APPROVAL_METHODS.map((m) => [m, [APPROVALS_FEATURE]])),
};
export const REQUIRES = Object.freeze({ ...CORE_REQUIRES, ...FOLDER.requires });

/** Whether the method has a parser. */
export const knownMethod = (/** @type {unknown} */ m) => typeof m === 'string' && Object.hasOwn(PARSERS, m);

/** A request's params, checked: throws a SchemaError when invalid or when the method is unknown. */
export function parseParams(/** @type {string} */ method, /** @type {unknown} */ params) {
  if (!knownMethod(method)) throw bad(`Unknown request: ${method}`);
  return PARSERS[method](params && typeof params === 'object' ? params : {});
}

/**
 * Throws a GateError unless every feature `method` needs is on. A method outside REQUIRES needs none.
 * @param {string} method @param {{ features: string[] }} negotiated @param {{ credential?: unknown, images?: unknown[], files?: unknown[], mime?: unknown, goal?: unknown, harness?: unknown, sideChat?: unknown, origin?: unknown, native?: unknown }} [params] a clone that lends a sign-in also needs `cloneCredential`
 */
export function requireFeatures(method, negotiated, params) {
  /** @type {string[]} */
  const base = /** @type {Record<string, string[]>} */ (REQUIRES)[method] ?? [];
  const need = [
    ...base,
    ...(method === 'git.clone' && params?.credential != null ? [CLONE_CREDENTIAL_FEATURE] : []),
    ...gitLoginNeeds(method, params),
    ...worktreeNeeds(method, params),
    ...chatInputNeeds(method, params),
    // a credential choice an older Host would drop is a chat that runs on another credential: such a Host is refused
    ...(['chat.start', 'chat.switch'].includes(method) && params?.credential != null ? [LOGINS_FEATURE] : []),
  ];
  const missing = need.filter((f) => !negotiated.features.includes(f));
  if (missing.length > 0)
    throw new GateError('feature_missing', `The host cannot do this safely yet (it lacks ${missing.join(', ')}). Update it.`, missing);
}

/**
 * Throws a GateError unless a chat of `family` can be served: ACP always, any other family only when both ends declared `family`.
 * @param {string} family @param {{ features: string[] }} negotiated
 */
export function requireFamily(family, negotiated) {
  if (family !== UNTAGGED_FAMILY && !negotiated.features.includes(FAMILY_FEATURE))
    throw new GateError(
      'feature_missing',
      `One end cannot tell a ${family} chat's events from ACP's yet (it lacks ${FAMILY_FEATURE}). Update the older one.`,
      [FAMILY_FEATURE],
    );
}

/** This build's `host.hello` params. */
/** What this end offers at hello. `switching: false`: a Host whose runtime cannot settle a chat's move to another agent does not offer `switch`; `continueFamilies: false`: a Host that takes a continue for ACP agents only does not offer `continueFamilies`. */
export const helloParams = ({ switching = true, continueFamilies = true } = {}) => ({
  protocol: { ...PROTOCOL },
  features: FEATURES.filter((f) => (switching || f !== SWITCH_FEATURE) && (continueFamilies || f !== CONTINUE_FAMILIES_FEATURE)),
});
