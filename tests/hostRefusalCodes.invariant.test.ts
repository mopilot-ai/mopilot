// Every code a Host can refuse with is worded for the person (shared/host/refusalWords.mjs) or is listed here with why it never reaches one: a new code without either fails, so a refusal is never a bare error or a log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM
import { REFUSAL_CODES } from '../shared/host/refusalWords.mjs';

const ROOT = path.join(import.meta.dirname, '..');

/** Codes the Host raises that are not a refusal of a machine chat's message, and where each is shown instead. */
const EXEMPT: Record<string, string> = {
  // MoMo's delivery problems are states in the view (shared/momoDeliveryView.mjs), each with its own cause sentence and one-tap fix, not refusals of a request
  brief_failed: 'a delivery problem in the status view, with its own cause and fix',
  brief_missed_asleep: 'a delivery problem in the status view, with its own cause and fix',
  push_disabled: 'a delivery problem in the status view, with its own cause and fix',
  relay_unreachable: 'a delivery problem in the status view, with its own cause and fix',
  // the client rules' own answers (shared/host/momoHomeClient.mjs `execute`): a climb that never got above its target, and a stand-down with no lease to give; the client words them in its own view, they are not a Host's refusal of a request
  climb_failed: 'the client rules’ own answer, shown as a problem in the home view',
  no_lease: 'the client rules’ own answer, shown as a problem in the home view',
  // a list cursor is one the Host made, so a client only sends one it was given: a refusal means the client lists again
  bad_cursor: 'a client lists again; the person is never shown it',
  // the browser tool: the error goes back to the agent in the tool result, which the agent words
  browser_exited: 'browser tool error, returned to the agent',
  disposed: 'browser tool error, returned to the agent',
  not_owned: 'browser tool error, returned to the agent',
  refused: 'browser tool error, returned to the agent',
  timeout: 'browser tool error, returned to the agent',
  // the stream and the handshake: a fault in the framing closes the stream and the app reconnects
  bad_stream_frame: 'stream framing fault: the stream closes and the app reconnects',
  too_large: 'a frame over what one message carries: the stream ends with a reason the app reads',
  hello_required: 'handshake fault: the app says hello again on reconnect',
  // pairing by code (host/src/codePairService.mjs): the answers go to the app's own pairing sheet over the CLI connection, which words each one beside the code and the question; they are never a refusal of a machine chat's message
  bad_credential: 'pairing by code: the pairing sheet words it',
  approval_unavailable: 'pairing by code: the pairing sheet words it',
  failed: 'pairing by code: the pairing sheet words it',
  relay: 'pairing by code: the pairing sheet words it',
  connections_off: 'pairing by code: the pairing sheet words it',
  paused: 'pairing by code: the pairing sheet words it',
  limited: 'pairing by code: the pairing sheet words it',
  burned: 'pairing by code: the pairing sheet words it',
  no_approval_helper: 'pairing by code: the pairing sheet words it',
  no_such_offer: 'pairing by code: the pairing sheet words it',
  not_asked: 'pairing by code: the pairing sheet words it',
  // updating a Host from Settings: the update button's own toast says it
  trust_busy: "Settings › My machines update flow: the Update button's toast",
  trust_recovery_failed: "Settings › My machines update flow: the Update button's toast",
  update_trust_changed: "Settings › My machines update flow: the Update button's toast",
};

/** The code literals Host sources raise: refusal classes, `this.code = …`, and `{ code: … }` on an error. */
function codesRaised(): Map<string, string> {
  const found = new Map<string, string>();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.mjs')) files.push(rel);
    }
  };
  walk('host/src');
  walk('shared/host');
  const patterns = [
    /new (?:HostRefusal|ContinueRefusal|BrowserHostError|GateError|SessionJournalError|SchemaError)\(\s*'([a-z][a-z0-9_]+)'/g,
    // the pure rules of a move name a refusal with `refuse('code', …)` (shared/host/momoMovePhases.mjs)
    /\brefuse\(\s*'([a-z][a-z0-9_]+)'/g,
    /this\.code\s*=\s*'([a-z][a-z0-9_]+)'/g,
    /\bcode:\s*'([a-z][a-z0-9_]+)'/g,
  ];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const re of patterns) for (const m of text.matchAll(re)) if (!found.has(m[1])) found.set(m[1], f);
  }
  return found;
}

test('every code a Host raises is worded for the person or is listed with where it is shown instead', () => {
  const raised = codesRaised();
  assert.ok(raised.size > 40, `the scan found ${raised.size} codes: its patterns no longer match the sources`);
  const worded = new Set<string>(REFUSAL_CODES);
  const unworded = [...raised].filter(([code]) => !worded.has(code) && !(code in EXEMPT)).map(([code, file]) => `${code} (${file})`);
  assert.deepEqual(unworded, [], 'add the code to shared/host/refusalWords.mjs, or to EXEMPT here with where it is shown instead');
});

test('an exemption is still a code the Host raises, and is not also worded', () => {
  const raised = codesRaised();
  const worded = new Set<string>(REFUSAL_CODES);
  for (const code of Object.keys(EXEMPT)) {
    assert.ok(raised.has(code), `${code} is exempt but no source raises it any more: remove it`);
    assert.ok(!worded.has(code), `${code} is both worded and exempt`);
  }
});
