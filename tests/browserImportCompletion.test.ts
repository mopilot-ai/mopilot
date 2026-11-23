// Latest admitted browser import owns durable summaries and global completion events.
import { test, assert, world, T0, fs, path, ImportLedger } from './support/browser-import/fixture.ts';

for (const kind of ['bookmarks', 'history']) {
  for (const outcome of ['success', 'failure']) {
    test(`a retired ${kind} ${outcome} cannot replace the newer import's persisted summary or progress`, async (t) => {
      let resolve!: (items: any[]) => void;
      let reject!: (error: Error) => void;
      const gate = new Promise<any[]>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let first = true;
      const items =
        kind === 'bookmarks'
          ? [{ title: 'New', url: 'https://new.test/', folderPath: [] }]
          : [{ title: 'New', url: 'https://new.test/', lastVisit: T0, visitCount: 1 }];
      const w = world({
        [kind]: () => {
          if (first) {
            first = false;
            return gate;
          }
          return items;
        },
      });
      t.after(() => {
        w.data.history().close();
        fs.rmSync(path.dirname(w.importer.o.ledger.file), { recursive: true, force: true });
      });
      const old = await w.importer.start({ source: 'chrome', profile: 'Default', kinds: { [kind]: true } });
      const running = w.importer.run({ jobId: old.jobId });
      await new Promise((done) => setImmediate(done));
      w.importer.cancel(old.jobId);
      const fresh = await w.importer.start({ source: 'safari', profile: 'Safari', kinds: { [kind]: true } });
      assert.equal((await w.importer.run({ jobId: fresh.jobId }))[kind].status, 'ok');
      const summary = structuredClone(w.importer.imported().last);
      assert.equal(summary.source, 'safari');
      const eventCount = w.events.length;
      if (outcome === 'success') resolve(items);
      else reject(new Error('late old reader failure'));
      assert.equal((await running)[kind].status, 'cancelled');
      if (outcome === 'failure') assert.deepEqual(w.events.slice(eventCount), [], 'late failure progress stays retired');
      assert.deepEqual(w.importer.imported().last, summary, 'the latest durable summary remains owned by the new import');
      assert.deepEqual(new ImportLedger({ file: w.importer.o.ledger.file }).last(), summary);
      assert.deepEqual(w.events.slice(eventCount), [], 'retired progress cannot wake global import observers');
    });
  }
}
