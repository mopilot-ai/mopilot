// Guard (A3, MoMo drafts): MoMo itself never sends mail or a message; only the user's click on a draft card does. A draft is data shown to the user, so (1) no MoMo tool or trust class is named like a send, a forward or a reply, (2) the one connector tool that sends (send_mail, a change, in the fake mail accounts) is called only by the draft sender, which only the card's IPC reaches, never a tool, routine or loop, (3) the modules a draft passes through reach no network and no other store, and the one place that hands words to the system (Open in Mail) takes only a mail link it built itself, and (4) the draft tool has no argument that could carry a sender, a hidden copy or a "really send" switch. Any other tool of that kind has to come with its own plan and a trust rule, not slip in beside a draft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const DRAFTS = 'electron/app/momoDrafts.cjs';
const { registerDraftTools } = require('../electron/momo/draftTools.cjs');
const { fakeConnector } = require('../electron/momo/connectors/fake.cjs');
const { fakeMailConnector, ACCOUNTS } = require('../electron/momo/connectors/fakeMail.cjs');
const { SEND_TOOL } = await import('../shared/momoDraftSend.mjs');
const { CLASSES } = require('../electron/momo/toolTrust.cjs');
const { OWN_LINES } = await import('../shared/ownToolLines.mjs');

/** Words that make a tool name a send: it would reach someone the user did not hand the words to. */
const SEND_WORDS = new Set(['send', 'sent', 'forward', 'reply', 'deliver', 'dispatch', 'transmit', 'relay', 'smtp', 'outbox']);
const wordsOf = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
const sendLike = (name: string) => wordsOf(name).filter((w) => SEND_WORDS.has(w));

const files = (dir: string, ext: RegExp): string[] =>
  fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true }).flatMap((e) => {
    if (!e.isFile() || !ext.test(e.name)) return [];
    return [path.join(e.parentPath, e.name)];
  });
const read = (f: string) => fs.readFileSync(path.isAbsolute(f) ? f : path.join(root, f), 'utf8');

test('the guard knows a send by its name, in any spelling, and a draft is not one', () => {
  for (const n of ['momo_send_mail', 'momo_gmail_forward', 'replyAll', 'momo-mail-reply', 'momo_deliver', 'sendMessage', 'momo_smtp_out'])
    assert.ok(sendLike(n).length, n);
  for (const n of ['momo_draft', 'momo_save_file', 'momo_undo_write', 'momo_reminders_add']) assert.deepEqual(sendLike(n), [], n);
});

test('no MoMo tool name, trust class or tool line is a send, a forward or a reply', () => {
  const names = new Set<string>();
  // every momo_ name MoMo's own sources write down, wherever (a registration, a class, a line)
  for (const f of files('electron/momo', /\.cjs$/)) {
    for (const m of read(f).matchAll(/['"`](momo_[a-z0-9_]+)['"`]/g)) names.add(m[1]);
  }
  for (const n of Object.keys(OWN_LINES)) if (n.startsWith('momo_')) names.add(n);
  for (const n of Object.values<string[]>(CLASSES).flat()) if (String(n).startsWith('momo_')) names.add(n);
  assert.ok(names.has('momo_draft') && names.has('momo_save_file') && names.size > 15, 'the scan finds the tools');
  const sends = [...names].filter((n) => sendLike(n).length);
  assert.deepEqual(sends, [], 'a MoMo tool named like a send');
});

test("the connector definitions MoMo registers offer no send, forward or reply tool but the fake accounts' send_mail, a change", () => {
  const fake = fakeConnector();
  assert.deepEqual(
    Object.keys(fake.tools).filter((n) => sendLike(n).length),
    [],
  );
  const mail = fakeMailConnector(ACCOUNTS[0]);
  assert.deepEqual(Object.keys(mail.tools), [SEND_TOOL]);
  assert.equal(SEND_TOOL, 'send_mail');
  assert.equal(mail.tools[SEND_TOOL].kind, 'change', 'a send asks the trust layer');
  // the only connectors registered in main are the test ones, under the E2E switch (a real mail connector would have to be added here, with a plan)
  const index = read('electron/momo/sources/index.cjs');
  assert.equal([...index.matchAll(/connectorHub\.register\(/g)].length, 2);
  assert.match(index, /connectors\?\.fake === true\) \{\s*connectorHub\.register\(fakeConnector/);
  assert.match(index, /for \(const who of FAKE_MAIL\) connectorHub\.register\(fakeMailConnector/);
  for (const f of files('electron/momo/connectors', /\.cjs$/)) {
    if (f.endsWith('fakeMail.cjs')) continue;
    for (const m of read(f).matchAll(/^\s{6}(\w+): \{\s*$/gm)) assert.deepEqual(sendLike(m[1]), [], `${f}: tool ${m[1]}`);
  }
});

test("the send is the user's click: only the card's IPC reaches the sender, and only the sender calls send_mail", () => {
  const electron = files('electron', /\.cjs$/).map((f) => path.relative(root, f));
  // who builds the sender, and who names the send tool
  assert.deepEqual(
    electron.filter((f) => /require\([^)]*draftSend\.cjs/.test(read(f))),
    ['electron/app/momoDraftSend.cjs'],
  );
  assert.deepEqual(electron.filter((f) => /SEND_TOOL/.test(read(f))).sort(), [
    'electron/momo/connectors/fakeMail.cjs',
    'electron/momo/draftSend.cjs',
  ]);
  // the press that lets a send_mail run is minted in the sender only
  assert.deepEqual(
    electron.filter((f) => /\.press\(/.test(read(f))),
    ['electron/momo/draftSend.cjs'],
  );
  // the one call into the hub with it, in the sender; no registry tool, routine or loop has a way to name it
  assert.equal([...read('electron/momo/draftSend.cjs').matchAll(/hub\.call\(/g)].length, 1);
  for (const f of electron.filter((f) => /^electron\/momo\/[a-zA-Z]*(?:Tools|loopActs|routines?|brief\w*)\.cjs$/.test(f)))
    assert.doesNotMatch(read(f), /draftSend|send_mail/, f);
  // the window names a note and an account's id and sends words: no tool name, no URL
  const card = read('src/components/momo/MomoDraftCard.tsx');
  assert.match(card, /native\.momoDraft\.send\(\{ \.\.\.note, from: from\.id, \.\.\.shown \}\)/);
  assert.doesNotMatch(read('electron/bridge/momoDraft.cjs'), /url|href|send_mail/i);
  // and there is no Undo of a send
  assert.doesNotMatch(card + read('src/components/momo/draftSendCopy.ts') + read('shared/momoDraftSend.mjs'), /undo/i);
});

test('the draft tool takes words only: no sender, no copy, no switch, and its schema is exactly to, subject and body', () => {
  const tools: any[] = [];
  registerDraftTools({ register: (t: any) => (tools.push(t), () => undefined) } as any, {
    chats: {} as any,
    turnOf: () => null,
    changed: () => undefined,
    allowed: () => true,
    isMomoChat: () => true,
  });
  assert.deepEqual(
    tools.map((t) => t.name),
    ['momo_draft'],
  );
  assert.deepEqual(Object.keys(tools[0].schema.properties).sort(), ['body', 'subject', 'to']);
  assert.deepEqual(tools[0].schema.required, ['body']);
  assert.equal(tools[0].authorizesItself, true);
  assert.match(tools[0].description, /It sends nothing/);
});

test('the modules a draft passes through reach no network, no process and no other MoMo store', () => {
  const NETWORK =
    /require\(['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|child_process|worker_threads)['"]\)|\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|\bnet\.request|\bnodemailer\b|\bsmtp/i;
  const OTHER_STORES = /memory|outputs|historyIndex|sources|connectors|vault|sentinel|audit|trustGate|openLoops|routine/i;
  for (const f of [
    'shared/momoDraft.mjs',
    'shared/momoDraftSend.mjs',
    'src/components/momo/draftSendCopy.ts',
    'src/components/momo/useDraftSend.ts',
    'src/components/momo/draftLastFrom.ts',
    'src/components/momo/ChipRow.tsx',
    'electron/momo/draftTools.cjs',
    DRAFTS,
    'src/components/momo/MomoDraftCard.tsx',
    'mobile/src/screens/MomoDraft.tsx',
    'mobile/src/momo/draftOpener.ts',
    'mobile/src/momo/draftPick.ts',
    'mobile/src/platform/draftPick.ts',
  ]) {
    const src = read(f);
    assert.doesNotMatch(src, NETWORK, `${f} reaches a network or a process`);
    for (const m of src.matchAll(/(?:require\(|from )['"]([^'"]+)['"]/g)) {
      assert.doesNotMatch(m[1], OTHER_STORES, `${f} imports ${m[1]}, another MoMo store`);
    }
  }
  // the tool's whole dependency list
  const deps = [...read('electron/momo/draftTools.cjs').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(deps.sort(), ['../../shared/momoDraft.mjs', '../capabilities/contract/registry.cjs', './contract/toolIsolation.cjs']);
});

test('the one call that hands words to the system opens only the mail link main built, never a link a window names', () => {
  const src = read(DRAFTS);
  const open = [...src.matchAll(/openExternal\(/g)].length;
  assert.equal(open, 2, 'the adapter and its one call');
  // the call is after the allowlist and uses the link built here
  assert.ok(src.indexOf('isMailto(url)') < src.indexOf('await openExternal(url)'));
  assert.match(src, /return openMailLink\(link\.url, openExternal\)/);
  assert.doesNotMatch(src, /openExternal\((?:input|draft)\b/);
  // the card hands main words (to, subject, body), never a URL
  assert.match(read('src/components/momo/MomoDraftCard.tsx'), /native\.momoDraft\.openInMail\(shown\)/);
  assert.doesNotMatch(read('electron/bridge/momoDraft.cjs'), /url|href/i);
  // nothing else on the Mac or the phone opens a mail link for a draft
  for (const f of files('src', /\.tsx?$/))
    if (!f.endsWith('MomoDraftCard.tsx') && /momoDraft\b/.test(read(f)))
      assert.match(f, /native\/(?:momoDraft|contracts\/momoDraft)\.ts$|(?:useDraftSend|draftSendCopy)\.ts$/);
});

test("the draft's account question is the card's own control: it draws the shared chip row and never reaches the message path that sends the model a message", () => {
  const card = read('src/components/momo/MomoDraftCard.tsx');
  assert.match(card, /from '\.\/ChipRow'/);
  assert.doesNotMatch(card, /store\/send|sendMessage|OptionChips/);
  assert.doesNotMatch(read('src/components/momo/ChipRow.tsx'), /store\/send|sendMessage/);
  // the model's Options answers are the one user of the sending wrapper
  assert.match(read('src/components/momo/OptionChips.tsx'), /sendMessage\(chatId, label, \[\], \{ human: true \}\)/);
});
