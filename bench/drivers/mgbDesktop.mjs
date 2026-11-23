// VM-only glue for the 12-Grid Bench's native arms (#1381): one task's messages in Claude Desktop or the ChatGPT app,
// the first in a new chat (bench/drivers/desktop.mjs), the rest pasted into the same chat, each followed through the
// app's own transcript until its turn ends.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { chatUsage, findTranscript, readTranscript, transcriptSetup, transcriptTitle } from '../lib/transcript.mjs';
import { NO_TRANSCRIPT_MS, approveAccess, confirmApprovals, desktopTurn, refused, unansweredApprovals } from './desktop.mjs';
import { activate, buttonAt, click, focusTextArea, key, paste, rightClickAt, screenshot, sleep } from './gui.mjs';

const KEY = { a: 0, v: 9, delete: 51, return: 36, escape: 53 };
/** How long a sent message may take to show in the transcript before the driver focuses the composer and resends. */
const RESEND_MS = 20_000;

/** A screenshot that never fails the run. @param {string} file */
function snap(file) {
  try {
    screenshot(file);
  } catch {
    // a missing screenshot only loses evidence
  }
}

/**
 * Sends one more message into the open chat and waits until a new turn has ended: the transcript must grow past what
 * it was before the message, then read done.
 * The chat may move to a new transcript file (the ChatGPT app starts a new rollout for a later message): the newest
 * file holding the run tag is read, and a new file counts its messages from zero.
 * @param {any} arm @param {string} file @param {string} prompt @param {number} timeoutS @param {string} tag
 */
function nextMessage(arm, file, prompt, timeoutS, tag) {
  // the chat's messages so far: the turn is read only once this message is in the transcript (the app writes a title
  // and other records first, and until then the previous turn's end still reads as done)
  const before = readTranscript(arm.transcripts, readFileSync(file, 'utf8')).prompts;
  /** The app that was in front when a key was refused (gui.mjs toFront): the message was not sent. */
  let front = '';
  /** Pastes the message into the composer and sends it; `escape` first closes what has the focus. */
  const send = (escape = true) => {
    front = '';
    activate(arm.app);
    sleep(800);
    try {
      // computer use can leave a dialog or the browser pane focused: Esc closes it and returns to the chat (an idle
      // chat ignores it); an arm that needs a click to reach the composer names where
      if (escape) key(KEY.escape);
      sleep(500);
      if (arm.composer) click(arm.composer[0], arm.composer[1]);
      else if (arm.composerInTree !== false && !focusTextArea(arm.app)) return false;
      sleep(300);
      key(KEY.a, 'command down');
      key(KEY.delete);
      paste(prompt);
      key(KEY.return);
      return true;
    } catch (e) {
      // another app came to the front: the transcript never gets the message, and the wait below resends or gives up
      if (!refused(e)) throw e;
      front = e.front;
      return false;
    }
  };
  if (!send()) return { ok: false, notSent: true, front, wallMs: 0, answer: '', steps: 0 };
  let t0 = Date.now();
  let resent = false;
  const end = t0 + timeoutS * 1000;
  /** @type {{ done: boolean, question?: string | null, pending?: { id: string, name: string } | null, denials?: string[], answer: string, steps: number }} */
  let p = { done: false, question: null, pending: null, answer: '', steps: 0 };
  let approvals = 0;
  const answered = new Map();
  while (Date.now() < end) {
    sleep(3000);
    const cur = findTranscript(arm.transcripts, homedir(), tag) ?? file;
    if (!existsSync(cur)) continue;
    const read = { ...readTranscript(arm.transcripts, readFileSync(cur, 'utf8')), file: cur };
    if (read.prompts <= (cur === file ? before : 0)) {
      // not in the transcript after a while: the keys went elsewhere. Focus the composer through Accessibility and send
      // once more; a minute after that, the message never reached the chat
      if (!resent && Date.now() - t0 > RESEND_MS) {
        resent = true;
        // the screen as the message went missing, next to the transcript, for reading the failure afterwards
        snap(`${cur}.notsent-1.png`);
        if (!send(false)) return { ...p, ok: false, notSent: true, front, wallMs: Date.now() - t0, approvals };
        t0 = Date.now();
      } else if (Date.now() - t0 > NO_TRANSCRIPT_MS) {
        snap(`${cur}.notsent-2.png`);
        return {
          ok: false,
          notSent: true,
          ...(front ? { front } : {}),
          wallMs: Date.now() - t0,
          approvals,
          unanswered: unansweredApprovals(answered),
          ...p,
        };
      }
      continue;
    }
    p = read;
    if (p.done) {
      approvals += confirmApprovals(null, answered, p.denials);
      return { ok: true, wallMs: Date.now() - t0, approvals, unanswered: unansweredApprovals(answered), ...p };
    }
    // a question nobody will answer ends the turn: the agent stopped to ask
    if (p.question) break;
    approvals += approveAccess(arm, p.pending, answered, Date.now(), p.denials);
  }
  activate(arm.app);
  try {
    key(KEY.escape);
  } catch (e) {
    // the turn is not stopped: say which app was in front instead
    if (!refused(e)) throw e;
    front = e.front;
  }
  // a card answered just before the question or the timeout still counts
  approvals += confirmApprovals(p.pending, answered, p.denials);
  return { ok: false, ...(front ? { front } : {}), wallMs: Date.now() - t0, approvals, unanswered: unansweredApprovals(answered), ...p };
}

/**
 * Runs a task's messages on a native arm. The first message carries the run tag, which is how its transcript is found.
 * @param {{ arm: any, prompts: string[], tag: string, timeoutS: number, model?: string }} o
 */
export function vendorTurn({ arm, prompts, tag, timeoutS, model }) {
  const startedAt = Date.now();
  const first = desktopTurn({ arm, prompt: prompts[0], tag, timeoutS, allowChrome: true, model });
  /** @type {{ ok: boolean, file?: string | null, notSent?: boolean, wallMs?: number, steps?: number, answer?: string, question?: string | null, approvals?: number, unanswered?: { obstructed: boolean, denied: boolean }[] }[]} */
  const phases = [first];
  if (first.file && first.ok) {
    for (const prompt of prompts.slice(1)) {
      const p = nextMessage(arm, first.file, prompt, timeoutS, tag);
      phases.push(p);
      if (!p.ok) break;
    }
  }
  const last = phases.at(-1);
  const unanswered = phases.flatMap((p) => p.unanswered ?? []);
  // every transcript file the chat used, in order (a later message can move it to a new one)
  const files = [...new Set(phases.map((p) => p.file ?? first.file).filter((f) => !!f && existsSync(f)))];
  const texts = files.map((f) => readFileSync(/** @type {string} */ (f), 'utf8'));
  return {
    // a message the app never got is the driver's failure, not the agent's: the run is ungradable
    // a stopped or finished phase with an access card nobody answered (a Save sheet covered it) is an invalid operator
    // attempt too: the agent never got the access it asked for
    driverError: !first.file || phases.some((p) => p.notSent || p.unanswered?.length),
    error: !first.file
      ? first.front
        ? `${first.front} was in front, so the first message was not sent`
        : 'the app never wrote a transcript for the run'
      : phases.some((p) => p.notSent)
        ? `message ${phases.findIndex((p) => p.notSent) + 1} never reached the app`
        : unanswered.length
          ? unanswered.some((u) => u.denied)
            ? 'access approval denied by the app (the card timed out unanswered)'
            : `access approval not delivered${unanswered.some((u) => u.obstructed) ? ' (a native sheet covered the card)' : ''}`
          : undefined,
    ok: phases.length === prompts.length && phases.every((p) => p.ok),
    // a phase that ended on an unanswered question stopped by itself; only the others ran out of time
    timedOut: phases.some((p) => !p.ok && !p.question && !p.notSent),
    askLog: phases.flatMap((p) => (p.question ? [p.question] : [])),
    // computer-use app-access cards the driver allowed, as the MoPilot arms' driver allows approvals
    approvals: phases.reduce((n, p) => n + (p.approvals ?? 0), 0),
    wallMs: phases.reduce((s, p) => s + (p.wallMs ?? 0), 0),
    // a phase reads its whole transcript file, so its step count already holds that file's earlier steps: the most per
    // file, summed over the files
    steps: files.reduce((n, f) => n + Math.max(0, ...phases.filter((p) => (p.file ?? first.file) === f).map((p) => p.steps ?? 0)), 0),
    answer: last?.answer ?? '',
    outsideBrowser: !!first.outsideBrowser,
    // the app's own count of the chat's tokens, in the request ledger's shape
    usage: chatUsage(arm.transcripts, texts),
    // how the app actually ran the chat (permission mode, model, effort), from its latest file
    setup: texts.length ? transcriptSetup(arm.transcripts, /** @type {string} */ (texts.at(-1))) : null,
    // the chat's latest transcript file, for archiving it afterwards
    file: files.at(-1) ?? first.file ?? null,
    startedAt,
    endedAt: Date.now(),
  };
}

/**
 * Archives a native run's chat, which otherwise sits in the vendor app next to the user's own chats (#1381). ChatGPT
 * archives the open chat on Shift+Cmd+A; Claude Desktop's chat is found in the sidebar by the title its transcript
 * records, and archived from the row's menu (A). Returns whether it was archived; a failure only leaves the chat.
 * @param {any} arm @param {{ file?: string | null }} turn
 */
export function archiveChat(arm, turn) {
  try {
    if (arm.archive === 'shift-cmd-a') {
      activate(arm.app);
      sleep(500);
      key(KEY.escape);
      sleep(300);
      key(KEY.a, 'shift down, command down');
      sleep(1000);
      return true;
    }
    if (arm.archive === 'row-menu' && turn.file && existsSync(turn.file)) {
      const title = transcriptTitle(readFileSync(turn.file, 'utf8'));
      if (!title) return false;
      activate(arm.app);
      sleep(500);
      const at = buttonAt(arm.app, title);
      if (!at) return false;
      rightClickAt(at.x, at.y);
      sleep(700);
      key(KEY.a);
      sleep(1000);
      return true;
    }
  } catch {
    // a chat left unarchived is tidied by hand; it never fails the run
  }
  return false;
}
