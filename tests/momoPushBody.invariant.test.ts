// The repository holds MoMo's opt-in push body (A6) to one source: the `name` of an approved routine, built by one function (shared/momoNotices.mjs momoPushBody) and reaching a push only through the resolver (electron/momo/pushBody.cjs) and the sealer; no other field of a routine, a chat, a card, a nudge or a source can reach it, the relay never logs it, and a phone cannot switch it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const walk = (dir: string): string[] =>
  fs.existsSync(path.join(ROOT, dir))
    ? fs
        .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]))
    : [];
/** Every shipped source (and the dev host's stand-in), not the tests or the design pages. */
const SOURCES = ['electron', 'shared', 'relay/src', 'scripts/mobile-dev-host', 'src', 'mobile/src']
  .flatMap(walk)
  .filter((f) => /\.(c|m)?[jt]sx?$/.test(f) && !f.endsWith('.d.mts'));
/** The files that name `needle` as code (comment lines left out). */
const using = (needle: RegExp) =>
  SOURCES.filter((f) =>
    read(f)
      .split('\n')
      .some((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && needle.test(l)),
  ).sort();

/** The source of the function `name` in `file`, from its declaration to the closing brace at column 0. */
const fn = (file: string, name: string) => {
  const src = read(file);
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} in ${file}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 3);
};

test('one function builds the body, and it reads only the routine’s name and approval', () => {
  const body = fn('shared/momoNotices.mjs', 'momoPushBody');
  assert.match(body, /^function momoPushBody\(\{ optIn, routine \}\) \{/, 'its only inputs');
  const fields = [...body.matchAll(/routine\??\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(fields)].sort(), ['approved', 'name'], 'the routine fields it reads');
  // no other value is bound or used: no chat, card, source, prompt, memory or text argument
  assert.doesNotMatch(body.replace(/\/\*\*[\s\S]*?\*\//g, ''), /\b(prompt|sources|text|chat|card|nudge|memory|mail|calendar)\b/i);
});

test('only the resolver and the dev host’s stand-in call the builder', () => {
  assert.deepEqual(using(/\bmomoPushBody\(/), [
    'electron/momo/pushBody.cjs',
    'scripts/mobile-dev-host/controls.mjs',
    'shared/momoNotices.mjs',
  ]);
});

test('the resolver hands the builder the routine as stored by its id, and nothing else', () => {
  const resolver = fn('electron/momo/pushBody.cjs', 'createMomoPushBody');
  const calls = [...resolver.matchAll(/momoPushBody\((\{.*\})\)/g)].map((m) => m[1].replace(/\s+/g, ' '));
  assert.deepEqual(calls, ['{ optIn: true, routine: id ? routine(id) : null }']);
  // the routine is the store's record, looked up by the routine the chat is the run of
  assert.match(read('electron/app/momoBackground.cjs'), /routine: \(id\) => routineStore\.get\(id\)/);
  assert.match(read('electron/app/momoBackground.cjs'), /routineIdOf: routineOfChat/);
});

test('a sealed body is made only from the body of the chat that raised the notice, at send time', () => {
  // the sealer is asked in one place, with the resolver's text; the bridge only lends it the remote's key object
  assert.deepEqual(using(/\bsealBody\(/), [
    'electron/platform/notifyPush.cjs',
    'electron/remote/pushBridge.cjs',
    'electron/remote/pushTitles.cjs',
    'scripts/mobile-dev-host/controls.mjs',
    'scripts/mobile-dev-host/host.mjs',
  ]);
  const send = read('electron/platform/notifyPush.cjs');
  assert.match(send, /const text = bodyOf\(chatId\);\s+return text \? sealBody\(pair, ref, text\) : null;/);
  assert.equal([...send.matchAll(/momoBody\(/g)].length, 1, 'used once');
  assert.match(send, /else emit\(pair, pushKind, ref, null, cardId \? chatRef\(pair, cardId\) : null, momoBody\(pair, ref, chatId\)\);/);
  // the resolver is wired from one place
  assert.deepEqual(using(/live\.momoPushBody\b/), ['electron/app/momoBackground.cjs', 'electron/remote/runtime.cjs']);
});

test('the Mac’s banner and request carry no text: the body is in the sealed blob only, and the relay never logs it', () => {
  const push = read('relay/src/push.mjs');
  const log = push.slice(push.indexOf("this.log('push', {"), push.indexOf('});', push.indexOf("this.log('push', {")));
  assert.doesNotMatch(log, /sealed/i, 'the relay’s push log names no blob');
  for (const f of ['relay/src/control.mjs', 'relay/src/push.mjs', 'relay/src/pushPayload.mjs'])
    assert.doesNotMatch(
      read(f)
        .split('\n')
        .filter((l) => /\b(log|console\.\w+|metrics\.\w+)\(/.test(l))
        .join('\n'),
      /sealedBody|\bsb\b/,
      f,
    );
  // the alert's visible body stays empty on every provider path
  assert.match(read('relay/src/pushPayload.mjs'), /alert: \{ title: m\.title, body: '' \}/);
  // the notifier's banner for a MoMo notice never takes a body from the notice
  assert.match(read('electron/momo/notices.cjs'), /body: '',\n\s+chatTitle: '',/);
});

test('the relay and the push proxy hand the sealed body on unread: every use of it is a pass-through or a size check, and none is a log, a metric or a parse', () => {
  const ALLOWED: Array<[string, RegExp]> = [
    ['relay/src/pushPayload.mjs', /^\s*\.\.\.\(\(m\.sealed \|\| m\.sealedBody\) && \{ 'mutable-content': 1 \}\),$/],
    ['relay/src/pushPayload.mjs', /^\s*\.\.\.\(m\.sealedBody && \{ sb: m\.sealedBody \}\),$/],
    // the push proxy's request
    ['relay/src/push.mjs', /^\s*\.\.\.\(m\.sealedBody && \{ sealedBody: m\.sealedBody \}\),$/],
    ['relay/src/push.mjs', /^\s*\/\*\* @type \{string\} \*\/ sealedBody(,| = '',)$/],
    ['relay/src/push.mjs', /await this\.#ordered\(pair, kind, ref, sealed, card, fromHost, sealedBody, sealedStamp\);$/],
    ['relay/src/push.mjs', /this\.#request\(pair, kind, ref, sealed, card, fromHost, sealedBody, sealedStamp\),$/],
    ['relay/src/push.mjs', /^\s*\.\.\.\(sealedBody && !shown\.merged && kind === 'momoNeedsYou' && \{ sealedBody \}\),$/],
    [
      'relay/src/control.mjs',
      /if \(m\.sealedBody !== undefined && \(typeof m\.sealedBody !== 'string' \|\| !m\.sealedBody \|\| m\.sealedBody\.length > MAX_SEALED\)\)$/,
    ],
    ['relay/src/control.mjs', /m\.card, kind === 'host', m\.sealedBody, sealedStamp\)\.then\($/],
  ];
  const seen: string[] = [];
  for (const f of walk('relay/src')) {
    for (const line of read(f).split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || !/sealedBody|\bsb\b/.test(line)) continue;
      assert.ok(
        ALLOWED.some(([file, re]) => file === f && re.test(line)),
        `${f}: ${line.trim()}`,
      );
      seen.push(f);
    }
  }
  assert.deepEqual([...new Set(seen)].sort(), ['relay/src/control.mjs', 'relay/src/push.mjs', 'relay/src/pushPayload.mjs']);
  // nothing in the relay logs, counts or labels it: the push log and the metrics name kind, provider and outcome only
  const push = read('relay/src/push.mjs');
  const logged = push.slice(push.indexOf("this.log('push', {"), push.indexOf('});', push.indexOf("this.log('push', {")));
  assert.doesNotMatch(logged, /sealed|\bsb\b/i);
});

test('the phone opens the body in one place, from `sb`, for MoMo only', () => {
  assert.deepEqual(using(/\bopenSealedBody\(/), ['mobile/src/push/dataMessage.ts', 'mobile/src/push/sealedTitle.ts']);
  assert.deepEqual(using(/\braw\.sb\b/), ['mobile/src/push/payload.ts']);
  assert.match(read('mobile/src/push/payload.ts'), /raw\.kind === 'momoNeedsYou' && text\(raw\.sb, MAX_SEALED\)/);
  // the notification body is the opened text or nothing: no other value is assigned to it
  assert.deepEqual(using(/\.\.\.\(body \? \{ body \} : \{\}\)/), ['mobile/src/push/dataMessage.ts']);
});

test('the opt-in is a Mac setting: no phone method, schema or phone code names it', () => {
  const phone = ['electron/remote/momoOps.cjs', 'electron/remote/pushSettingsOps.cjs', 'electron/remote/methods'].flatMap((p) =>
    p.endsWith('.cjs') ? [p] : walk(p),
  );
  for (const f of [...phone, ...walk('shared/remote'), ...walk('mobile/src')].filter(
    (f) => f !== 'shared/remote/pushSettings.mjs' && f !== 'shared/remote/pushSettings.d.mts',
  ))
    assert.doesNotMatch(read(f), /notify\.pushBody|pushBody/, f);
  // what a phone may set of MoMo is a short, named list, and the push settings a phone may change do not include it
  const ops = read('electron/remote/momoOps.cjs');
  const list = ops.match(/const PHONE_PREFS = Object\.freeze\(\{([^}]*)\}\)/)?.[1] ?? '';
  assert.deepEqual(
    [...list.matchAll(/(\w+): '([\w.]+)'/g)].map((m) => m[2]),
    ['paused', 'routines.proactivity', 'routines.quietHours'],
  );
});

test('the relay hands the sealed lease stamp on unread: every use of it is a pass-through or a size check, never a log, a metric, a store or a parse', () => {
  const ALLOWED: RegExp[] = [
    /^\s*\/\*\* @type \{string\} \*\/ sealedStamp(,| = '',)$/,
    /^\s*\.\.\.\(m\.sealedStamp && \{ sealedStamp: m\.sealedStamp \}\),$/,
    /^\s*\.\.\.\(m\.sealedStamp && \{ ss: m\.sealedStamp \}\),$/,
    /^\s*\.\.\.\(m\.sealedStamp && \{ ss: m\.sealedStamp \}\),$/,
    /await this\.#ordered\(pair, kind, ref, sealed, card, fromHost, sealedBody, sealedStamp\);$/,
    /this\.#request\(pair, kind, ref, sealed, card, fromHost, sealedBody, sealedStamp\),$/,
    /^\s*\.\.\.\(sealedStamp && !shown\.merged && \(kind === 'momoNeedsYou' \|\| kind === 'cleared'\) && \{ sealedStamp \}\),$/,
    /^\s*m\.sealedStamp !== undefined &&$/,
    /^\s*\(typeof m\.sealedStamp !== 'string' \|\|\s*!m\.sealedStamp \|\|\s*m\.sealedStamp\.length > MAX_SEALED_STAMP \|\|\s*!STAMP_CHARS\.test\(m\.sealedStamp\)\)$/,
    /^\s*const sealedStamp = momo && m\.sealedStamp \? m\.sealedStamp : '';$/,
    /m\.card, kind === 'host', m\.sealedBody, sealedStamp\)\.then\($/,
    /^export const MAX_SEALED_STAMP = 256;$/,
    /import \{ MAX_SEALED, MAX_SEALED_STAMP \} from/,
  ];
  for (const f of walk('relay/src')) {
    for (const line of read(f).split('\n')) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line) || !/sealedStamp|MAX_SEALED_STAMP|\bss\b/.test(line)) continue;
      assert.ok(
        ALLOWED.some((re) => re.test(line)),
        `${f}: ${line.trim()}`,
      );
      assert.doesNotMatch(line, /\b(log|console\.\w+|metrics\.\w+|JSON\.parse|store\.\w+)\(/, f);
    }
  }
});
