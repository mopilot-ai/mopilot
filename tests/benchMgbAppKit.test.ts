// bench/lib/mgb/apps kit.mjs and server.mjs (#1381): escaping, request bodies, routes, paging, and the fixture server's
// host routing and token-guarded load and state endpoints (no sockets).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, multipart, req, text } from './support/mgb-app-kit.ts';

const kit = await import('../bench/lib/mgb/apps/kit.mjs');
const { CHROME_COOKIE, TOKEN_HEADER, appOfHost, browserOf, chromeMark, createStore, dispatch, viaOf } = await import(
  '../bench/lib/mgb/apps/server.mjs'
);
const { mail } = await import('../bench/lib/mgb/apps/mail.mjs');

test('esc and html escape every value, keep raw markup, join arrays and drop empties', () => {
  assert.equal(kit.esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(kit.esc(null), '');
  const out = kit.html`<p>${'<b>'}${kit.raw('<i>ok</i>')}${['a', kit.raw('<br>'), 'c']}${false}${null}${undefined}${0}</p>`;
  assert.equal(out.__html, '<p>&lt;b&gt;<i>ok</i>a<br>c0</p>');
  assert.equal(kit.raw(undefined).__html, '');
  const p = kit.page({
    app: 'Mail',
    title: 'Inbox',
    nav: [['/f/inbox', 'Inbox']],
    flash: 'Sent <b>',
    error: 'Bad',
    body: kit.html`<p>x</p>`,
  });
  assert.match(p, /<title>Inbox · Mail<\/title>/);
  assert.match(p, /role="status">Sent &lt;b&gt;</);
  assert.match(p, /role="alert">Bad</);
  assert.doesNotMatch(kit.page({ app: 'A', title: 'T', body: '' }), /role="(status|alert)"/);
});

test('responses: ok, redirect, json, notFound and download', () => {
  assert.deepEqual(kit.ok('x', { 'x-a': '1' }), {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'x-a': '1' },
    body: 'x',
  });
  assert.deepEqual(kit.redirect('/a'), { status: 303, headers: { location: '/a' }, body: '' });
  assert.deepEqual(kit.json({ a: 1 }, 400), { status: 400, headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.equal(kit.notFound().body, 'Not found');
  assert.equal(kit.download('a"b.csv', 'text/csv', 'x').headers['content-disposition'], 'attachment; filename="ab.csv"');
  // any uploaded name is a safe header: an ASCII fallback plus the UTF-8 name, no quotes or line breaks
  assert.equal(
    kit.disposition('inline', '日本 report.pdf'),
    `inline; filename="__ report.pdf"; filename*=UTF-8''${encodeURIComponent('日本 report.pdf')}`,
  );
  assert.equal(kit.disposition('attachment', 'a\r\nSet-Cookie: x\\.txt'), 'attachment; filename="aSet-Cookie: x.txt"');
  const pdf = kit.bytes('a.pdf', 'application/pdf', Buffer.from([0, 200]).toString('base64'), true);
  assert.deepEqual([pdf.headers['content-disposition'], pdf.encoding], ['inline; filename="a.pdf"', 'latin1']);
  assert.deepEqual(Buffer.from(pdf.body, 'latin1'), Buffer.from([0, 200]));
  assert.equal(kit.bytes('b', 'x/y', '').headers['content-disposition'], 'attachment; filename="b"');
  assert.equal(kit.header({ 'x-k': ['1', '2'] }, 'X-K'), '1');
  assert.equal(kit.header({}, 'x'), '');
});

test('parseBody reads urlencoded, JSON and multipart bodies, and survives malformed ones', () => {
  const f = kit.parseBody(req('POST', '/', form({ a: 'é ok', b: ['1', '2'] })));
  assert.deepEqual(f.fields, { a: ['é ok'], b: ['1', '2'] });
  const j = kit.parseBody(req('POST', '/', { type: 'application/json', body: Buffer.from('{"a":"ü","b":[1,2]}').toString('latin1') }));
  assert.deepEqual(j.fields, { a: ['ü'], b: ['1', '2'] });
  assert.deepEqual(kit.parseBody(req('POST', '/', { type: 'application/json', body: '[1]' })).fields, {});
  assert.deepEqual(kit.parseBody(req('POST', '/', { type: 'application/json', body: '{nope' })).fields, {});
  const bytes = Buffer.from([0, 255, 128, 10]);
  const m = kit.parseBody(
    req(
      'POST',
      '/',
      multipart({ to: 'a@b.co', note: 'naïve' }, [
        { field: 'attach', name: 'shot.png', type: 'image/png', content: bytes },
        { field: 'attach', name: 'résumé.txt', content: 'hi' },
        { field: 'attach', name: '', content: '' },
        { field: 'attach', name: 'Q3 %22final%22.txt', content: 'q' },
      ]),
    ),
  );
  assert.deepEqual(m.fields, { to: ['a@b.co'], note: ['naïve'] });
  assert.equal(m.files.length, 3, 'an empty file input is no file');
  assert.equal(m.files[2].name, 'Q3 "final".txt');
  assert.deepEqual(Buffer.from(m.files[0].data, 'base64'), bytes);
  assert.deepEqual([m.files[0].name, m.files[0].type, m.files[0].size], ['shot.png', 'image/png', 4]);
  assert.equal(m.files[1].name, 'résumé.txt');
  // quoted boundary, a part with no header break, a part with no name, a file part without a content type
  const b = 'q';
  const odd = [
    `--${b}\r\ngarbage`,
    `--${b}\r\nContent-Disposition: form-data\r\n\r\nnameless\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\n\r\nraw\r\n`,
    `--${b}--\r\n`,
    `--${b}\r\nContent-Disposition: form-data; name="late"\r\n\r\nafter the end\r\n`,
  ].join('');
  const o = kit.parseBody(req('POST', '/', { type: `multipart/form-data; boundary="${b}"`, body: odd }));
  assert.deepEqual(o.fields, {});
  assert.deepEqual([o.files[0].name, o.files[0].type], ['x.bin', 'application/octet-stream']);
  assert.deepEqual(kit.parseBody(req('POST', '/', { type: 'multipart/form-data', body: 'x' })), { fields: {}, files: [] });
  assert.equal(kit.field({ a: ['  x '] }, 'a'), 'x');
  assert.equal(kit.field({}, 'a'), '');
});

test('route matches methods and patterns with decoded params', () => {
  const table: [string, string, string][] = [
    ['GET', '/', 'home'],
    ['GET', '/m/:id', 'msg'],
    ['POST', '/m/:id', 'post'],
    ['GET', '/m/:id/att/:i', 'att'],
  ];
  assert.deepEqual(kit.route('GET', '/', table), { handler: 'home', params: {} });
  assert.deepEqual(kit.route('GET', '/m/A%20B', table), { handler: 'msg', params: { id: 'A B' } });
  assert.deepEqual(kit.route('POST', '/m/1', table)?.handler, 'post');
  assert.deepEqual(kit.route('GET', '/m/1/att/2', table)?.params, { id: '1', i: '2' });
  assert.equal(kit.route('GET', '/m/1/x/2', table), null);
  assert.equal(kit.route('DELETE', '/m/1', table), null);
  assert.equal(kit.route('GET', '/m/%E0%A4%A', table), null, 'a malformed escape matches nothing');
});

test('paginate clamps pages, keeps the query and links every page', () => {
  const list = Array.from({ length: 23 }, (_, i) => i);
  const p2 = kit.paginate(list, new URL('http://x/f/inbox?q=a&page=2'));
  assert.deepEqual([p2.items[0], p2.page, p2.pages], [10, 2, 3]);
  assert.match((p2.pager as any).__html, /Page 2 of 3/);
  assert.match((p2.pager as any).__html, /href="\/f\/inbox\?q=a&amp;page=3"/);
  assert.equal(kit.paginate(list, new URL('http://x/?page=99')).page, 3);
  assert.equal(kit.paginate(list, new URL('http://x/?page=-4')).page, 1);
  assert.equal(kit.paginate(list, new URL('http://x/?page=abc')).page, 1);
  const one = kit.paginate([1], new URL('http://x/'));
  assert.deepEqual([one.pages, one.pager], [1, '']);
  assert.equal(kit.paginate([], new URL('http://x/'), 5).pages, 1);
  const s = { seq: 0, events: [] as any[] };
  assert.equal(kit.nextId(s, 'MSG'), 'MSG-1');
  assert.equal(kit.nextId(s, 'MSG'), 'MSG-2');
  kit.logEvent(s, 'sent', { id: 'MSG-1' }, 5);
  assert.deepEqual(s.events, [{ at: 5, type: 'sent', id: 'MSG-1' }]);
  assert.equal(kit.withFlash('/a', 'x y'), '/a?flash=x%20y');
  assert.equal(kit.withFlash('/a?b=1', 'z'), '/a?b=1&flash=z');
  assert.equal(kit.flashOf(new URL('http://x/?flash=Hi')), 'Hi');
});

const TOKEN = 'tok-0123456789abcdef';
const fixture = {
  user: { name: 'Ada Abara', email: 'ada@corp.test' },
  messages: [{ from: 'Bram <bram@sup.test>', subject: 'Hi', body: 'x' }],
};
const load = (store: any, apps: any, token = TOKEN) =>
  dispatch(
    store,
    req('POST', '/__mgb/load', { type: 'application/json', body: JSON.stringify({ apps }), headers: { [TOKEN_HEADER]: token } }),
    1,
  );

test('viaOf tells browsers from scripts', () => {
  assert.equal(
    viaOf('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) MoPilot/0.3.0 Chrome/140.0 Electron/38.0 Safari/537.36'),
    'browser',
  );
  assert.equal(viaOf('Mozilla/5.0 (Macintosh; rv:140.0) Gecko/20100101 Firefox/140.0'), 'browser');
  assert.equal(viaOf('node'), 'script');
  assert.equal(viaOf('python-requests/2.32'), 'script');
  assert.equal(viaOf(''), 'script');
  const ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
  assert.equal(viaOf(ua, 'navigate'), 'browser');
  assert.equal(viaOf(ua, 'cors'), 'page-script', 'a fetch run inside a page is not someone using the page');
  assert.equal(viaOf(ua, 'same-origin'), 'page-script');
});

test('the store refuses a short token and duplicate app names', () => {
  assert.throws(() => createStore([mail], 'short'), /at least 16/);
  assert.throws(() => createStore([mail, mail], TOKEN), /share a name/);
  assert.equal(appOfHost('Mail.localhost:8820'), 'mail');
  assert.equal(appOfHost('vendors.localhost'), 'vendors');
  assert.equal(appOfHost('localhost:8820'), null);
  assert.equal(appOfHost('evil.example.com'), null);
});

test('the grader endpoints need the token, load all-or-nothing and return every state', () => {
  const store = createStore([mail], TOKEN);
  assert.equal(dispatch(store, req('GET', '/__mgb/state'), 1).status, 404, 'no token: the endpoint does not exist');
  assert.equal(load(store, { mail: fixture }, 'wrong-token-000000').status, 404);
  const get = (path: string) => dispatch(store, req('GET', path, { headers: { [TOKEN_HEADER]: TOKEN } }), 1);
  assert.equal(get('/__mgb/other').status, 404);
  assert.equal(dispatch(store, req('POST', '/__mgb/load', { body: 'nope', headers: { [TOKEN_HEADER]: TOKEN } }), 1).status, 400);
  assert.equal(load(store, [] as any).status, 400);
  assert.equal(load(store, null).status, 400);
  assert.match(load(store, { bank: {} }).body, /unknown apps: bank/);
  assert.match(load(store, { mail: { user: {} } }).body, /fixture for mail failed: mail fixture needs user.email/);
  const raw = createStore(
    [
      {
        name: 'odd',
        title: 'Odd',
        init: () => {
          throw 'bare';
        },
        handle: () => kit.ok(''),
      },
    ],
    TOKEN,
  );
  assert.match(load(raw, { odd: {} }).body, /fixture for odd failed: bare/);
  assert.deepEqual(JSON.parse(get('/__mgb/state').body), {}, 'a failed load leaves nothing loaded');
  assert.deepEqual(JSON.parse(load(store, { mail: fixture }).body), { loaded: ['mail'] });
  const state = JSON.parse(get('/__mgb/state').body);
  assert.equal(state.mail.messages[0].subject, 'Hi');
  assert.deepEqual(state.mail.events, []);
});

test('hosts route to their app; an unknown or unloaded app says so', () => {
  const store = createStore([mail], TOKEN);
  const bare = dispatch(store, { ...req('GET', '/'), headers: { host: 'localhost:8820' } }, 1);
  assert.equal(bare.status, 200);
  assert.match(text(bare), /Mail \(mail\.localhost\)/);
  assert.equal(dispatch(store, req('GET', '/', { app: 'crm' }), 1).status, 404);
  assert.equal(dispatch(store, { ...req('GET', '/'), headers: {} }, 1).status, 200);
  const unready = dispatch(store, req('GET', '/f/inbox'), 1);
  assert.equal(unready.status, 503);
  load(store, { mail: fixture });
  const inbox = dispatch(store, req('GET', '/f/inbox'), 1);
  assert.equal(inbox.status, 200);
  assert.match(text(inbox), /Hi/);
  // each change is stamped with whether a browser made it, and which: the user's Chrome carries the mark cookie
  const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
  const marked = `other=1; ${CHROME_COOKIE}=${store.mark}`;
  dispatch(store, req('GET', '/m/MSG-1', { headers: { 'user-agent': chrome, cookie: marked } }), 2);
  dispatch(store, req('GET', '/m/MSG-1', { headers: { 'user-agent': 'curl/8.7.1', cookie: marked } }), 3);
  dispatch(store, req('GET', '/f/inbox'), 4);
  const electron = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) MoPilot/0.3.0 Chrome/140.0 Electron/38.0 Safari/537.36';
  dispatch(store, req('GET', '/m/MSG-1', { headers: { 'user-agent': electron, 'sec-fetch-mode': 'cors' } }), 5);
  // ChatGPT's built-in browser sends Chrome's exact user agent: without the mark it is not the user's Chrome
  dispatch(store, req('GET', '/m/MSG-1', { headers: { 'user-agent': chrome } }), 6);
  dispatch(store, req('GET', '/m/MSG-1', { headers: { 'user-agent': chrome, cookie: `${CHROME_COOKIE}=forged` } }), 7);
  assert.deepEqual(
    store.states.mail.events.map((e: any) => [e.at, e.via, e.browser]),
    [
      [2, 'browser', 'chrome'],
      [3, 'script', undefined],
      [5, 'page-script', 'app-browser'],
      [6, 'browser', 'app-browser'],
      [7, 'browser', 'app-browser'],
    ],
  );
  assert.equal(browserOf(store.mark, store.mark), 'chrome');
  assert.equal(browserOf('', store.mark), 'app-browser');
});

test('the mark: one tab carries it to every app host, and only with the right mark', () => {
  const store = createStore([mail, { ...mail, name: 'crm', title: 'CRM' }], TOKEN);
  assert.equal(store.mark, chromeMark(TOKEN));
  assert.notEqual(chromeMark(TOKEN), chromeMark(`${TOKEN}x`));
  assert.match(store.mark, /^[0-9a-f]{32}$/);
  const marks = () => JSON.parse(dispatch(store, req('GET', '/__mgb/marks', { headers: { [TOKEN_HEADER]: TOKEN } }), 1).body);
  assert.deepEqual(marks(), { hosts: [] });
  // a wrong or missing mark is nothing
  assert.equal(dispatch(store, req('GET', '/__mgb/mark?k=nope&next=crm'), 1).status, 404);
  assert.equal(dispatch(store, req('GET', '/__mgb/mark'), 1).status, 404);
  assert.equal(dispatch(store, req('GET', '/__mgb/marks'), 1).status, 404, 'the list needs the token');
  // the first host sets the cookie and goes on to the next (unknown names are skipped), keeping the port
  const first = dispatch(store, req('GET', `/__mgb/mark?k=${store.mark}&next=nosuch,crm`), 1);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, `http://crm.localhost:8820/__mgb/mark?k=${store.mark}`);
  assert.equal(first.headers['set-cookie'], `${CHROME_COOKIE}=${store.mark}; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly`);
  // more than one host left: the rest ride along
  const many = dispatch(store, req('GET', `/__mgb/mark?k=${store.mark}&next=crm,mail`), 1);
  assert.equal(many.headers.location, `http://crm.localhost:8820/__mgb/mark?k=${store.mark}&next=mail`);
  // the last host says so; a host without a port keeps none
  const last = dispatch(store, { ...req('GET', `/__mgb/mark?k=${store.mark}`, { app: 'crm' }), headers: { host: 'crm.localhost' } }, 1);
  assert.equal(last.status, 200);
  assert.match(text(last), /marked for the bench/);
  assert.match(String(last.headers['set-cookie']), new RegExp(`^${CHROME_COOKIE}=`));
  const portless = dispatch(store, { ...req('GET', `/__mgb/mark?k=${store.mark}&next=mail`), headers: { host: 'crm.localhost' } }, 1);
  assert.equal(portless.headers.location, `http://mail.localhost/__mgb/mark?k=${store.mark}`);
  // the bare host can start the chain but is not an app
  dispatch(store, { ...req('GET', `/__mgb/mark?k=${store.mark}`), headers: { host: 'localhost:8820' } }, 1);
  assert.deepEqual(marks(), { hosts: ['crm', 'mail'] });
});

test('the registry serves every app once and loads fixtures as the server would', async () => {
  const { APPS, APP_BY_NAME, loadFixtures } = await import('../bench/lib/mgb/apps/index.mjs');
  assert.deepEqual(
    APPS.map((a: any) => a.name),
    ['mail', 'crm', 'shop', 'tracker', 'docs', 'vendors', 'onboard', 'idcheck', 'account'],
  );
  assert.equal(APP_BY_NAME.mail, mail);
  const fx = { mail: fixture, mac: { notes: [{ name: 'a', body: 'b' }] }, files: { entries: { 'a.txt': { text: 'x' } } } };
  const st = loadFixtures(fx);
  assert.equal(st.mail.messages[0].id, 'MSG-1');
  assert.deepEqual(st.mac, { events: [], reminders: [], notes: [{ name: 'a', body: 'b' }] });
  assert.notEqual(st.mac, fx.mac, 'a copy, never the task data itself');
  assert.deepEqual(Object.keys(st.files.entries), ['a.txt']);
  assert.equal(st.files.entries['a.txt'].text, 'x');
  assert.equal(fixture.messages.length, 1, 'init never changes the fixture');
  assert.throws(() => loadFixtures({ bank: {} }), /no fixture app named bank/);
  assert.throws(() => loadFixtures({ mail: {} }), /needs user.email/);
});
