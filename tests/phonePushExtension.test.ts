// The iOS notification extension's behaviour that a device check cannot produce (A6, mobile/plugins/NotificationService.swift), tested as far as its source can be: the 30 second expiry delivers the alert as it stands, the title path and the counters are the pre-A6 ones so an old phone and a body-only push behave as before, and the shared vectors fix what the Swift opener must read. What is NOT tested here: the Swift runtime itself (no Swift test target in this repository, no extension run, no real UNNotificationServiceExtension timer, no App Group on a device).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { channelFor } from '../mobile/src/push/channels';

const plugins = path.join(import.meta.dirname, '../mobile/plugins');
const swift = (f: string) => fs.readFileSync(path.join(plugins, f), 'utf8');
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const service = swift('NotificationService.swift');
const sealedTitle = swift('Shared/SealedTitle.swift');
/** The text of one Swift member, from its declaration to the line that closes it at the same indent. */
function member(src: string, start: string) {
  const at = src.indexOf(start);
  assert.ok(at >= 0, start);
  const indent = /(^|\n)( *)[^\n]*$/.exec(src.slice(0, at))?.[2] ?? '';
  const end = src.indexOf(`\n${indent}}`, at);
  return src.slice(at, end + 2 + indent.length);
}
const didReceive = member(service, 'override func didReceive');
const expiry = member(service, 'override func serviceExtensionTimeWillExpire');
const finish = member(service, 'private func finish');

test('the 30 second expiry delivers the alert as it stands, once, and builds nothing of its own', () => {
  // the system's timer path: it counts a fallback and delivers `best`, the relay's alert plus whatever opened so far
  assert.equal(squash(expiry), squash('override func serviceExtensionTimeWillExpire() { NotificationService.countFallback() finish() }'));
  // delivery is once, whichever of the normal path and the expiry gets there first, under a lock
  assert.match(finish, /lock\.lock\(\)\s+defer \{ lock\.unlock\(\) \}/);
  assert.match(finish, /guard let done = handler, let content = best else \{ return \}\s+handler = nil\s+done\(content\)/);
  // the title and the body are set in didReceive alone, each only from a successful open, synchronously before finish()
  for (const src of [service, sealedTitle]) {
    const sets = [...src.matchAll(/content\.(title|body) = /g)].map((m) => m[0]);
    assert.deepEqual(sets, src === service ? ['content.body = ', 'content.title = '] : []);
  }
  assert.equal([...didReceive.matchAll(/content\.(title|body) = /g)].length, 2);
  assert.ok(
    didReceive.indexOf('content.body = ') < didReceive.indexOf('finish()') &&
      didReceive.indexOf('content.title = ') < didReceive.indexOf('finish()'),
  );
  // no asynchronous hop between the open and the delivery: an expiry cannot land halfway through a body
  assert.doesNotMatch(didReceive, /DispatchQueue|Task \{|async|await|\.asyncAfter/);
  // an error text, a literal or a description is never put on the alert
  assert.doesNotMatch(service, /content\.(title|body) = ["'(]|localizedDescription|error\.|String\(describing/);
});

test('the title path, the merged rule and the expiry are the pre-A6 ones: an old build and a push with `sb` behave exactly as before', () => {
  // verbatim from the extension before A6 (mobile/plugins/NotificationService.swift at fb5774b07): the title branch, openTitle, isMerged, the expiry and finish
  const golden = [
    'if let content = best, let title = NotificationService.openTitle(content.userInfo) { content.title = title NotificationService.note("opened") } else if best != nil, request.content.userInfo["st"] != nil, !NotificationService.isMerged(request.content.userInfo) { NotificationService.countFallback() NotificationService.note("fallback") } finish()',
    'static func openTitle(_ info: [AnyHashable: Any]) -> String? { guard let sealed = info["st"] as? String, let ref = info["ref"] as? String else { return nil } if isMerged(info) { return nil } return SealedTitle.open(sealed, ref: ref, keys: SealedTitle.titleKeys()) }',
    'static func isMerged(_ info: [AnyHashable: Any]) -> Bool { if let count = (info["count"] as? Int) ?? Int(info["count"] as? String ?? "") { return count > 1 } return false }',
    'override func serviceExtensionTimeWillExpire() { NotificationService.countFallback() finish() }',
    'private func finish() { lock.lock() defer { lock.unlock() } guard let done = handler, let content = best else { return } handler = nil done(content) }',
  ];
  const now = squash(service);
  for (const g of golden) assert.ok(now.includes(g), g.slice(0, 70));
  // the old title opener is still called with the title AAD (its default), so a title can never be opened as a body
  assert.match(
    sealedTitle,
    /static func open\(_ sealed: String, ref: String, keys: \[\[UInt8\]\], aadPrefix: String = SealedTitle\.aadPrefix\) -> String\?/,
  );
  assert.match(sealedTitle, /static let aadPrefix = "mopilot-push-title-v1\|"/);
});

test('the App Group counters: a body-only push changes none; the title branch and the expiry keep their pre-A6 counts', () => {
  const counted = (src: string) =>
    [...src.matchAll(/NotificationService\.(note|countFallback)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`);
  // the body line is before the title branch and counts nothing
  const bodyLine = didReceive.split('\n').find((l) => l.includes('content.body = '))!;
  assert.deepEqual(counted(bodyLine), []);
  // the only counts in didReceive are the pre-A6 ones, both inside the sealed-title branches (an `st` was present or opened)
  assert.deepEqual(counted(didReceive), ['note("opened")', 'countFallback()', 'note("fallback")']);
  assert.match(
    didReceive,
    /\} else if best != nil, request\.content\.userInfo\["st"\] != nil, !NotificationService\.isMerged\(request\.content\.userInfo\) \{\s+NotificationService\.countFallback\(\)/,
  );
  // the expiry counts one fallback for any push, as before; nothing else counts
  assert.deepEqual(counted(expiry), ['countFallback()']);
  // the counters are written to the App Group by these two functions only, with the same keys as before, and never hold a title or a body
  const keys = [...service.matchAll(/defaults\.(?:set|integer)\([^"]*"(sealedTitle\w+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(keys)].sort(), ['sealedTitleFallbacks', 'sealedTitleLast', 'sealedTitleOpened']);
  // note() stores its fixed outcome word and a count; countFallback() stores a count: neither is given the title or the body
  assert.match(member(service, 'static func note'), /defaults\.set\(result, forKey: "sealedTitleLast"\)/);
  assert.match(
    member(service, 'static func countFallback'),
    /defaults\.set\(defaults\.integer\(forKey: "sealedTitleFallbacks"\) \+ 1, forKey: "sealedTitleFallbacks"\)/,
  );
  assert.deepEqual(
    [...service.matchAll(/note\("(\w+)"\)/g)].map((m) => m[1]),
    ['opened', 'fallback'],
  );
});

test('the opener the Swift mirror must be: the same bound and AAD rules the shared vectors pin', () => {
  const v = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures/push-body-vectors.json'), 'utf8'));
  assert.ok(sealedTitle.includes(`static let bodyAadPrefix = "${v.aadPrefix}"`));
  // the same open for both, so a vector the TS opener reads is read by it: 24-byte nonce, 16-byte tag, 200-byte bound, controls to spaces, trimmed
  assert.match(sealedTitle, /static let nonceBytes = 24/);
  assert.match(sealedTitle, /static let tagBytes = 16/);
  assert.match(sealedTitle, /plain\.count <= 200/);
  assert.ok(v.padBytes <= 200, 'a padded body fits the bound');
  assert.match(sealedTitle, /CharacterSet\.controlCharacters\.contains\(\$0\) \? " " : String\(\$0\)/);
  assert.match(sealedTitle, /\.trimmingCharacters\(in: \.whitespaces\)/);
  // an empty result is nil, so the alert keeps its relay body
  assert.match(sealedTitle, /if !cleaned\.isEmpty \{ return cleaned \}/);
});

test('Private lock-screen choice (Android channels): a MoMo "needs you" with a body uses the details-hidden channel; iOS Show Previews is not covered here', () => {
  assert.equal(channelFor('momoNeedsYou', true, 'private').id, 'needs-you-private');
  assert.equal(channelFor('momoNeedsYou', true, 'hide').id, 'needs-you-hide');
  assert.equal(channelFor('momoNeedsYou', true, 'show').id, 'needs-you');
});
