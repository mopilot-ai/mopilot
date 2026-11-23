// Finds the Host's handlers for the wire methods, one file per feature in `host/src/methods/`: a file default-exports a function of the protocol's dependencies that returns `{ handlers, effects }`, so a feature adds methods without editing protocol.mjs.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeFilesIn, defaultOf } from '../../shared/host/methodFiles.mjs';
import { SchemaError } from '../../shared/host/schema.mjs';
import { createChatVeil } from './chatVeil.mjs';

const req = createRequire(import.meta.url);

/**
 * @param {string[]} names the files of the folder
 * @param {(name: string) => unknown} load a file's module
 * @param {object} deps what the protocol was given
 */
export function collectHandlers(names, load, deps) {
  /** @type {Record<string, (p: any) => unknown>} plain requests: parsed, gated on features, then run */
  const handlers = {};
  /** @type {Record<string, (p: any) => unknown>} chat requests that change something: run once per key, at the chat's epoch */
  const effects = {};
  /** @type {Record<string, (principal: unknown) => boolean>} methods that exist only for the clients it says yes to: for any other they are a request no Host knows */
  const veils = {};
  /** @type {import('./chatVeil.mjs').ChatRules | undefined} the chats a feature keeps apart (one feature does today) */
  let chatRules;
  /** @type {Record<string, (principal: unknown) => boolean>} features advertised in the hello only to the clients it says yes to */
  const shown = {};
  /** Which chats a caller may see in a list: the ones a feature keeps apart (MoMo's) only to a caller that may see them. A file makes its handlers before the rules are known, so this reads them when it is asked. @param {{ principal?: () => unknown } | undefined} who */
  const chatVisible = (who) =>
    chatRules?.any() ? (/** @type {string} */ id) => chatRules?.state(id) !== 'hidden' || !!chatRules?.seen(who?.principal?.()) : undefined;
  for (const name of names) {
    const made = defaultOf(load(name))({ chatVisible, ...deps }) ?? {};
    Object.assign(veils, made.veils);
    Object.assign(shown, made.features);
    if (made.chatRules) {
      if (chatRules) throw new Error(`methods/${name} keeps chats apart, which another feature already does.`);
      chatRules = made.chatRules;
    }
    for (const [kind, into] of /** @type {const} */ ([
      ['handlers', handlers],
      ['effects', effects],
    ]))
      for (const [method, run] of Object.entries(made[kind] ?? {})) {
        if (Object.hasOwn(handlers, method) || Object.hasOwn(effects, method))
          throw new Error(`methods/${name} serves ${method}, which is already served.`);
        into[method] = run;
      }
  }
  /** What a veil or feature check says, or no when it cannot say: it then hides, and the Host's own report says why. @param {(principal: unknown) => boolean} check @param {unknown} principal @param {string} what */
  const decided = (check, principal, what) => {
    try {
      return !!check(principal);
    } catch (error) {
      /** @type {{ report?: (m: string) => void }} */ (deps).report?.(
        `A veil failed for ${what}: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  };
  return {
    handlers,
    effects,
    /** The methods that are veiled (a test checks that every open one is). */
    veiled: Object.keys(veils),
    /** Throws what a request no Host knows gets, for a veiled method this caller may not see. @param {string} method @param {unknown} principal */
    veil(method, principal) {
      if (Object.hasOwn(veils, method) && !decided(veils[method], principal, method)) throw new SchemaError(`Unknown request: ${method}`);
    },
    /** What each connection's requests, results and events pass: the chats a feature keeps apart are asked for and told of only to those who may see them. */
    chatVeil: chatRules
      ? createChatVeil(chatRules, { report: (/** @type {string} */ m) => /** @type {any} */ (deps).report?.(m) })
      : (/** @type {(m: object) => void} */ emit) => ({ emit, wrap: (/** @type {any} */ conn) => conn }),
    /** The features a hello may name to this caller. @param {string[]} features @param {unknown} principal */
    visible: (features, principal) => features.filter((f) => !Object.hasOwn(shown, f) || decided(shown[f], principal, f)),
  };
}

/** The handlers every file of `host/src/methods/` makes from the protocol's dependencies. @param {object} deps */
export const loadHandlers = (deps) =>
  collectHandlers(codeFilesIn(path.join(path.dirname(fileURLToPath(import.meta.url)), 'methods')), (f) => req(`./methods/${f}`), deps);
