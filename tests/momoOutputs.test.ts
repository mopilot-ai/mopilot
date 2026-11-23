// MoMo's Outputs (#2139, outputs.cjs, outputsTools.cjs, the sentinel's sandbox decision) through the real store, trust gate, sentinel, audit log and capability registry: the name and content rules, csv formula neutralization, the caps, the confinement of what is written and opened, the audit entry with no card, the private-read mark, Reset, and the ask switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-trust.ts';
import { store, rig } from './support/momo-outputs-rig.ts';

const require = createRequire(import.meta.url);
const { OutputsStore, OutputError, neutralize, nameOf, MAX_FILES } = require('../electron/momo/outputs.cjs');
const { registerOutputsTools, SOURCE } = require('../electron/momo/outputsTools.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { trustClassOf } = require('../electron/momo/toolTrust.cjs');

test('names: a bare file name of an allowed type; folders, dots, colons, control characters and other types are refused', async () => {
  assert.equal(nameOf('  plan.MD '), 'plan.MD');
  assert.equal(nameOf('Café.txt'), 'Café.txt', 'NFC');
  for (const bad of [
    '',
    '..',
    '.env.txt',
    'a/b.md',
    'a\\b.md',
    '../x.md',
    'a:b.md',
    'a\u0000.md',
    'a\n.md',
    'noext',
    'x.',
    'x'.repeat(98) + '.md',
    'a.html',
    'a.svg',
    'a.png',
    'a.ics',
    'a.sh',
    5,
    null,
  ]) {
    assert.equal(nameOf(bad), null, String(bad));
  }
  const { s } = store();
  const code = (name: unknown) => {
    try {
      s.prepare({ name, content: 'x' });
    } catch (e) {
      return (e as any).code;
    }
  };
  assert.equal(code('../x.md'), 'bad_name');
  assert.equal(code('x.html'), 'bad_type');
  assert.equal(code('ok.md'), undefined);
});

test('content: text only, valid UTF-8, no NUL, valid json, at most 1 MB', () => {
  const { s } = store();
  const code = (name: string, content: unknown) => {
    try {
      s.prepare({ name, content });
    } catch (e) {
      assert.ok(e instanceof OutputError);
      assert.ok((e as Error).message.length > 10);
      return (e as any).code;
    }
  };
  assert.equal(code('a.md', ''), 'bad_content');
  assert.equal(code('a.md', 5), 'bad_content');
  assert.equal(code('a.md', 'x\u0000y'), 'bad_content');
  assert.equal(code('a.md', 'x\ud800'), 'bad_content');
  assert.equal(code('a.json', '{nope'), 'bad_json');
  assert.equal(code('a.json', '{"a":1}'), undefined);
  assert.equal(code('a.txt', 'x'.repeat(1_000_001)), 'too_large');
  assert.equal(code('a.txt', 'x'.repeat(1_000_000)), undefined);
});

test('csv and tsv: a cell that would run as a formula gets a leading quote; numbers, quoted cells and other types are kept', () => {
  assert.deepEqual(neutralize('a,=HYPERLINK("http://evil","x"),-3.5,+1e3,@SUM(A1),-cmd|x\n', ','), {
    text: `a,'=HYPERLINK("http://evil","x"),-3.5,+1e3,'@SUM(A1),'-cmd|x\n`,
    changed: 3,
  });
  // quoted: the quote goes inside, whatever follows the closing quote stays; doubled quotes and newlines inside survive
  assert.deepEqual(neutralize('"=1+1","a ""q"" b","line\n=2",ok', ','), { text: `"'=1+1","a ""q"" b","line\n=2",ok`, changed: 1 });
  assert.deepEqual(neutralize('"=1"junk,x', ','), { text: `"'=1"junk,x`, changed: 1 });
  // CRLF and CR row ends, a tab or CR starting a cell, an unterminated quote, no trailing newline, empty input
  assert.deepEqual(neutralize('a,b\r\n=x,y\r-z', ','), { text: `a,b\r\n'=x,y\r'-z`, changed: 2 });
  assert.deepEqual(neutralize('"\t=x', ','), { text: `"'\t=x`, changed: 1 });
  assert.deepEqual(neutralize('', ','), { text: '', changed: 0 });
  assert.deepEqual(neutralize('=a\t=b\tc', '\t'), { text: `'=a\t'=b\tc`, changed: 2 });
  // a comma inside a tsv is not a separator
  assert.deepEqual(neutralize('x,=y\t-1', '\t'), { text: 'x,=y\t-1', changed: 0 });
  const { s } = store();
  assert.equal(s.prepare({ name: 'a.csv', content: '=1+1\n' }).text, `'=1+1\n`);
  assert.equal(s.prepare({ name: 'a.tsv', content: '=1+1\n' }).changed, 1);
  assert.equal(s.prepare({ name: 'a.md', content: '=1+1\n' }).changed, 0);
});

test('save: 0600 file in an owner-only folder, sealed index, newest first, same name makes a numbered file, notes trimmed', async () => {
  let t = 1000;
  const { dir, s } = store({ now: () => t++ });
  let changes = 0;
  const off = s.onChange(() => changes++);
  const a = await s.save({ name: 'Plan.md', content: '# one', note: '  a   plan\nfor you ', chatId: 'c1' });
  assert.deepEqual([a.name, a.size, a.note, a.fromPrivate, a.neutralized], ['Plan.md', 5, 'a plan for you', false, 0]);
  const b = await s.save({ name: 'plan.md', content: '# two', chatId: 'c1', fromPrivate: true });
  const c = await s.save({ name: 'plan.md', content: '# three', chatId: 'c2' });
  assert.deepEqual([b.name, c.name], ['plan (2).md', 'plan (3).md']);
  const folder = path.join(dir, 'outputs');
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(folder, 'Plan.md')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(folder, 'plan (2).md'), 'utf8'), '# two');
  assert.deepEqual(
    s.list().map((o: any) => [o.name, o.gone, o.fromPrivate]),
    [
      ['plan (3).md', false, false],
      ['plan (2).md', false, true],
      ['Plan.md', false, false],
    ],
  );
  assert.ok(!fs.readFileSync(path.join(dir, 'outputs.json'), 'utf8').includes('Plan.md'), 'the index is sealed');
  assert.equal(changes, 3);
  off();
  await s.save({ name: 'd.md', content: 'd', chatId: 'c' });
  assert.equal(changes, 3, 'unsubscribed');
  // a very long name keeps its type when a number is added
  const long = `${'n'.repeat(95)}.md`;
  await s.save({ name: long, content: 'x', chatId: 'c' });
  const second = await s.save({ name: long, content: 'x', chatId: 'c' });
  assert.ok(second.name.endsWith(' (2).md') && second.name.length <= 100);
  // a file already on the disk without an entry is never overwritten
  fs.writeFileSync(path.join(folder, 'stray.md'), 'mine');
  const stray = await s.save({ name: 'stray.md', content: 'x', chatId: 'c' });
  assert.equal(stray.name, 'stray (2).md');
  assert.equal(fs.readFileSync(path.join(folder, 'stray.md'), 'utf8'), 'mine');
});

test('save without encryption writes nothing; an unreadable index is refused and the folder left alone', async () => {
  const { dir, safe, s } = store();
  safe.available = false;
  await assert.rejects(s.save({ name: 'a.md', content: 'x', chatId: 'c' }));
  assert.deepEqual(fs.existsSync(path.join(dir, 'outputs')) ? fs.readdirSync(path.join(dir, 'outputs')) : [], []);
  assert.throws(() => s.list());
});

test('caps: 200 files, 50 MB in all, checked inside one turn so parallel saves cannot pass them together', async () => {
  const { s } = store();
  const results = await Promise.allSettled(
    Array.from({ length: MAX_FILES + 5 }, (_, i) => s.save({ name: `f${i}.txt`, content: 'x', chatId: 'c' })),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, MAX_FILES);
  const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(refused.length, 5);
  assert.ok(refused.every((r) => r.reason.code === 'full'));
  const big = store();
  const mb = 'x'.repeat(1_000_000);
  const r = await Promise.allSettled(Array.from({ length: 52 }, (_, i) => big.s.save({ name: `b${i}.txt`, content: mb, chatId: 'c' })));
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 50);
  assert.equal(big.s.list().length, 50);
});

test('pathOf: only a plain file in the folder; a symlink, a missing file or an unknown id gives null; gone is listed', async () => {
  const { dir, s } = store();
  const a = await s.save({ name: 'a.md', content: 'x', chatId: 'c' });
  const folder = path.join(dir, 'outputs');
  assert.equal(s.pathOf(a.id), fs.realpathSync(path.join(folder, 'a.md')));
  assert.equal(s.pathOf('nope'), null);
  const outside = path.join(scratch(), 'secret.md');
  fs.writeFileSync(outside, 'secret');
  fs.rmSync(path.join(folder, 'a.md'));
  fs.symlinkSync(outside, path.join(folder, 'a.md'));
  assert.equal(s.pathOf(a.id), null, 'a symlink is not opened');
  assert.equal(s.list()[0].gone, true);
  fs.rmSync(path.join(folder, 'a.md'));
  assert.equal(s.pathOf(a.id), null);
  assert.equal(s.list()[0].gone, true);
});

test('remove deletes the file and the entry; erase deletes both', async () => {
  const { dir, s } = store();
  const a = await s.save({ name: 'a.md', content: 'x', chatId: 'c' });
  await s.save({ name: 'b.md', content: 'x', chatId: 'c' });
  const folder = path.join(dir, 'outputs');
  assert.equal(await s.remove('nope'), false);
  assert.equal(await s.remove(a.id), true);
  assert.deepEqual(fs.readdirSync(folder), ['b.md']);
  await s.erase();
  assert.equal(fs.existsSync(folder), false);
  assert.equal(fs.existsSync(path.join(dir, 'outputs.json')), false);
  await s.sweep();
});

test('an index entry that is not a valid output is dropped when read', async () => {
  const { dir, safe, s } = store();
  await s.save({ name: 'a.md', content: 'x', chatId: 'c' });
  const { SealedJson } = require('../electron/gateway/sealedFile.cjs');
  const raw = new SealedJson({ file: path.join(dir, 'outputs.json'), safeStorage: safe, shape: (v: any) => v });
  await raw.change(
    (v: any) => void v.files.push({ id: 'x', name: '../evil.md', size: 1, at: 1, chatId: 'c', note: '', fromPrivate: false }, 7),
  );
  assert.deepEqual(
    s.list().map((o: any) => o.name),
    ['a.md'],
  );
});

// ---- the tools, over the real gate ----

test('momo_save_file: saved with no card, audited (name and size, never the content), listed, tells MoMo what changed in a csv', async () => {
  const r = rig();
  const text = await r.run('momo_save_file', { name: 'meetings.csv', content: 'a,b\n=HYPERLINK("x"),2\n', note: 'next week' });
  assert.match(text, /^Saved meetings\.csv \(\d+ B\) in the user's Outputs list/);
  assert.match(text, /1 spreadsheet cell\(s\)/);
  assert.equal(r.cards.length, 0);
  const entries = r.entries();
  assert.deepEqual(
    entries.map((e: any) => [e.kind, e.decision ?? e.result]),
    [
      ['intent', 'sandbox'],
      ['outcome', 'done'],
    ],
  );
  assert.ok(!JSON.stringify(entries).includes('HYPERLINK'));
  assert.match(String(await r.run('momo_outputs_list', {})), /^meetings\.csv · \d+ B · \d+ min ago · next week$/);
  // the same name twice is two files, neither asked nor treated as a retry
  const again = await r.run('momo_save_file', { name: 'meetings.csv', content: 'x' });
  assert.match(again, /meetings \(2\)\.csv/);
  assert.equal(r.cards.length, 0);
  assert.doesNotMatch(await r.run('momo_save_file', { name: 'a.md', content: '# hi' }), /spreadsheet/);
});

test('momo_save_file: refusals before and inside the gate are told to MoMo and write nothing', async () => {
  const r = rig();
  for (const [args, code] of [
    [{ name: '../x.md', content: 'x' }, 'bad_name'],
    [{ name: 'x.html', content: '<b>' }, 'bad_type'],
    [{ name: 'x.json', content: '{' }, 'bad_json'],
    [{}, 'bad_name'],
  ] as const)
    await assert.rejects(r.run('momo_save_file', args), (e: any) => e.code === code);
  assert.deepEqual(r.entries(), [], 'a refusal before the gate leaves no entry');
  for (let i = 0; i < MAX_FILES; i++) await r.s.save({ name: `f${i}.txt`, content: 'x', chatId: 'c' });
  await assert.rejects(
    r.run('momo_save_file', { name: 'one-more.txt', content: 'x' }),
    (e: any) => e.code === 'full' && /delete some/.test(e.message),
  );
  assert.deepEqual(
    r.entries().map((e: any) => [e.kind, e.result ?? e.decision]),
    [
      ['intent', 'sandbox'],
      ['outcome', 'not sent'],
    ],
  );
  assert.equal(r.s.list().length, MAX_FILES);
});

test('momo_save_file: an argument that cannot be read is not mistaken for a refusal', async () => {
  const r = rig();
  const odd = {
    get name(): string {
      throw new Error('boom');
    },
  };
  await assert.rejects(r.run('momo_save_file', odd), /boom/);
});

test('momo_save_file: a failure of the disk is uncertain and the error is not swallowed', async () => {
  const r = rig();
  const orig = r.s.save.bind(r.s);
  r.s.save = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    r.run('momo_save_file', { name: 'a.md', content: 'x' }),
    (e: any) => e.code === 'refused' && /may or may not/i.test(e.message),
  );
  r.s.save = orig;
});

test('a chat that read private data: the file is marked as coming from it; Read only and Blocked refuse; a non-MoMo chat has no tool', async () => {
  const r = rig();
  r.sentinel.setSource('mail', { level: 'ask', private: true, name: 'Mail' });
  await r.sentinel.decide({ chatId: 'momo-main', tool: 'momo_mail_read', source: 'mail', kind: 'read' });
  assert.equal(r.sentinel.tainted('momo-main'), true);
  await r.run('momo_save_file', { name: 'from-mail.md', content: 'x' });
  assert.equal(r.s.list()[0].fromPrivate, true);
  for (const level of ['read', 'blocked'] as const) {
    const g = rig({ level });
    await assert.rejects(g.run('momo_save_file', { name: 'a.md', content: 'x' }), (e: any) => e.code === 'refused');
    assert.equal(g.s.list().length, 0);
    assert.equal(g.entries().at(-1).kind, 'refusal');
  }
  await assert.rejects(r.run('momo_save_file', { name: 'a.md', content: 'x' }, 'coding-chat'), (e: any) => e.code === 'unavailable');
  await assert.rejects(r.run('momo_outputs_list', {}, 'coding-chat'), (e: any) => e.code === 'unavailable');
  assert.equal(r.registry.tools.get('momo_save_file').visibleTo('coding-chat'), false);
});

test('the ask switch: without the sandbox flag a save asks on a card like any change', async () => {
  const r = rig({ sandbox: false });
  await r.run('momo_save_file', { name: 'a.md', content: 'x' });
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].kind, 'change');
});

test('momo_outputs_list: empty, gone, unreadable', async () => {
  const r = rig();
  assert.equal(await r.run('momo_outputs_list', {}), 'No files saved yet.');
  await r.run('momo_save_file', { name: 'a.md', content: 'x' });
  fs.rmSync(path.join(r.dir, 'outputs', 'a.md'));
  assert.match(String(await r.run('momo_outputs_list', {})), / · gone$/);
  r.safe.available = false;
  await assert.rejects(r.run('momo_outputs_list', {}), (e: any) => e.code === 'unavailable');
});

test('the tools are MoMo-own in the trust classes and need a chat that owns the call', async () => {
  assert.equal(trustClassOf('momo_save_file'), 'own');
  assert.equal(trustClassOf('momo_outputs_list'), 'own');
  const r = rig();
  await assert.rejects(
    r.registry.tools.get('momo_save_file').handler({ name: 'a.md', content: 'x' }, { chatId: '', segmentId: 's' }),
    (e: any) => e.code === 'unavailable',
  );
});

test('a sandbox call must have no destination and be repeatable, else it asks', async () => {
  const r = rig();
  const base = { chatId: 'momo-main', tool: 't', source: SOURCE, kind: 'change' as const, sandbox: true };
  assert.equal((await r.sentinel.decide({ ...base, repeatable: true })).via, 'sandbox');
  assert.equal((await r.sentinel.decide({ ...base, repeatable: true, egress: { hosts: ['evil.test'] } })).via, 'asked');
  assert.equal((await r.sentinel.decide({ ...base, repeatable: true, egress: { unknown: true } })).via, 'asked');
  assert.equal((await r.sentinel.decide(base)).via, 'asked');
});

test('removing the tools takes both out of the registry', () => {
  const r = rig();
  assert.ok(r.registry.tools.has('momo_save_file') && r.registry.tools.has('momo_outputs_list'));
  r.off();
  assert.ok(!r.registry.tools.has('momo_save_file') && !r.registry.tools.has('momo_outputs_list'));
});

test('defaults: a random id, a size said in MB at the cap, no arguments at all, and no owner means no call', async () => {
  const dir = scratch();
  const s = new OutputsStore({ dir, safeStorage: fakeSafe() });
  const made = await s.save({ name: 'big.txt', content: 'x'.repeat(1_000_000), chatId: 'c' });
  assert.match(made.id, /^[0-9a-f-]{36}$/);
  const r = rig();
  assert.match(await r.run('momo_save_file', { name: 'big.txt', content: 'x'.repeat(1_000_000) }), /\(1 MB\)/);
  assert.match(await r.run('momo_save_file', { name: 'mid.txt', content: 'x'.repeat(2000) }), /\(2 KB\)/);
  await assert.rejects(r.run('momo_save_file', undefined), (e: any) => e.code === 'bad_name');
  const registry = new Registry();
  registerOutputsTools(registry, {
    store: r.s,
    trust: async () => ({ ok: true }),
    tainted: () => false,
    enabled: () => true,
    allowed: () => true,
    isMomoChat: () => true,
  });
  await assert.rejects(
    registry.tools.get('momo_save_file').handler({}, { chatId: 'momo-main', segmentId: 's' }),
    (e: any) => e.code === 'unavailable',
  );
});

test('the momo.outputs flag off: neither tool is offered, a stale call is refused and writes nothing, Reset still deletes what is there; on again, they work', async () => {
  const flag = { on: true };
  const r = rig({ flag });
  await r.run('momo_save_file', { name: 'kept.md', content: 'x' });
  flag.on = false;
  for (const tool of ['momo_save_file', 'momo_outputs_list'])
    assert.equal(r.registry.tools.get(tool).visibleTo('momo-main'), false, `${tool} is not offered`);
  const entries = r.entries().length;
  await assert.rejects(
    r.run('momo_save_file', { name: 'late.md', content: 'x' }),
    (e: any) => e.code === 'off' && /turned off, so nothing was saved/.test(e.message),
  );
  await assert.rejects(r.run('momo_save_sheet', { name: 'late', rows: [['x']] }), (e: any) => e.code === 'off');
  await assert.rejects(r.run('momo_outputs_list', {}), (e: any) => e.code === 'off');
  assert.deepEqual(fs.readdirSync(path.join(r.dir, 'outputs')), ['kept.md'], 'nothing new was written');
  assert.equal(r.entries().length, entries, 'a refused stale call is not even an audit entry');
  await r.s.erase();
  assert.equal(fs.existsSync(path.join(r.dir, 'outputs')), false, 'Reset MoMo deletes the files while the flag is off');
  flag.on = true;
  assert.equal(r.registry.tools.get('momo_save_file').visibleTo('momo-main'), true);
  assert.match(await r.run('momo_save_file', { name: 'again.md', content: 'x' }), /^Saved again\.md/);
});

test('the flag is defined off by default, as a toggle owned by momo with a removal date, and the build ships it off', () => {
  const { FLAG_DEFS } = require('../shared/flagDefs.mjs');
  const { DEFAULTS } = require('../electron/platform/flags.cjs');
  const def = FLAG_DEFS.find((d: any) => d.key === 'momo.outputs');
  assert.deepEqual([def.default, def.mode, def.owner], [false, 'toggle', 'momo']);
  assert.match(def.remove, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(DEFAULTS['momo.outputs'], false);
});
