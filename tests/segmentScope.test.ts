// electron/session/segmentScope.cjs: Claude in Chrome's link in a chat's state follows the chat's current segment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const { chromeLinkApplies, chromeLinkScope } = require('../electron/session/segmentScope.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const CLAUDE = { kind: 'claude', id: 's1', key: 'claude:s1' };
const CODEX = { kind: 'codex', id: 't1', key: 't1' };

test("the link applies only on a Claude segment, and with a key only to that segment's session", () => {
  const of = (ref: any) => () => ref;
  assert.equal(chromeLinkApplies(of(CLAUDE)), true);
  assert.equal(chromeLinkApplies(of(CLAUDE), 'claude:s1'), true);
  assert.equal(chromeLinkApplies(of(CLAUDE), 'claude:s0'), false, "an earlier Claude segment's CLI");
  assert.equal(chromeLinkApplies(of(CODEX)), false);
  assert.equal(chromeLinkApplies(of(CODEX), 'claude:s1'), false);
  assert.equal(chromeLinkApplies(of({ kind: 'acp:kimi', key: 'acp:kimi:x' })), false);
  assert.equal(chromeLinkApplies(of(null)), false);
  // a kind this build does not know is no Claude segment, and the failure is recorded
  clearIgnored();
  assert.equal(chromeLinkApplies(of({ kind: 'mystery', key: 'k' })), false);
  assert.ok(recentIgnored().some((e: any) => e.context === "read a chat's segment for its Claude in Chrome link"));
  // so is a chat whose segment can't be read at all (ChatController.ref throws for a newer build's kind)
  assert.equal(
    chromeLinkApplies(() => {
      throw new Error('Unknown harness kind: "future"');
    }, 'claude:s1'),
    false,
  );
});

test("a reading reaches the chat only from its current segment's session; a segment end shows the new segment's link", () => {
  const patches: any[] = [];
  let ref: any = CLAUDE;
  const links: Record<string, any> = { 'claude:s1': { connected: false, dropped: true } };
  const scope = chromeLinkScope({
    sessions: { patch: (chatId: string, p: any) => patches.push([chatId, p]) },
    ref: (chatId: string) => {
      if (chatId === 'unreadable') throw new Error('Unknown harness kind: "future"');
      return ref;
    },
    linkOf: (key: string) => links[key] ?? null,
  });
  const link = { connected: true, dropped: false };
  scope.report('c', link, 'claude:s1');
  scope.report('c', link, 'claude:s0');
  scope.report(null, link, 'claude:s1');
  scope.report('', link, 'claude:s1');
  assert.deepEqual(patches, [['c', { chromeLink: link }]]);
  // a chat whose segment can't be read takes no reading, and the CLI's exit cleanup goes on
  scope.report('unreadable', null, 'claude:s1');
  assert.equal(patches.length, 1);
  // the chat moves to Codex: the old CLI's link leaves the chat, and its later readings stay out
  ref = CODEX;
  scope.segmentEnded({ chatId: 'c', from: CLAUDE, to: CODEX });
  scope.report('c', link, 'claude:s1');
  scope.report('c', null, 'claude:s1');
  assert.deepEqual(patches.slice(1), [['c', { chromeLink: null }]]);
  // back to the Claude segment whose CLI still runs: its last reading shows again
  ref = CLAUDE;
  scope.segmentEnded({ chatId: 'c', from: CODEX, to: CLAUDE });
  assert.deepEqual(patches.at(-1), ['c', { chromeLink: links['claude:s1'] }]);
  // a Claude segment with no live CLI has no link
  scope.segmentEnded({ chatId: 'c', from: CODEX, to: { kind: 'claude', id: 's2', key: 'claude:s2' } });
  assert.deepEqual(patches.at(-1), ['c', { chromeLink: null }]);
});

/** Every main-process source file, relative to the repository. */
const mainSources = () => treeFiles(path.join(root, 'electron'), /\.c?js$/).map((p) => path.relative(root, p));

test("invariant: a chat's chromeLink is written only by the segment scope, and read in main only through chromeLinkApplies", () => {
  const writes: string[] = [];
  const reads: string[] = [];
  for (const file of mainSources()) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      const at = `${file}:${i + 1}`;
      // a patch of the session state's chromeLink (state.cjs only declares its default)
      if (/\bchromeLink\s*:/.test(line) && file !== 'electron/session/state.cjs' && file !== 'electron/session/segmentScope.cjs')
        writes.push(at);
      // a read of a chat's chromeLink must ask whether it applies to the chat's current segment
      if (/\.chromeLink\b/.test(line) && !/chromeLinkApplies\(/.test(line)) reads.push(at);
    });
  }
  assert.deepEqual(writes, [], 'patch chromeLink through chromeLinkScope (electron/session/segmentScope.cjs)');
  assert.deepEqual(reads, [], "read a chat's chromeLink with chromeLinkApplies(ref) on the same line");
  // windows only read it: main is its one writer
  const { CLIENT_KEYS } = require('../electron/session/state.cjs');
  assert.equal(CLIENT_KEYS.has('chromeLink'), false);
});
