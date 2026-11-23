// Codex goal cache publishes only saved state and preserves damaged prior goals before recovery.
import { test, assert, fs, path, ready } from './support/main-sessions/fixture.ts';

test('Codex goal recovery preserves the prior goals before defaults are saved', async () => {
  const h = await ready();
  const file = path.join(h.userData, 'codex-goals.json');
  const original = '{"chat":{"objective":"unfinished';
  fs.writeFileSync(file, original);
  const goals = h.one('CodexAdapter').opts.goalStore;
  assert.deepEqual(goals.read(), {});
  goals.write({ next: { objective: 'new' } });
  assert.equal(fs.readFileSync(`${file}.unreadable`, 'utf8'), original);
});

test('a failed Codex goal write cannot publish unsaved goals through its cache', async () => {
  const h = await ready();
  const file = path.join(h.userData, 'codex-goals.json');
  const original = { chat: { objective: 'keep' } };
  fs.writeFileSync(file, JSON.stringify(original));
  const goals = h.one('CodexAdapter').opts.goalStore;
  assert.deepEqual(goals.read(), original);
  fs.chmodSync(h.userData, 0o555);
  try {
    assert.throws(() => goals.write({ other: { objective: 'unsaved' } }), /EACCES/);
  } finally {
    fs.chmodSync(h.userData, 0o755);
  }
  assert.deepEqual(goals.read(), original);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});
