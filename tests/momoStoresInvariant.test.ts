// Whole-repository invariant for Reset MoMo (#2139, electron/momo/stores.cjs): every module under electron/momo that keeps data on disk — writing itself (sync or async), through a write helper, or through another such module it imports, .cjs or .mjs — belongs to a store in MOMO_STORES, or says why it holds none of MoMo's data; once a store's module is used outside electron/momo, something registers that store with registerMomoStore. An entry for a module that is gone, or that no longer writes, fails too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { MOMO_STORES } = require('../electron/momo/stores.cjs');
const ROOT = path.join(import.meta.dirname, '..');
const MOMO = 'electron/momo';
/** Write helpers MoMo's stores use from outside its folder (the sealed file, the durable write): a MoMo module importing one keeps data. */
const HELPERS = 'electron/gateway';

/**
 * Each module under electron/momo that keeps data on disk: the store whose data it is (that store's reset deletes it),
 * or `not data:` / `helper:` and why. A new writer must be added here; its store then registers once its module is used.
 */
const OWNERS: Record<string, string> = {
  'electron/momo/memory.cjs': 'memory',
  // writes MoMo's memory through the store a MoMo chat's tools are given
  'electron/momo/memoryTools.cjs': 'memory',
  'electron/momo/sources/hub.cjs': 'sources',
  'electron/momo/auditKey.cjs': 'audit',
  'electron/momo/audit.cjs': 'audit',
  'electron/momo/auditRead.cjs': 'audit',
  'electron/momo/memoryIpc.cjs': 'memory',
  // the background memory pass writes facts through the store (its progress file is the app's, in memory-pass.json)
  'electron/momo/memoryPass.cjs': 'memory',
  // the day's background tokens, kept with the memory files (their reset deletes background-tokens.json)
  'electron/momo/backgroundBudget.cjs': 'memory',
  'electron/momo/factAliases.cjs': 'memory',
  // L4 open loops (P4), kept with the memory files (their reset deletes open-loops.json, and erases the store)
  'electron/momo/openLoops.cjs': 'memory',
  // the nudge check writes the loops and nudges.json, both kept and reset with the memory files
  'electron/momo/nudges.cjs': 'memory',
  // the user's acts on an open loop, through the Memory tab, a nudge's card or MoMo's tool, write the loop store
  'electron/momo/loopActs.cjs': 'memory',
  'electron/momo/loopsIpc.cjs': 'memory',
  'electron/momo/loopTools.cjs': 'memory',
  'electron/momo/sources/calendar.cjs': 'sources',
  'electron/momo/sources/eventKit.cjs': 'sources',
  'electron/momo/sources/files.cjs': 'sources',
  'electron/momo/sources/reminders.cjs': 'sources',
  // P5: what MoMo wrote to Calendar and Reminders (the undo ledger), erased with the sources
  'electron/momo/sources/write.cjs': 'sources',
  'electron/momo/sources/writeLedger.cjs': 'sources',
  'electron/momo/sources/writeTools.cjs': 'sources',
  'electron/momo/access.cjs': 'not data: the invite gate’s cache of the account’s answer (userData/momo-access.json), kept across a reset',
  'electron/momo/routineStore.cjs': 'routines',
  'electron/momo/historyIndex.cjs': 'history',
  'electron/momo/connectors/vault.cjs': 'connectors',
  // saves and deletes a connector's tokens through the vault it is given
  'electron/momo/connectors/hub.cjs': 'connectors',
  'electron/momo/connectors/fake.cjs': 'connectors',
  // the fake mail accounts the draft card sends from (E2E runs): signed in through the hub, their tokens in the vault
  'electron/momo/connectors/fakeMail.cjs': 'connectors',
  'electron/momo/connectors/ipc.cjs': 'connectors',
  'electron/momo/mcp/allowlist.cjs': 'connectors',
  'electron/momo/mcp/proxy.cjs': 'connectors',
  'electron/momo/mcp/ipc.cjs': 'connectors',
  // adds a chat's turns through the index it is given
  'electron/momo/historyIndexer.cjs': 'history',
  // sets search aliases on the index it is given
  'electron/momo/historyAliases.cjs': 'history',
  // reads the index of past chats it is given, for its tool
  'electron/momo/historyTools.cjs': 'history',
  'electron/momo/routineRuns.cjs': 'routines',
  // the routines page's approve, edit and remove, through the routines store
  'electron/momo/routinesIpc.cjs': 'routines',
  'electron/momo/routines.cjs': 'routines',
  // writes a proposed routine through the routines service its tool is given
  'electron/momo/routineTools.cjs': 'routines',
  'electron/momo/mainChat.cjs': 'chats',
  'electron/momo/mainChatIpc.cjs': 'chats',
  // a channel's journal is a MoMo chat made through the main chat service; the registry (channels.json) is erased with the chats
  'electron/momo/channelChats.cjs': 'chats',
  // a draft card's Send keeps how far it got in the draft's own note in the MoMo chat's history, erased with the chats
  'electron/momo/draftSend.cjs': 'chats',
  // this Mac's unsent messages to MoMo's home and the newest lease it has seen (userData/momo/outbox.json, home-client.json), erased with the chats by Reset MoMo
  'electron/momo/homeService.cjs': 'chats',
  'electron/momo/sentinelStore.cjs': 'approvals',
  'electron/momo/trustGate.cjs': 'audit',
  // the E2E runs' test tool: each change it makes goes through the trust gate's audit log
  'electron/momo/debugAction.cjs': 'audit',
  'electron/momo/sources/index.cjs': 'sources',
  'electron/momo/sources/ipc.cjs': 'sources',
  'electron/momo/sources/tools.cjs': 'sources',
  // the files MoMo saves (momo_save_file), erased with the sources by Reset MoMo
  'electron/momo/outputs.cjs': 'sources',
  'electron/momo/outputsTools.cjs': 'sources',
  // Save a copy: copies a saved file to the path the user picked in main's dialog, outside MoMo's folder
  'electron/momo/outputsIpc.cjs': 'helper: copies one saved file to the place the user picked, and keeps nothing of MoMo’s',
  // the hub's decide and audit over the sentinel and the audit log
  'electron/momo/sourceTrust.cjs': 'sources',
  // the registry's chat gate for MoMo's tool calls, over the trust gate's audit log
  'electron/momo/toolTrust.cjs': 'audit',
};

/** Writing to disk itself: Node's fs calls, sync, callback or promise. */
const FS_WRITE =
  /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|copyFileSync|copyFile|renameSync|writeSync)\s*\(|\.open\(/;
/** Writing through the app's write helpers. */
const HELPER = /\b(writePrivate|writeAtomic|writeDurable|writeSealed)\b/;
/** The local modules a module imports (require or import), as repository paths. */
const IMPORTS = /(?:require\(\s*|from\s+|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join('/');
const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const importsOf = (file: string) =>
  [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(IMPORTS)].map((m) =>
    rel(path.resolve(path.dirname(path.join(ROOT, file)), m[1])),
  );

/** The modules under electron/momo that keep data: writing themselves, or importing one that does (to a fixpoint, through the gateway's helpers too). */
function writers(): string[] {
  const files = [...walk(path.join(ROOT, MOMO)), ...walk(path.join(ROOT, HELPERS))].filter((f) => /\.(c|m)?js$/.test(f)).map(rel);
  const own = new Set(
    files.filter(
      (f) => FS_WRITE.test(fs.readFileSync(path.join(ROOT, f), 'utf8')) || HELPER.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
    ),
  );
  // a helper writes for its caller: the caller keeps data too (stores.cjs only deletes)
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of files)
      if (!own.has(f) && f !== `${MOMO}/stores.cjs` && importsOf(f).some((i) => own.has(i))) {
        own.add(f);
        grew = true;
      }
  }
  return [...own].filter((f) => f.startsWith(`${MOMO}/`)).sort();
}

/** Every electron source outside electron/momo, and whether one imports `file`. */
const outside = walk(path.join(ROOT, 'electron'))
  .filter((f) => /\.(c|m)?js$/.test(f))
  .map(rel)
  .filter((f) => !f.startsWith(`${MOMO}/`));
const usedOutside = (file: string) => outside.some((f) => importsOf(f).includes(file));
const registered = (id: string) => outside.some((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(`registerMomoStore('${id}'`));

test('every MoMo module that keeps data on disk has a store, or says why it holds none; no entry outlives its module', () => {
  const ids = new Set(MOMO_STORES.map((s: any) => s.id));
  const found = writers();
  assert.deepEqual(
    found.filter((f) => !(f in OWNERS)),
    [],
    'a module that keeps data needs its store in OWNERS (and MOMO_STORES), or why it holds none of MoMo’s data',
  );
  for (const [file, owner] of Object.entries(OWNERS)) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is gone: take it out of OWNERS`);
    assert.ok(found.includes(file), `${file} no longer keeps data: take it out of OWNERS`);
    assert.ok(ids.has(owner) || /^(not data|helper): ./.test(owner), `${file}: ${owner} is no MoMo store`);
  }
});

test('a store whose module is used outside electron/momo is registered for Reset; the ones this build has, already', () => {
  for (const [file, owner] of Object.entries(OWNERS)) {
    if (!MOMO_STORES.some((s: any) => s.id === owner) || !usedOutside(file)) continue;
    assert.ok(registered(owner), `${file} is used, so something must registerMomoStore('${owner}', …)`);
  }
  // registered now even before their modules are wired in: memory's files and the sources hub's folder
  for (const id of ['memory', 'sources']) assert.ok(registered(id), id);
});

test('the scan finds each way a module keeps data', () => {
  assert.ok(FS_WRITE.test('await fs.promises.writeFile(p, x)'));
  assert.ok(FS_WRITE.test('const h = await fsp.open(p, "w")'));
  assert.ok(HELPER.test('await writeSealed(file, data)'));
  assert.ok(!FS_WRITE.test('fs.readFileSync(p)') && !HELPER.test('readJson(p)'));
  assert.deepEqual(
    [..."const a = require('./x.cjs'); import { b } from '../y.mjs'; await import('./z.js'); require('node:fs')".matchAll(IMPORTS)].map(
      (m) => m[1],
    ),
    ['./x.cjs', '../y.mjs', './z.js'],
  );
});

/**
 * MoMo data kept inside another module's file rather than by a writer of its own: what it is, the store whose reset deletes
 * it, and the key it is stored under in that store's data. Each must also be forgotten in memory by that store's reset.
 */
const KEPT_IN = [{ what: 'the always-allowed sites (sentinelSites.cjs, #3655)', store: 'approvals', key: 'sites' }];

test('data kept inside a store’s file is written with it and forgotten by its reset', async () => {
  const { Sentinel } = require('../electron/momo/sentinel.cjs');
  const box: { data: any } = { data: null };
  const s = new Sentinel({
    askUser: async () => ({ allow: true, scope: 'site' }),
    allowed: () => true,
    sources: { files: { level: 'read', private: true }, browser: { level: 'read' } },
    storage: { read: async () => box.data, write: async (d: any) => void (box.data = JSON.parse(JSON.stringify(d))) },
    sites: new (require('../electron/momo/sentinelSites.cjs').SiteList)({
      risky: require('../electron/app/momoSiteRisk.cjs').riskyUnasked,
    }),
  });
  await s.decide({ chatId: 'a', tool: 'momo_files_read', source: 'files', kind: 'read' });
  const url = 'https://www.ycombinator.com/';
  await s.decide({
    chatId: 'a',
    tool: 'chrome_navigate',
    source: 'browser',
    kind: 'read',
    args: { url },
    egress: { hosts: ['www.ycombinator.com'] },
    repeatable: true,
    opens: url,
  });
  await s.idle();
  const app = fs.readFileSync(path.join(ROOT, 'electron/app/momo.cjs'), 'utf8');
  for (const k of KEPT_IN) {
    assert.ok(
      MOMO_STORES.some((x: any) => x.id === k.store),
      k.what,
    );
    assert.deepEqual(box.data[k.key], ['www.ycombinator.com'], `${k.what} is written in the ${k.store} data`);
    // the store's reset forgets it in memory too (revokeAll), before it deletes the file
    const reset = app.slice(app.indexOf(`registerMomoStore('${k.store}'`));
    assert.ok(reset.slice(0, reset.indexOf('});')).includes('sentinel.revokeAll()'), `the ${k.store} reset forgets ${k.what}`);
  }
  s.revokeAll();
  await s.idle();
  assert.deepEqual(box.data.sites, []);
  assert.deepEqual(s.listSites(), []);
});
