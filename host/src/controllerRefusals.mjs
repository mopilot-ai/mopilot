// What each kind of paired client may ask the Host, at the one entry (`server.mjs answer`): `desktop`, `cli` and `phone` as they always could (the phone's reach is classified here, not narrowed: its restrictions are the per-method ones, and which of its methods have no kind gate is listed on #5616), a `controller` (another Mac paired to this Host by an 8-character code, R2b of #5576) only what CONTROLLER_ALLOWED names, and any other kind, the `unknown` a record of a kind this Host does not know reads as, only the four methods that let it pair or prove a key. What a `controller` may ask the Host: only the methods named in CONTROLLER_ALLOWED, a person's chat, file, git, browser and desktop powers and its own client record; any other method, one added later included, is refused before it reaches a handler, on both protocols. This is a guard-rail and an audit trail, NOT a boundary: a controller runs commands and reads files as the Host's OS user, so it can read what the OS user can read. What makes it harder (not a boundary) is held elsewhere: the Host's own folders are no folder a request may name (hostFs `denied`), and a connection that proved a key cannot take the CLI token. The whole table is held by tests/controllerRefusals.invariant.test.ts, which derives every method from the wire parsers and the line protocol, so a new method has to be decided.
import { HOME_METHODS } from './homeGate.mjs';
import { HostRefusal } from './hostFs.mjs';

/** The methods a controller may call: chats, folders, git, the browser and the desktop on this Mac, and its own record (`host.clientRename`, `host.clientRemove` of itself). */
export const CONTROLLER_ALLOWED = Object.freeze([
  'host.hello',
  'host.status',
  'host.challenge',
  'host.pair',
  'host.auth',
  'host.pending',
  'host.commands',
  'host.clientRemove',
  'host.clientRename',
  'host.toolsSync',
  'host.toolResult',
  'host.chats',
  'host.chats.watch',
  'host.gitBranches',
  'host.gitSwitch',
  'host.gitTurnDiff',
  'host.gitCommit',
  'host.gitDiscard',
  'chat.start',
  'chat.send',
  'chat.history',
  'chat.remove',
  'chat.stop',
  'chat.permit',
  'chat.answer',
  'chat.subscribe',
  'chat.prepareContinue',
  'chat.commitContinue',
  'chat.release',
  'chat.attach',
  'chat.image',
  'chat.goal',
  'chat.rename',
  'chat.switch',
  'fs.list',
  'fs.tree',
  'fs.read',
  'fs.search',
  'git.clone',
  'git.carryPush',
  'git.carryPlan',
  'git.carryApply',
  'git.carryDrop',
  'git.inspect',
  'git.status',
  'git.diff',
  'git.worktree',
  'browser.open',
  'browser.tabs',
  'browser.release',
  'browser.abort',
  'browser.attach',
  'browser.detach',
  'browser.close',
  'browser.command',
  'desktop.lease',
  'desktop.release',
  'desktop.abort',
  'desktop.state',
  'desktop.call',
  'send',
  'permit',
  'turn',
  'status',
  'ping',
  'idle',
]);

/** The methods decided against, named so that a method nobody decided fails the guard: the client list and adding a client, every sign-in, key, organization lease, install, update, policy, schedule, relay enrollment and audit read, MoMo, and the code-pair methods. */
export const CONTROLLER_DENIED = Object.freeze([
  'host.clients',
  'host.clientAdd',
  'host.homeLinkRepair',
  'host.login',
  'host.loginStatus',
  'host.loginCancel',
  'host.loginInput',
  'host.logout',
  'chat.login',
  'host.modelKey',
  'host.orgLease',
  'host.install',
  'host.installStatus',
  'host.installCancel',
  'host.policy',
  'host.scheduleSync',
  'host.scheduleRuns',
  'host.relayEnroll',
  'host.relayForget',
  'host.relayStatus',
  'host.auditRead',
  'update',
  'login',
  'loginStatus',
  'loginInput',
  'loginCancel',
]);

const ALLOWED = new Set(CONTROLLER_ALLOWED);
/** The kinds served without a per-kind list: the owner's own computer and the CLI, and the phone, whose methods each carry their own gate where they have one (see #5616). Every other kind is held to a list. */
const WHOLE = new Set(['desktop', 'cli', 'phone']);
/** The only methods a client of a kind this Host does not know may call: it can say hello, pair or prove its key, and nothing else, so a record that reads back as `unknown` is a client that can do nothing. */
export const UNKNOWN_ALLOWED = Object.freeze(['host.hello', 'host.challenge', 'host.auth', 'host.pair']);
const UNKNOWN = new Set(UNKNOWN_ALLOWED);
/** What MoMo's home on another of the user's machines may ask at all: the methods the home gate's own allow-list handles (./homeGate.mjs), and nothing else; the gate then decides each one (its lease, its sessions, its modes). */
const HOME = new Set(HOME_METHODS);

/** Whether a controller may make this request: only what CONTROLLER_ALLOWED names. It answers its own chats' approval cards and sets their permission mode as a desktop does (the owner's decision: a remote chat works as a local one, under the ceiling the controlled Mac's policy sets). @param {string} method */
export const controllerAllows = (method) => ALLOWED.has(method);

/** Whether a client of this kind may make this request: a whole kind any, a controller only CONTROLLER_ALLOWED, a home only the home gate's list, every other kind (unknown, or one added later) only UNKNOWN_ALLOWED. @param {string | undefined} kind @param {string} method */
export const kindAllows = (kind, method) =>
  WHOLE.has(String(kind)) ? true : kind === 'controller' ? ALLOWED.has(method) : kind === 'home' ? HOME.has(method) : UNKNOWN.has(method);

/** Throws the refusal a client of a kind that may not is told; a connection that has not proved a key (no principal) is not judged here. @param {{ kind?: string } | null | undefined} principal @param {string} method */
export function refuseByKind(principal, method) {
  // a principal that names no kind is a desktop's, as the rule gate and the protocol read it (an embedder's own pairing, from before clients had kinds); every record of this Host's own names one, `unknown` when it is not one this Host knows
  if (principal && !kindAllows(principal.kind ?? 'desktop', method)) {
    // a home is told what the home gate tells it for a method outside its list, so its own client reads the same code at either door
    if (principal.kind === 'home') throw new HostRefusal('home_not_allowed', 'MoMo may not do that on this machine.');
    throw new HostRefusal('forbidden', 'This client may not do that.');
  }
}
