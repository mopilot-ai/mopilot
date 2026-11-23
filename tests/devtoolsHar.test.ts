// browser_har (harRecorder.cjs): CDP Network events become a HAR 1.2 with secrets redacted, bodies kept only for ordinary pages, caps, redirects, tab following and turn end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HarRecorder,
  maskPost,
  maskJson,
  headersOf,
  timingsOf,
  REDACTED,
  MAX_ENTRIES,
  MAX_BODY,
  MAX_BODIES,
} = require('../electron/capabilities/browser/devtools/harRecorder.cjs');

type Bodies = Record<string, any>;
function makeTab(o: { chatId?: string; url?: string; title?: string; password?: any; bodies?: Bodies; noDebugger?: boolean } = {}) {
  const dbg = new EventEmitter();
  const calls: any[][] = [];
  const tab: any = {
    id: 't1',
    chatId: o.chatId ?? 'c1',
    url: 'url' in o ? o.url : 'https://example.com/',
    title: o.title ?? 'Example',
    password: o.password ?? false,
    bodies: o.bodies ?? {},
    backend: o.noDebugger ? {} : { debugger: dbg },
    calls,
    dbg,
    send: async (method: string, params: any, sessionId?: string) => {
      calls.push([method, params, sessionId]);
      if (method === 'Runtime.evaluate') return { result: { value: tab.password } };
      const b = tab.bodies[params.requestId];
      if (b instanceof Error) throw b;
      return b;
    },
  };
  return tab;
}
const emit = (tab: any, method: string, params: any, sessionId?: string) =>
  sessionId === undefined ? tab.dbg.emit('message', {}, method, params) : tab.dbg.emit('message', {}, method, params, sessionId);
const req = (tab: any, requestId: string, request: any = {}, extra: any = {}, sessionId?: string) =>
  emit(
    tab,
    'Network.requestWillBeSent',
    {
      requestId,
      timestamp: 100,
      wallTime: 1700000000,
      type: 'XHR',
      request: { method: 'POST', url: 'https://example.com/api', ...request },
      ...extra,
    },
    sessionId,
  );
const res = (tab: any, requestId: string, response: any, sessionId?: string) =>
  emit(tab, 'Network.responseReceived', { requestId, response }, sessionId);
const fin = (tab: any, requestId: string, extra: any = {}, sessionId?: string) =>
  emit(tab, 'Network.loadingFinished', { requestId, timestamp: 100.5, encodedDataLength: 321, ...extra }, sessionId);
async function begin(o: any = {}, rec: any = {}) {
  const tab = makeTab(o);
  const r = new HarRecorder(rec);
  await r.start(tab.chatId, tab);
  return { tab, r, recording: r.chats.get(tab.chatId) };
}

test('a full request lifecycle becomes a HAR 1.2 entry', async () => {
  const { tab, r, recording } = await begin({
    bodies: { a: { body: '{"ok":1}' }, b: { body: Buffer.from('hello').toString('base64'), base64Encoded: true } },
  });
  req(tab, 'a', {
    url: 'https://example.com/api?q=1&token=abc',
    headers: { 'Content-Type': 'application/json', Cookie: 'sid=1', Authorization: 'Bearer x', 'X-Api-Key': 'k', Accept: 'a' },
    postData: '{"user":"u","password":"p","nested":{"cardNumber":1,"list":[{"otp":2},3]}}',
  });
  res(tab, 'a', {
    status: 302,
    statusText: 'Found',
    protocol: 'h2',
    remoteIPAddress: '1.2.3.4',
    mimeType: 'application/json',
    encodedDataLength: 5,
    headers: { Location: 'https://example.com/next?token=z', 'Set-Cookie': 's=1' },
    timing: {
      requestTime: 100.1,
      dnsStart: 0,
      dnsEnd: 5,
      connectStart: 5,
      connectEnd: 20,
      sslStart: 10,
      sslEnd: 20,
      sendStart: 21,
      sendEnd: 22,
      receiveHeadersEnd: 100,
    },
  });
  fin(tab, 'a');
  req(tab, 'b', { method: undefined, url: undefined }, { wallTime: undefined, type: undefined });
  res(tab, 'b', { mimeType: 'text/plain' });
  fin(tab, 'b', { encodedDataLength: undefined });
  const har = await r.har(recording, '9.9');
  assert.equal(har.log.version, '1.2');
  assert.deepEqual(har.log.creator, { name: 'MoPilot', version: '9.9' });
  assert.equal(har.log.pages.length, 1);
  assert.equal(har.log.pages[0].title, 'Example');
  assert.equal(har.log.comment, undefined);
  const a = har.log.entries.find((e: any) => e.request.url.includes('/api?q'));
  assert.equal(a.pageref, 'page_1');
  assert.equal(a.startedDateTime, new Date(1700000000 * 1000).toISOString());
  assert.equal(a._resourceType, 'xhr');
  assert.equal(a.serverIPAddress, '1.2.3.4');
  assert.equal(a.request.httpVersion, 'H2');
  assert.equal(a.response.status, 302);
  assert.equal(a.response.statusText, 'Found');
  assert.ok(!a.request.url.includes('abc'));
  assert.deepEqual(
    a.request.queryString.map((q: any) => q.name),
    ['q', 'token'],
  );
  const hv = Object.fromEntries(a.request.headers.map((h: any) => [h.name, h.value]));
  assert.deepEqual([hv.Cookie, hv.Authorization, hv['X-Api-Key'], hv.Accept], [REDACTED, REDACTED, REDACTED, 'a']);
  assert.equal(a.response.headers.find((h: any) => h.name === 'Set-Cookie').value, REDACTED);
  assert.ok(!a.response.redirectURL.includes('=z'));
  assert.ok(a.response.redirectURL.startsWith('https://example.com/next'));
  assert.equal(a.request.postData.mimeType, 'application/json');
  assert.deepEqual(JSON.parse(a.request.postData.text), {
    user: 'u',
    password: REDACTED,
    nested: { cardNumber: REDACTED, list: [{ otp: REDACTED }, 3] },
  });
  assert.equal(a.request.bodySize, Buffer.byteLength('{"user":"u","password":"p","nested":{"cardNumber":1,"list":[{"otp":2},3]}}'));
  assert.equal(a.response.bodySize, 321);
  assert.equal(a.response.content.text, '{"ok":1}');
  assert.equal(a.response.content.size, 8);
  assert.ok(a.time > 0);
  assert.equal(a.timings.ssl, 10);
  const b = har.log.entries.find((e: any) => e !== a);
  assert.equal(b.request.method, 'GET');
  assert.equal(b.request.postData, undefined);
  assert.equal(b.request.bodySize, 0);
  assert.equal(b._resourceType, '');
  assert.equal(b.response.bodySize, -1);
  assert.equal(b.response.httpVersion, 'HTTP/1.1');
  assert.equal(b.response.status, 0);
  assert.ok(Number.isFinite(Date.parse(b.startedDateTime)));
  assert.equal(b.serverIPAddress, undefined);
});

test('base64 response bodies keep their decoded size and encoding', async () => {
  const { tab, r, recording } = await begin({ bodies: { b: { body: Buffer.from('hello').toString('base64'), base64Encoded: true } } });
  req(tab, 'b', { method: 'GET' });
  res(tab, 'b', { mimeType: 'application/json', encodedDataLength: 'x' });
  fin(tab, 'b');
  const [e] = (await r.har(recording, '1')).log.entries;
  assert.equal(e.response.content.encoding, 'base64');
  assert.equal(e.response.content.size, 5);
  assert.equal(e.response.content.text, Buffer.from('hello').toString('base64'));
  assert.deepEqual(tab.calls.at(-1), ['Network.getResponseBody', { requestId: 'b' }, '']);
});

test('entries are sorted by start time and sessioned events use their own key', async () => {
  const { tab, r, recording } = await begin();
  req(tab, 'late', { method: 'GET' }, { wallTime: 1700000100 });
  req(tab, 'early', { method: 'GET', url: 'https://example.com/early' }, { wallTime: 1700000000 }, 'S1');
  req(tab, 'same', { method: 'GET', url: 'https://example.com/same' }, { wallTime: 1700000100 });
  req(tab, 'same2', { method: 'GET', url: 'https://example.com/same2' }, { wallTime: 1700000100 });
  res(tab, 'early', { mimeType: 'text/html', status: 200 }, 'S1');
  res(tab, 'early', { status: 500 });
  const entries = (await r.har(recording, '1')).log.entries;
  assert.equal(entries[0].request.url, 'https://example.com/early');
  assert.equal(entries[0].response.status, 200);
  assert.equal(entries.length, 4);
});

test('post bodies: masking forms, JSON fallbacks and long text', () => {
  assert.equal(
    maskPost('user=u&password=p&token=t&x=1', 'application/x-www-form-urlencoded'),
    `user=u&password=${REDACTED}&token=${REDACTED}&x=1`,
  );
  assert.equal(maskPost('{bad', 'application/json'), '{bad');
  const long = 'x'.repeat(70 * 1024);
  const cut = maskPost(long, 'text/plain');
  assert.ok(cut.endsWith('…'));
  assert.ok(cut.length < long.length);
  assert.equal(maskPost('{bad' + long, 'application/json').endsWith('…'), true);
  assert.equal(maskPost('short', ''), 'short');
  assert.deepEqual(maskJson([{ pin: 1, a: null }, 'x', null, 3]), [{ pin: REDACTED, a: null }, 'x', null, 3]);
  assert.deepEqual(headersOf(undefined), []);
  assert.deepEqual(headersOf({ 'X-CSRF-Token': 1, A: 2, Referer: 'https://a.example/cb?code=s3cret&x=1' }), [
    { name: 'X-CSRF-Token', value: REDACTED },
    { name: 'A', value: '2' },
    // a URL-valued header keeps its page, not its secrets
    { name: 'Referer', value: 'https://a.example/cb?code=REDACTED&x=1' },
  ]);
  assert.ok(MAX_ENTRIES > 0 && MAX_BODY > 0 && MAX_BODIES > MAX_BODY);
});

test('a long form-less text post is cut in the HAR', async () => {
  const { tab, r, recording } = await begin();
  req(tab, 'p', { headers: { 'content-type': 'text/plain' }, postData: 'y'.repeat(70 * 1024) });
  const [e] = (await r.har(recording, '1')).log.entries;
  assert.ok(e.request.postData.text.endsWith('…'));
});

test('posts are left out on a password page, a high-risk page and credentials; bodies too', async () => {
  const cases: any[] = [
    [{ password: true }, {}],
    [{}, { riskOf: () => ({ level: 'high' }) }],
    [{}, { riskOf: () => ({ level: 'normal', credentials: true }) }],
    [{ url: '' }, {}],
  ];
  for (const [tabOpts, rOpts] of cases) {
    const { tab, r, recording } = await begin({ ...tabOpts, bodies: { a: { body: 'secret' } } }, rOpts);
    req(tab, 'a', { postData: 'password=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    res(tab, 'a', { mimeType: 'text/html' });
    fin(tab, 'a');
    const [e] = (await r.har(recording, '1')).log.entries;
    assert.deepEqual(e.request.postData, {
      mimeType: 'application/x-www-form-urlencoded',
      text: '',
      comment: 'left out: a sign-in or high-risk page',
    });
    assert.equal(e.response.content.text, undefined);
    assert.ok(!tab.calls.some((c: any[]) => c[0] === 'Network.getResponseBody'));
  }
});

test('response bodies only for text MIME and within caps', async () => {
  const { tab, r, recording } = await begin(
    {
      bodies: {
        img: { body: 'zz' },
        big: { body: 'x'.repeat(20) },
        ok1: { body: 'aaaa' },
        ok2: { body: 'bbbb' },
        ok3: { body: 'cc' },
        bad: new Error('gone'),
        none: undefined,
      },
    },
    { maxBody: 10, maxBodies: 8 },
  );
  const go = (id: string, mimeType: string) => {
    req(tab, id, { method: 'GET' });
    res(tab, id, { mimeType });
    fin(tab, id);
  };
  go('img', 'image/png');
  go('big', 'text/html');
  go('ok1', 'text/css');
  go('ok2', 'application/ld+json');
  go('ok3', 'application/xml'); // 4 + 4 + 2 > 8 -> too large
  go('bad', 'text/plain');
  go('none', 'text/plain');
  const entries = (await r.har(recording, '1')).log.entries;
  const by = (id: string) => entries[recording.order.indexOf(`:${id}`)];
  const content = (id: string) => entries.find((e: any) => e === recording.entries.get(`:${id}`).har).response.content;
  assert.equal(content('img').text, undefined);
  assert.equal(content('big').comment, 'body left out: too large');
  assert.equal(content('ok1').text, 'aaaa');
  assert.equal(content('ok2').text, 'bbbb');
  assert.equal(content('ok3').comment, 'body left out: too large');
  assert.equal(content('bad').text, undefined);
  assert.equal(content('none').text, undefined);
  assert.ok(by('img'));
  // total cap reached: no further body is even requested
  const before = tab.calls.length;
  req(tab, 'more', { method: 'GET' });
  res(tab, 'more', { mimeType: 'text/plain' });
  fin(tab, 'more');
  assert.equal(recording.bodies, 8);
  assert.equal(tab.calls.length, before);
});

test('redirect hops are separate earlier entries', async () => {
  const { tab, r, recording } = await begin();
  req(tab, 'r', { method: 'GET', url: 'https://example.com/a' }, { timestamp: 10 });
  req(
    tab,
    'r',
    { method: 'GET', url: 'https://example.com/b' },
    { timestamp: 11, redirectResponse: { status: 301, headers: { location: 'https://example.com/b' } } },
  );
  res(tab, 'r', { status: 200, mimeType: 'text/html' });
  fin(tab, 'r');
  req(tab, 'r', { method: 'GET', url: 'https://example.com/c' }); // same id again without redirectResponse
  const entries = (await r.har(recording, '1')).log.entries;
  assert.equal(entries.length, 2);
  const first = entries.find((e: any) => e.request.url.endsWith('/a'));
  assert.equal(first.response.status, 301);
  assert.equal(first.response.redirectURL, 'https://example.com/b');
  assert.equal(recording.entries.get(':r').hop, 2);
  assert.ok(recording.entries.has(':r#1'));
});

test('loadingFailed, unknown ids and events after stop are handled', async () => {
  const { tab, r, recording } = await begin();
  req(tab, 'x', { method: 'GET' });
  req(tab, 'y', { method: 'GET' });
  req(tab, 'z', { method: 'GET' });
  emit(tab, 'Network.loadingFailed', { requestId: 'x', timestamp: 100.2, canceled: true });
  emit(tab, 'Network.loadingFailed', { requestId: 'y', timestamp: 100.2, errorText: 'net::ERR_X' });
  emit(tab, 'Network.loadingFailed', { requestId: 'z' });
  emit(tab, 'Network.loadingFailed', { requestId: 'nope' });
  emit(tab, 'Network.loadingFinished', { requestId: 'nope' });
  emit(tab, 'Network.responseReceived', { requestId: 'nope' });
  emit(tab, 'Network.dataReceived', { requestId: 'x' });
  emit(tab, 'Network.loadingFinished', {});
  const g = (id: string) => recording.entries.get(`:${id}`).har;
  assert.equal(g('x').response._error, 'canceled');
  assert.equal(g('y').response._error, 'net::ERR_X');
  assert.equal(g('z').response._error, 'failed');
  assert.equal(g('z').time, 0);
  const stopped = r.stop('c1');
  assert.equal(stopped, recording);
  emit(tab, 'Network.requestWillBeSent', { requestId: 'late' }); // listener gone
  r.event(recording, tab, 'Network.requestWillBeSent', { requestId: 'late' }, ''); // and a stale call is ignored too
  assert.equal(recording.entries.has(':late'), false);
  assert.equal(r.stop('c1'), null);
});

test('maxEntries drops later requests and says so in the log', async () => {
  const { tab, r, recording } = await begin({}, { maxEntries: 1 });
  req(tab, 'a', { method: 'GET' });
  req(tab, 'b', { method: 'GET' });
  req(tab, 'c', { method: 'GET' });
  const { log } = await r.har(recording, '1');
  assert.equal(log.entries.length, 1);
  assert.equal(log.comment, '2 later requests were left out (at most 1).');
});

test('the main frame navigation adds a page; child and sessioned frames do not', async () => {
  const { tab, r, recording } = await begin({ url: 'https://example.com/', title: '' });
  emit(tab, 'Page.frameNavigated', { frame: { url: 'https://example.com/two' } });
  emit(tab, 'Page.frameNavigated', { frame: { url: 'https://example.com/child', parentId: 'p' } });
  emit(tab, 'Page.frameNavigated', { frame: { url: 'https://example.com/s' } }, 'S1');
  emit(tab, 'Page.frameNavigated', {});
  req(tab, 'a', { method: 'GET' });
  const { log } = await r.har(recording, '1');
  assert.equal(log.pages.length, 3);
  assert.equal(log.pages[0].title, 'https://example.com/');
  assert.equal(log.pages[1].id, 'page_2');
  assert.equal(log.pages[2].title, '');
  assert.equal(log.entries[0].pageref, 'page_3');
});

test('the title falls back to an empty one with no url at all', async () => {
  const { r, recording } = await begin({ url: undefined, title: '' });
  assert.equal((await r.har(recording, '1')).log.pages[0].title, '');
});

test('timingsOf: absent timing, phases and ssl not double-counted', () => {
  assert.deepEqual(timingsOf(null, 1, 1.5), {
    time: 500,
    timings: { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 500, receive: 0 },
  });
  assert.equal(timingsOf(null, 2, 1).time, 0);
  const none = {
    requestTime: 1,
    dnsStart: -1,
    dnsEnd: -1,
    connectStart: -1,
    connectEnd: -1,
    sslStart: -1,
    sslEnd: -1,
    sendStart: 1,
    sendEnd: 2,
    receiveHeadersEnd: 5,
  };
  const a = timingsOf(none, 1, 1.1);
  assert.equal(a.timings.dns, -1);
  assert.equal(a.timings.connect, -1);
  assert.equal(a.timings.blocked, 1);
  const dnsOnly = timingsOf({ ...none, dnsStart: 0, dnsEnd: 3, sendStart: 4 }, 1, 1.1);
  assert.equal(dnsOnly.timings.dns, 3);
  assert.equal(dnsOnly.timings.blocked, 1);
  const full = timingsOf(
    { ...none, dnsStart: 0, dnsEnd: 3, connectStart: 3, connectEnd: 13, sslStart: 5, sslEnd: 13, sendStart: 14, sendEnd: 15 },
    1,
    1.1,
  );
  assert.equal(full.timings.ssl, 8);
  assert.equal(full.time, full.timings.blocked + 3 + 10 + 1 + full.timings.receive);
  const later = timingsOf({ ...none, requestTime: 0.5 }, 1, 1.1);
  assert.equal(later.timings.blocked, 1);
});

test('start replaces a recording, stop returns it, endTurn moves it to ended', async () => {
  const tab = makeTab();
  const r = new HarRecorder();
  assert.equal(await r.start('c1', tab), null);
  const first = r.chats.get('c1');
  req(tab, 'a', { method: 'GET' });
  const tab2 = makeTab();
  assert.equal(await r.start('c1', tab2), first);
  assert.equal(tab.dbg.listenerCount('message'), 0);
  r.endTurn('nobody');
  assert.equal(r.ended.size, 0);
  const second = r.chats.get('c1');
  r.endTurn('c1');
  assert.equal(r.chats.has('c1'), false);
  assert.equal(second.why, 'the turn ended');
  assert.equal(r.ended.get('c1'), second);
  assert.equal(r.stop('c1'), second);
  assert.equal(r.ended.size, 0);
  // a why already set is kept
  await r.start('c1', makeTab());
  const third = r.chats.get('c1');
  third.why = 'the cap';
  r.endTurn('c1');
  assert.equal(third.why, 'the cap');
  // starting again forgets an ended recording
  await r.start('c1', makeTab());
  assert.equal(r.ended.has('c1'), false);
});

test('touch: other chats, same debugger, new debugger, no debugger, errors', async () => {
  const r = new HarRecorder();
  const tab = makeTab();
  await r.touch(makeTab({ chatId: 'other' })); // a chat that does not record
  await r.start('c1', tab);
  assert.equal(tab.dbg.listenerCount('message'), 1);
  await r.touch(tab);
  assert.equal(tab.dbg.listenerCount('message'), 1);
  const rec = r.chats.get('c1');
  // a new debugger replaces the old listener (the old one has no removeListener to call)
  const bare = { on: (_e: string, _l: any) => {} };
  tab.backend.debugger = bare;
  await r.touch(tab);
  assert.equal(tab.dbg.listenerCount('message'), 0); // the old listener was removed
  assert.equal(rec.tabs.get(tab).dbg, bare);
  const real = new EventEmitter();
  const old = rec.tabs.get(tab).dbg;
  tab.backend.debugger = real;
  await r.touch(tab); // old is bare: no removeListener
  assert.equal(real.listenerCount('message'), 1);
  assert.notEqual(old, real);
  const emitter = new EventEmitter();
  tab.backend.debugger = emitter;
  await r.touch(tab);
  tab.backend.debugger = real;
  await r.touch(tab);
  assert.equal(emitter.listenerCount('message'), 0);
  assert.equal(rec.pages.length, 1);
  // a stop with a debugger that cannot remove listeners is fine
  r.stop('c1');
  // a tab with no debugger records nothing and does not fail
  await r.start('c2', makeTab({ chatId: 'c2', noDebugger: true }));
  assert.equal(r.chats.get('c2').tabs.size, 0);
  // an error is caught
  const boom = makeTab({ chatId: 'c2' });
  Object.defineProperty(boom, 'backend', {
    get: () => {
      throw new Error('gone');
    },
  });
  await r.touch(boom);
  assert.equal(r.chats.get('c2').tabs.has(boom), false);
});

test('requests and responses without a payload fall back to defaults', async () => {
  const { tab, r, recording } = await begin();
  emit(tab, 'Network.requestWillBeSent', { requestId: 'n' });
  emit(tab, 'Network.responseReceived', { requestId: 'n' });
  const [e] = (await r.har(recording, '1')).log.entries;
  assert.equal(e.request.method, 'GET');
  assert.equal(e.response.status, 0);
});
