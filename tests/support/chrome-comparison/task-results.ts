// task results Chrome comparison cases using shared fake drivers and page services.
import {
  test,
  assert,
  EventEmitter,
  TASKS,
  UPLOAD_TEXT,
  ACCOUNT,
  selectTasks,
  fixturePages,
  startFixtureServer,
  callsFromLog,
  summarize,
  table,
  post,
} from './fixture.ts';

export function registerTaskResults() {
  test('tasks: the required ones, the optional signed-in and screenshot ones only when asked, or the ids named', () => {
    assert.deepEqual(
      selectTasks().map((t) => t.id),
      ['lookup', 'long-form', 'spa', 'two-tabs', 'upload', 'dialog', 'iframe'],
    );
    assert.equal(selectTasks({ optional: true }).length, TASKS.length);
    assert.deepEqual(
      selectTasks({ ids: ['spa', 'signed-in'] }).map((t) => t.id),
      ['spa', 'signed-in'],
    );
    assert.throws(() => selectTasks({ ids: ['nope'] }), /Unknown task: nope/);
    const pages = fixturePages(TASKS, { frameOrigin: 'http://localhost:9' });
    assert.match(pages['/iframe'], /src="http:\/\/localhost:9\/iframe\/frame"/);
    for (const t of TASKS)
      assert.match(t.prompt({ base: 'http://b', uploadFile: '/tmp/receipt-7731.txt' }), /In my Chrome, open http:\/\/b\//);
  });

  test('server and checkers: each task passes on what a page would post or the right answer, and fails otherwise', async () => {
    const server = await startFixtureServer({ tasks: TASKS });
    try {
      const { base, frameOrigin, records } = server;
      const get = async (p: string, o: any = {}) =>
        fetch(`${frameOrigin.startsWith('http://localhost') && o.frame ? frameOrigin.replace('localhost', '127.0.0.1') : base}${p}`, o);
      assert.equal((await get('/lookup')).status, 200);
      assert.match(await (await get('/lookup/book')).text(), /DE-4471/);
      assert.equal((await get('/missing')).status, 404);
      // the iframe's frame is served on the second origin too
      assert.equal((await get('/iframe/frame', { frame: true })).status, 200);
      const check = (id: string, answer = '') =>
        TASKS.find((t) => t.id === id)!.check(records, answer, { uploadFile: '/tmp/x/receipt-7731.txt' });
      assert.equal(check('lookup', 'The code is DE-4471.'), true);
      assert.equal(check('lookup', 'no idea'), false);
      assert.equal(check('long-form'), false);
      await post(`${base}/form`, { first: 'Ada', last: 'Lovelace' });
      assert.equal(check('long-form'), false);
      await post(`${base}/form`, {
        first: 'Ada',
        last: 'Lovelace',
        email: 'ada@example.test',
        phone: '555-0100',
        street: '12 Analytical Way',
        city: 'London',
        zip: 'NW1 6XE',
        country: 'United Kingdom',
        company: 'Engines Ltd',
        role: 'Mathematician',
        referral: 'A friend',
        notes: ' Prefers email ',
      });
      assert.equal(check('long-form'), true);
      // each value is quoted in the prompt, so the sentence's closing period is not read as part of the last one
      // (Codex typed "Prefers email." when the prompt ended "Notes: Prefers email. Then submit it.")
      const longForm = TASKS.find((t) => t.id === 'long-form')!.prompt({ base, uploadFile: '/f' });
      assert.match(longForm, /Notes: "Prefers email"\. Then submit it\.$/);
      assert.match(longForm, /First name: "Ada"; Last name: "Lovelace";/);
      assert.equal(check('spa'), false);
      await post(`${base}/spa/save`, { theme: 'solarized' });
      assert.equal(check('spa'), true);
      assert.equal(check('two-tabs', 'Kettle B'), true);
      assert.equal(check('two-tabs', 'Kettle A is cheaper than Kettle B'), false);
      assert.equal(check('upload'), false);
      await post(`${base}/upload`, { name: 'receipt-7731.txt', text: UPLOAD_TEXT });
      assert.equal(check('upload'), true);
      await post(`${base}/upload`, { name: 'other.txt', text: UPLOAD_TEXT });
      assert.equal(check('upload'), false);
      await post(`${base}/dialog`, { accepted: false });
      assert.equal(check('dialog'), false);
      await post(`${base}/dialog`, { accepted: true });
      assert.equal(check('dialog'), true);
      await post(`${base}/iframe`, { coupon: 'SPRING26' });
      assert.equal(check('iframe'), true);
      assert.equal(check('signed-in', 'Your member number is M-20931.'), true);
      // target=_blank, download and scroll tasks
      assert.match(await (await get('/blank')).text(), /target="_blank"/);
      assert.equal(check('blank', 'The locker code is LK-5520'), true);
      assert.equal(check('blank', 'no idea'), false);
      assert.equal(check('download'), false);
      const file = await get('/download/report.csv');
      assert.match(String(file.headers.get('content-disposition')), /attachment; filename="report-q3\.csv"/);
      assert.equal(file.headers.get('content-type'), 'text/csv');
      assert.match(await file.text(), /kettle,41\.90/);
      assert.equal(check('download'), true);
      assert.equal(check('scroll'), false);
      assert.match(await (await get('/scroll')).text(), /Clause 60/);
      await post(`${base}/scroll`, { accepted: true });
      assert.equal(check('scroll'), true);
      // the screenshot task (#1539): an image the report page decoded, never a text file or a blank one
      assert.match(await (await get('/shot/invoice')).text(), /Invoice 4471/);
      assert.match(await (await get('/shot/report')).text(), /createImageBitmap/);
      assert.equal(check('screenshot-upload'), false);
      await post(`${base}/shot/report`, { name: 'receipt.txt', head: '72656365', width: 0, height: 0 });
      assert.equal(check('screenshot-upload'), false);
      await post(`${base}/shot/report`, { name: 'tiny.png', head: '89504e47', width: 1, height: 1 });
      assert.equal(check('screenshot-upload'), false);
      await post(`${base}/shot/report`, { name: 'invoice.jpg', head: 'ffd8ffe0', width: 800, height: 600 });
      assert.equal(check('screenshot-upload'), true);
      await post(`${base}/shot/report`, { name: 'invoice.png', head: '89504e47', width: 1280, height: 200 });
      assert.equal(check('screenshot-upload'), true);
      // a body that is not JSON is recorded as null
      await fetch(`${base}/junk`, { method: 'POST', body: 'not json' });
      assert.deepEqual(records['/junk'], [null]);
      // the sign-in sets the session cookie; /whoami answers it
      const login = await get('/login', { redirect: 'manual' });
      assert.equal(login.status, 302);
      assert.match(String(login.headers.get('set-cookie')), /session=tester/);
      assert.deepEqual(await (await get('/whoami', { headers: { cookie: 'session=tester' } })).json(), ACCOUNT);
      assert.deepEqual(await (await get('/whoami')).json(), {});
      server.reset();
      assert.deepEqual(Object.keys(records), []);
    } finally {
      server.close();
    }
  });

  test('server: a body over the limit is cut, so it is recorded as not JSON', async () => {
    const server = await startFixtureServer({ tasks: TASKS });
    try {
      await post(`${server.base}/big`, { x: 'a'.repeat(1 << 21) });
      assert.deepEqual(server.records['/big'], [null]);
    } finally {
      server.close();
    }
    const failing: any = () => {
      const s: any = new EventEmitter();
      s.listen = () => setImmediate(() => s.emit('error', new Error('EADDRINUSE')));
      return s;
    };
    await assert.rejects(startFixtureServer({ tasks: TASKS, createServer: failing }), /EADDRINUSE/);
  });

  test('metrics: a chat’s calls and invalid calls from the operation log; the summary per arm and harness, and its table', () => {
    const lines = [
      { at: 10, chatId: 'c', outcome: 'ok' },
      { at: 20, chatId: 'c', outcome: 'bad_args' },
      { at: 30, chatId: 'c', outcome: 'denied' },
      { at: 40, chatId: 'other', outcome: 'ok' },
      { at: 500, chatId: 'c', outcome: 'ok' },
    ]
      .map((e) => JSON.stringify(e))
      .concat(['not json', 'null'])
      .join('\n');
    assert.deepEqual(callsFromLog(lines, { chatId: 'c', from: 0, to: 100 }), { calls: 3, invalid: 1 });
    // an instance runs one chat at a time: without a chat, every call in the window
    assert.deepEqual(callsFromLog(lines, { from: 0, to: 100 }), { calls: 4, invalid: 1 });
    const rows = summarize([
      { arm: 'b2', harness: 'claude', task: 'a', ok: true, ms: 1000, calls: 4, invalid: 0, cards: 1, resultChars: 3000 },
      { arm: 'b2', harness: 'claude', task: 'b', ok: false, ms: 3000, calls: 6, invalid: 2, cards: 0 },
      { arm: 'b2', harness: 'claude', task: 'c', ok: true, ms: 2000, calls: 5, invalid: 1, cards: 2, resultChars: 5000 },
      { arm: 'native', harness: 'codex', task: 'a', ok: true, ms: 4000, calls: null, invalid: null, cards: 0 },
      { arm: 'native', harness: 'codex', task: 'b', ok: true, ms: 2000, calls: null, invalid: null, cards: 0 },
    ]);
    assert.deepEqual(rows[0], {
      arm: 'b2',
      harness: 'claude',
      runs: 3,
      success: 2 / 3,
      medianSeconds: 2,
      meanCalls: 5,
      meanInvalid: 1,
      meanCards: 1,
      meanChars: 4000,
    });
    assert.deepEqual(rows[1], {
      arm: 'native',
      harness: 'codex',
      runs: 2,
      success: 1,
      medianSeconds: 3,
      meanCalls: null,
      meanInvalid: null,
      meanCards: 0,
      meanChars: null,
    });
    const md = table(rows);
    assert.match(md, /^\| Arm \| Harness \|/);
    assert.match(md, /\| b2 \| claude \| 3 \| 67% \| 2\.0 \| 5\.0 \| 1\.0 \| 1\.0 \| 4000 \|/);
    assert.match(md, /\| native \| codex \| 2 \| 100% \| 3\.0 \| n\/a \| n\/a \| 0\.0 \| n\/a \|/);
    assert.deepEqual(summarize([]), []);
  });
}
