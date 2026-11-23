// Drives one turn of a native desktop app arm (Claude Desktop's Code tab, ChatGPT desktop's Codex) through the VM's
// GUI: a new chat, the prompt pasted and sent, then follows the app's own transcript until the turn ends.
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { vendorChromeAllowed } from '../lib/claudeChrome.mjs';
import { findTranscript, reachedOutsideBrowser, readTranscript } from '../lib/transcript.mjs';
import { activate, click, frontSheetCount, key, keystroke, paste, sleep } from './gui.mjs';

const KEY = { a: 0, n: 45, v: 9, i: 34, delete: 51, return: 36, escape: 53 };
/** How long after Return a message must show in the app's transcript before the driver calls it never sent. */
export const NO_TRANSCRIPT_MS = 60_000;

/**
 * Picks the arm's model in a new session where the app keeps the choice per session (Claude Desktop: ⇧⌘I, then the
 * model's number in the menu). Apps that carry the choice over (ChatGPT) have no keys and are left as set.
 * @param {any} arm @param {string} [model]
 */
export function pickModel(arm, model) {
  const k = model && arm.modelKeys?.[model];
  if (!k) return;
  key(KEY.i, 'shift down, command down');
  sleep(800);
  keystroke(k);
  sleep(800);
}

/** Whether a key, click or paste was refused (another app in front, gui.mjs toFront; a changed clipboard, gui.mjs paste): nothing was sent. */
export const refused = (/** @type {any} */ e) => e?.code === 'not_frontmost' || e?.code === 'clipboard_changed';

/**
 * The turn's state so far, from its transcript (file null until one holds the tag). Once found, only that file is
 * read again.
 * @param {'claude' | 'codex'} kind @param {string} tag @param {string | null} known
 */
function probe(kind, tag, known) {
  const file = known && existsSync(known) ? known : findTranscript(kind, homedir(), tag);
  return file
    ? { file, ...readTranscript(kind, readFileSync(file, 'utf8')) }
    : { file: null, done: false, question: null, pending: null, denials: [], answer: '', steps: 0, tools: {} };
}

/**
 * Runs one turn. A turn that reaches for Claude in Chrome is stopped at once: that extension reaches the account's
 * real Chrome browsers outside the VM.
 * `allowChrome`: the 12-Grid Bench's browser-use tasks run in the VM's copy of the user's Chrome profile, so there the
 * vendor's Chrome extension is the native arm being measured, not a turn to stop.
 * `model` is the picker label the arm's model keys know (Claude Desktop keeps the model per session).
 * @param {{ arm: any, prompt: string, tag: string, timeoutS: number, allowChrome?: boolean, model?: string }} o
 */
export function desktopTurn({ arm, prompt, tag, timeoutS, allowChrome = false, model }) {
  activate(arm.app);
  sleep(1000);
  try {
    // close whatever has the focus first (a settings window, a popover, a leftover card): Cmd+N and the paste must
    // reach the main window; Esc does nothing to an idle chat
    key(KEY.escape);
    sleep(500);
    if (arm.newChat === 'cmd+n') key(KEY.n, 'command down');
    else click(arm.newChat[0], arm.newChat[1]);
    sleep(2500);
    pickModel(arm, model);
    // a new chat focuses its composer; an arm that needs a click to get there names where
    if (arm.composer) click(arm.composer[0], arm.composer[1]);
    sleep(500);
    key(KEY.a, 'command down'); // clear leftovers
    key(KEY.delete);
    paste(prompt);
    sleep(300);
    key(KEY.return);
  } catch (e) {
    // another app came to the front (a person using the VM's screen, a dialog): the rest of the keys were not sent
    if (!refused(e)) throw e;
    return {
      ok: false,
      notSent: true,
      front: e.front,
      wallMs: 0,
      outsideBrowser: false,
      approvals: 0,
      ...probe(arm.transcripts, tag, null),
    };
  }
  const t0 = Date.now();
  let p = probe(arm.transcripts, tag, null);
  let ok = false;
  let outsideBrowser = false;
  let approvals = 0;
  const answered = new Map();
  const end = t0 + timeoutS * 1000;
  while (Date.now() < end) {
    sleep(3000);
    p = probe(arm.transcripts, tag, p.file);
    // no transcript a minute after Return: the message never reached the app (focus was elsewhere); a driver error,
    // not a turn to wait out
    if (!p.file && Date.now() - t0 > NO_TRANSCRIPT_MS) break;
    if (p.done) {
      ok = true;
      break;
    }
    // a question nobody will answer ends the turn: the agent stopped to ask (recorded, not waited out)
    if (p.question) break;
    approvals += approveAccess(arm, p.pending, answered, Date.now(), p.denials);
    // Claude in Chrome is stopped even where the task allows the vendor's Chrome, unless the run paired one inside the
    // VM: its pairing is account-wide and can reach a Chrome on another device (#1561)
    if (!(allowChrome && vendorChromeAllowed(arm)) && reachedOutsideBrowser(p.tools)) {
      outsideBrowser = true;
      break;
    }
  }
  const wallMs = Date.now() - t0;
  let front;
  if (!ok) {
    activate(arm.app);
    try {
      key(KEY.escape);
    } catch (e) {
      // the turn is not stopped: say which app was in front instead
      if (!refused(e)) throw e;
      front = e.front;
    }
    sleep(2000);
    p = probe(arm.transcripts, tag, p.file);
  }
  approvals += confirmApprovals(p.pending, answered, p.denials);
  const unanswered = unansweredApprovals(answered);
  return { ok, wallMs, outsideBrowser, approvals, unanswered, ...(front ? { front } : {}), ...p };
}

/** How long a sent approval shortcut may go unconfirmed before it is sent again, and how often it is sent at most. */
export const APPROVAL_RETRY_MS = 15_000;
export const APPROVAL_TRIES = 3;

/**
 * Answers a computer-use app-access card the way the MoPilot arms' driver answers approvals: Claude Desktop shows
 * "Allow Claude to use <app>?" for each app, waits about five minutes, then denies it; its Allow-for-this-session key
 * is Cmd+Return. A response counts only once it is seen: the call leaves the transcript's pending slot (its result
 * arrived). The shortcut is never sent while a native sheet covers the app's window (a Save sheet from the task would
 * take the keypress); that is recorded as obstructed and the sheet is left for the agent or the operator, never
 * dismissed here. An ignored shortcut is sent again after APPROVAL_RETRY_MS, up to APPROVAL_TRIES times.
 * `answered` maps each call id to its state; unansweredApprovals reads what never got a response.
 * Returns the number of responses confirmed by this poll.
 * @param {any} arm @param {{ id: string, name: string } | null | undefined} pending
 * @param {Map<string, { tries: number, sentAt: number, obstructed: boolean, confirmed: boolean, denied?: boolean }>} answered
 * @param {number} [now] @param {string[]} [denials] ids of cards the app denied (see confirmApprovals)
 */
export function approveAccess(arm, pending, answered, now = Date.now(), denials = []) {
  const confirmed = confirmApprovals(pending, answered, denials);
  if (!pending || !/request_access$/.test(pending.name)) return confirmed;
  let a = answered.get(pending.id);
  if (!a) answered.set(pending.id, (a = { tries: 0, sentAt: 0, obstructed: false, confirmed: false }));
  if (a.confirmed || a.tries >= APPROVAL_TRIES || (a.tries && now - a.sentAt < APPROVAL_RETRY_MS)) return confirmed;
  activate(arm.app);
  sleep(500);
  try {
    if (frontSheetCount() > 0) {
      a.obstructed = true;
      return confirmed;
    }
    key(KEY.return, 'command down');
  } catch (e) {
    // another app is in front: not sent, so the next poll tries again
    if (!refused(e)) throw e;
    return confirmed;
  }
  a.obstructed = false;
  a.tries++;
  a.sentAt = now;
  return confirmed;
}

/**
 * Marks each sent card confirmed whose call is no longer the transcript's pending one (its result arrived), without
 * sending anything. Every way a turn ends runs it once on the last transcript read, so a card answered just before a
 * question, a stop or the end is still counted. Returns how many it confirmed.
 * @param {{ id: string } | null | undefined} pending
 * @param {Map<string, { tries: number, obstructed: boolean, confirmed: boolean, denied?: boolean }>} answered
 * @param {string[]} [denials] ids of app-access calls whose result says denied
 */
export function confirmApprovals(pending, answered, denials = []) {
  let confirmed = 0;
  // a card the app denied (its five-minute wait ran out) got no approval, whether or not the shortcut was sent
  for (const id of denials) {
    const a = answered.get(id) ?? { tries: 0, sentAt: 0, obstructed: false, confirmed: false, denied: false };
    a.denied = true;
    a.confirmed = false;
    answered.set(id, a);
  }
  for (const [id, a] of answered) {
    if (a.tries && !a.confirmed && !a.denied && id !== pending?.id) {
      a.confirmed = true;
      a.obstructed = false;
      confirmed++;
    }
  }
  return confirmed;
}

/**
 * The access cards that never got a response, with whether a sheet was covering the card the last time it was tried.
 * A turn that ends with any is invalid, not a model result.
 * @param {Map<string, { tries: number, obstructed: boolean, confirmed: boolean, denied?: boolean }>} answered
 */
export const unansweredApprovals = (answered) =>
  [...answered].filter(([, a]) => !a.confirmed).map(([id, a]) => ({ id, tries: a.tries, obstructed: a.obstructed, denied: !!a.denied }));
