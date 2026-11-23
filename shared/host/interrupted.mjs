// A turn a machine's restart cut off, as this app shows it: the Host ends it as cancelled and says what was interrupted (host/src/chatLog.mjs recoverTurn); here it becomes a failed turn with that reason, so the chat offers Retry, which carries on in the same session on the machine.
import { prefixUnits } from '../textPrefix.mjs';
import { isLimitError } from '../acpStop.mjs';
import { isAuthText } from '../acpAuth.mjs';
import { stopErrorText } from '../acpStop.mjs';
import { TURN_ERROR_CODES, ledAs } from './turnErrorCode.mjs';

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Most tool calls named in the notice, and the longest name. */
const NAMES = 3;
const NAME_MAX = 80;

/**
 * The event as the chat shows it: a turn end the Host marked as cut off by its restart is a failure that says so; any other event is returned as it is (a person's Stop stays a Stop).
 * @param {any} event
 */
function shownInterruption(event) {
  if (event?.kind !== 'turnEnd' || !isObject(event.interrupted) || event.interrupted.by !== 'host_restart') return event;
  // a command's own words must not read as the turn's failure: a name that looks like a usage limit or a sign-in error is left out,
  // since the windows decide what to offer (switch account, sign in, continue elsewhere) from the error's text
  const running = named(event.interrupted.running, (name) => name);
  // the acting calls the Host had sent and not heard back from: whether they happened is not known, and the Host sends none of them again
  // a relayed tool whose card is already named as interrupted (by its name, or as an MCP tool `mcp__server__name`) is not named twice
  const lost = named(event.interrupted.lost, (call) =>
    isObject(call) && call.kind !== 'tool' ? `${call.kind} ${call.name}` : call?.name,
  ).filter((name) => !running.some((title) => title === name || title.endsWith(`__${name}`)));
  const message = `The machine restarted during this turn.${listed(' Interrupted', running)}${listed(' May have run', lost)}`;
  return { ...event, stopReason: 'error', error: { message } };
}

/** The names a list of the Host's holds that can be shown, each cut to size. @param {unknown} list @param {(entry: any) => unknown} nameOf */
function named(list, nameOf) {
  return (Array.isArray(list) ? list : [])
    .map(nameOf)
    .filter((/** @type {unknown} */ name) => typeof name === 'string' && name.trim() && !isLimitError(name) && !isAuthText(name))
    .map((/** @type {any} */ name) => (name.length > NAME_MAX ? `${prefixUnits(name, NAME_MAX)}…` : name));
}

/** One sentence of names; the Host names at most five, so past three there are more without a count. @param {string} label @param {string[]} names */
function listed(label, names) {
  return names.length ? `${label}: ${names.slice(0, NAMES).join(', ')}${names.length > NAMES ? ' and more' : ''}.` : '';
}

/**
 * A failed turn's end as the chat's records and windows take it: the error as text (the Host sends `{ message, code? }`), the Host's code beside it
 * (`turnErrorCode`), and `onMachine`, so nothing of this Mac's accounts is offered for it. The thread reads only the text (reopened chats too), so
 * a text that does not read as its code is led by words that do (shared/host/turnErrorCode.mjs `ledAs`): every reader reaches the Host's code.
 * @param {any} event
 */
function toldEnd(event) {
  if (event?.kind !== 'turnEnd' || event.error == null) return event;
  const text = /** @type {string} */ (stopErrorText(event.error));
  const code = isObject(event.error) && TURN_ERROR_CODES.includes(event.error.code) ? event.error.code : undefined;
  return { ...event, error: ledAs(text, code), ...(code ? { turnErrorCode: code } : {}), onMachine: true };
}

export { shownInterruption, toldEnd };
