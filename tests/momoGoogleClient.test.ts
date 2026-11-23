// MoMo Google read client and send-only step (shared/momoGoogle/client.ts, send.ts) through googleapis against a fake Google: windows, caps, error classes, grants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BODY_CAP, createGoogleClient, GOOGLE_ENDPOINTS, startOfDayIn } from '../shared/momoGoogle/client.mjs';
import { AccountError } from '../shared/momoGoogle/account.mjs';
import { createSender, createSendGrants, messageDigest, type OutgoingMessage } from '../shared/momoGoogle/send.mjs';
import { READ_SCOPES, SEND_SCOPE } from '../shared/momoGoogle/types.mjs';
import { startFake, type FakeAnswer, type FakeRequest } from './support/fakeGoogle.ts';
import { makeAccount, memoryFile, NOW, record } from './support/googleAccountKit.ts';

const DAY = 86_400_000;
const b64 = (s: string) => Buffer.from(s).toString('base64url');

async function rig(handler: (r: FakeRequest) => FakeAnswer | undefined, file = memoryFile(record()), timeZone = 'UTC') {
  const fake = await startFake(handler);
  const kit = makeAccount({ config: fake.config, fetch: fake.fetch, file });
  const client = createGoogleClient({
    account: kit.account,
    now: () => kit.clock.t,
    endpoints: { gmail: `${fake.url}/`, calendar: `${fake.url}/` },
    timeZone,
    sleep: async () => undefined,
  });
  return { fake, kit, client };
}

test('listThreads asks for the window without spam or trash, never before 30 days ahead of the connect day', async () => {
  const { fake, client } = await rig(() => ({ body: { threads: [{ id: 't1' }, {}, { id: 't2' }], nextPageToken: 'np' } }));
  try {
    const page = await client.listThreads({ afterMs: NOW - 90 * DAY, beforeMs: NOW, maxResults: 20, pageToken: 'p1' });
    assert.deepEqual(page, { threadIds: ['t1', 't2'], nextPageToken: 'np' });
    const r = fake.requests[0] as FakeRequest;
    assert.equal(r.auth, 'Bearer at');
    assert.equal(r.query.get('q'), `after:${(NOW - 30 * DAY) / 1000} before:${NOW / 1000} -in:spam -in:trash`);
    assert.equal(r.query.get('maxResults'), '20');
    assert.equal(r.query.get('pageToken'), 'p1');
    await client.listThreads({ afterMs: NOW - 5 * DAY, beforeMs: NOW, maxResults: 1 });
    assert.match(fake.requests[1]?.query.get('q') ?? '', new RegExp(`^after:${(NOW - 5 * DAY) / 1000} `));
  } finally {
    await fake.close();
  }
});

test('an empty listing answers, and a source that is not connected fails the usual way', async () => {
  const { fake, client, kit } = await rig(() => ({ body: {} }));
  try {
    assert.deepEqual(await client.listThreads({ afterMs: 0, beforeMs: NOW, maxResults: 5 }), { threadIds: [] });
    kit.file.value = null;
    await assert.rejects(client.listThreads({ afterMs: 0, beforeMs: NOW, maxResults: 5 }), (e: AccountError) => e.code === 'not_connected');
  } finally {
    await fake.close();
  }
});

test('getThreadMeta maps the minimal read and answers null for a missing thread', async () => {
  const { fake, client } = await rig((r) =>
    r.path.endsWith('/gone')
      ? { status: 404, body: { error: { code: 404 } } }
      : r.path.endsWith('/bare')
        ? { body: {} }
        : {
            body: {
              id: 't1',
              historyId: '9',
              messages: [
                { id: 'm1', internalDate: '5', labelIds: ['INBOX'] },
                { id: 'm2', internalDate: '6' },
              ],
            },
          },
  );
  try {
    assert.deepEqual(await client.getThreadMeta('t1'), {
      id: 't1',
      historyId: '9',
      messages: [
        { id: 'm1', internalDate: '5', labelIds: ['INBOX'] },
        { id: 'm2', internalDate: '6' },
      ],
    });
    assert.equal(await client.getThreadMeta('gone'), null);
    assert.deepEqual(await client.getThreadMeta('bare'), { id: 'bare', messages: [] });
    assert.equal(fake.requests[0]?.query.get('format'), 'minimal');
  } finally {
    await fake.close();
  }
});

test('listEvents clamps to the connect day and 92 days ahead, keeps only the fields the pipeline reads, and returns nothing for an empty window', async () => {
  const item = {
    id: 'e1',
    etag: '"1"',
    status: 'confirmed',
    summary: 'Standup',
    updated: 'u',
    start: { dateTime: 'a' },
    end: { dateTime: 'b' },
    organizer: { email: 'o@x.com', self: true, displayName: 'drop' },
    attendees: [{ email: 'a@x.com', responseStatus: 'accepted', extra: 1 }],
    conferenceData: 'drop',
    description: null,
  };
  const { fake, client } = await rig(() => ({ body: { items: [item, { id: 'e2' }], nextPageToken: 'n' } }));
  try {
    const out = await client.listEvents({
      showDeleted: true,
      timeMin: new Date(NOW - 40 * DAY).toISOString(),
      timeMax: new Date(NOW + 400 * DAY).toISOString(),
      updatedMin: 'U',
      maxResults: 50,
      pageToken: 'p',
    });
    assert.deepEqual(out.events[0], {
      id: 'e1',
      etag: '"1"',
      status: 'confirmed',
      summary: 'Standup',
      updated: 'u',
      start: { dateTime: 'a' },
      end: { dateTime: 'b' },
      organizer: { email: 'o@x.com', self: true },
      attendees: [{ email: 'a@x.com', self: undefined, responseStatus: 'accepted' }],
    });
    assert.deepEqual(out.events[1], { id: 'e2', status: 'confirmed' });
    assert.equal(out.nextPageToken, 'n');
    const q = (fake.requests[0] as FakeRequest).query;
    assert.equal(q.get('timeMin'), new Date(Math.floor(NOW / DAY) * DAY).toISOString());
    assert.equal(q.get('timeMax'), new Date(NOW + 92 * DAY).toISOString());
    assert.equal(q.get('singleEvents'), 'true');
    assert.equal(q.get('showDeleted'), 'true', 'deleted and cancelled events are asked for');
    assert.equal(q.get('updatedMin'), 'U');
    assert.equal(q.get('calendarId'), null);
    assert.deepEqual(
      await client.listEvents({
        showDeleted: true,
        timeMin: new Date(NOW + 200 * DAY).toISOString(),
        timeMax: new Date(NOW + 300 * DAY).toISOString(),
        maxResults: 5,
      }),
      { events: [] },
    );
    assert.equal(fake.requests.length, 1);
  } finally {
    await fake.close();
  }
});

test('listEvents on a missing calendar is empty; calendarEtag returns the probe and fails without one', async () => {
  let answer: FakeAnswer = { status: 410, body: {} };
  const { fake, client } = await rig(() => answer);
  try {
    const span = {
      showDeleted: true as const,
      timeMin: new Date(NOW).toISOString(),
      timeMax: new Date(NOW + DAY).toISOString(),
      maxResults: 5,
    };
    assert.deepEqual(await client.listEvents(span), { events: [] });
    answer = { body: { etag: '"cal"' } };
    assert.equal(await client.calendarEtag(), '"cal"');
    const probe = fake.requests.at(-1) as FakeRequest;
    assert.match(probe.path, /\/calendars\/primary\/events$/, "the etag is the events collection's, not the calendar list's");
    assert.deepEqual([probe.query.get('fields'), probe.query.get('maxResults'), probe.query.get('showDeleted')], ['etag', '1', 'true']);
    answer = { body: {} };
    await assert.rejects(client.calendarEtag(), /no etag/);
  } finally {
    await fake.close();
  }
});

const mail = (over: Record<string, unknown>) => ({
  id: 'm2',
  threadId: 't1',
  internalDate: String(NOW),
  labelIds: ['INBOX'],
  payload: {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass header.from=bank.com' },
      { name: 'Authentication-Results', value: 'evil.example; dmarc=pass' },
      { name: 'Authentication-Results', value: ' mx.google.com ; spf=pass' },
      { name: 'From', value: 'Bank <noreply@bank.com>' },
      { name: 'From', value: 'second' },
      { name: 'To', value: '"Doe, Jane" <j@x.com>, k@x.com' },
      { name: 'Cc', value: 'c@x.com' },
      { name: 'Subject', value: 'Hi' },
      { name: 'X-Secret', value: 'dropped' },
      { name: null, value: 'x' },
      { name: 'Date', value: null },
    ],
    parts: [
      { mimeType: 'text/html', body: { data: b64('<p>html</p>') } },
      { mimeType: 'text/plain', body: { data: b64('plain body') } },
    ],
  },
  ...over,
});

test('getMail returns the newest visible message with whitelisted headers, Gmail-only authentication results, labels and a plain body', async () => {
  const { fake, client } = await rig(() => ({
    body: {
      id: 't1',
      messages: [
        mail({ id: 'old', internalDate: String(NOW - 1000) }),
        mail({}),
        mail({ id: 'draft', internalDate: String(NOW + 5), labelIds: ['DRAFT'] }),
      ],
    },
  }));
  try {
    const m = await client.getMail('t1');
    assert.deepEqual(m, {
      id: 'm2',
      threadId: 't1',
      from: 'Bank <noreply@bank.com>',
      to: ['"Doe, Jane" <j@x.com>', 'k@x.com'],
      cc: ['c@x.com'],
      subject: 'Hi',
      date: new Date(NOW).toISOString(),
      headers: {
        from: 'Bank <noreply@bank.com>',
        to: '"Doe, Jane" <j@x.com>, k@x.com',
        cc: 'c@x.com',
        subject: 'Hi',
        'authentication-results': 'mx.google.com; dmarc=pass header.from=bank.com\n mx.google.com ; spf=pass',
      },
      labels: ['INBOX'],
      body: 'plain body',
    });
    assert.equal(fake.requests[0]?.query.get('format'), 'full');
  } finally {
    await fake.close();
  }
});

test('getMail falls back to stripped html, caps the body, and says null for a gone thread or one with only hidden messages', async () => {
  const html = '<style>p{}</style><script>x()</script><p>Hello&nbsp;<b>there</b></p>';
  const big = 'x'.repeat(BODY_CAP + 50);
  let answer: FakeAnswer = {
    body: { messages: [{ id: 'm', internalDate: String(NOW), payload: { mimeType: 'text/html', body: { data: b64(html) } } }] },
  };
  const { fake, client } = await rig(() => answer);
  try {
    const m = await client.getMail('t1');
    assert.equal(m?.body, 'Hello there');
    assert.equal(m?.threadId, 't1');
    assert.deepEqual([m?.from, m?.to, m?.cc, m?.labels], ['', [], [], []]);
    answer = {
      body: { messages: [{ id: 'm', internalDate: String(NOW), payload: { mimeType: 'text/plain', body: { data: b64(big) } } }] },
    };
    assert.equal((await client.getMail('t1'))?.body.length, BODY_CAP);
    answer = { body: { messages: [{ id: 'm', internalDate: String(NOW), payload: { mimeType: 'image/png' } }] } };
    assert.equal((await client.getMail('t1'))?.body, '');
    answer = { body: { messages: [{ id: 'm', internalDate: String(NOW) }] } };
    assert.equal((await client.getMail('t1'))?.body, '');
    answer = { body: { messages: [{ id: 's', internalDate: '1', labelIds: ['SPAM'] }, { internalDate: '2' }] } };
    assert.equal(await client.getMail('t1'), null);
    answer = { body: {} };
    assert.equal(await client.getMail('t1'), null);
    answer = { status: 404, body: {} };
    assert.equal(await client.getMail('t1'), null);
  } finally {
    await fake.close();
  }
});

const msg: OutgoingMessage = {
  to: ['a@x.com'],
  cc: ['c@x.com'],
  subject: 'Re: Plans ✓',
  body: 'Sounds good — see you.',
  threadId: 't9',
  inReplyTo: '<m1@x>',
  references: '<m0@x> <m1@x>',
};

test("send needs the send scope, the gate's single-use grant for this exact message, and sends a threaded UTF-8 mail", async () => {
  const grants = createSendGrants(() => NOW);
  const { fake, kit } = await rig(
    (r) => (r.path.endsWith('/messages/send') ? { body: { id: 'sent-1' } } : undefined),
    memoryFile(record({ tokens: { ...record().tokens, scopes: [...READ_SCOPES, SEND_SCOPE] } })),
  );
  try {
    const sender = createSender({ account: kit.account, redeem: grants.redeem, endpoint: `${fake.url}/` });
    assert.equal(await sender.canSend(), true);
    assert.deepEqual(await sender.send(msg, undefined), { ok: false, reason: 'no_permission' });
    assert.deepEqual(await sender.send(msg, 'guess'), { ok: false, reason: 'no_permission' });
    const grant = grants.mint(messageDigest(msg));
    assert.deepEqual(
      await sender.send({ ...msg, body: 'changed' }, grant),
      { ok: false, reason: 'no_permission' },
      'a grant is for one message and is spent by a try',
    );
    assert.equal(fake.requests.length, 0);
    const again = grants.mint(messageDigest(msg));
    assert.deepEqual(await sender.send(msg, again), { ok: true, id: 'sent-1' });
    assert.deepEqual(await sender.send(msg, again), { ok: false, reason: 'no_permission' });
    const sent = fake.requests[0] as FakeRequest;
    assert.equal(sent.json.threadId, 't9');
    const raw = Buffer.from(sent.json.raw, 'base64url').toString('utf8');
    assert.match(raw, /^From: me@example\.com\r\nTo: a@x\.com\r\nCc: c@x\.com\r\nSubject: =\?UTF-8\?B\?/);
    assert.match(raw, /In-Reply-To: <m1@x>\r\nReferences: <m0@x> <m1@x>\r\n/);
    assert.equal(Buffer.from(raw.split('\r\n\r\n')[1] ?? '', 'base64').toString('utf8'), msg.body);
    assert.equal(
      Buffer.from((raw.match(/Subject: =\?UTF-8\?B\?(.*)\?=/) as RegExpMatchArray)[1] as string, 'base64').toString('utf8'),
      msg.subject,
    );
  } finally {
    await fake.close();
  }
});

test('a plain new mail has no thread or reply headers; a long body is wrapped at 76 characters', async () => {
  const grants = createSendGrants(() => NOW);
  const { fake, kit } = await rig(
    () => ({ body: { id: 'n1' } }),
    memoryFile(record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] } })),
  );
  try {
    const sender = createSender({ account: kit.account, redeem: grants.redeem, endpoint: `${fake.url}/` });
    const m: OutgoingMessage = { to: ['a@x.com'], subject: 'Hello', body: 'z'.repeat(200) };
    assert.deepEqual(await sender.send(m, grants.mint(messageDigest(m))), { ok: true, id: 'n1' });
    const sent = fake.requests[0] as FakeRequest;
    assert.equal(sent.json.threadId, undefined);
    const raw = Buffer.from(sent.json.raw, 'base64url').toString('utf8');
    assert.ok(!raw.includes('In-Reply-To') && !raw.includes('Cc:'));
    assert.ok((raw.split('\r\n\r\n')[1] as string).split('\r\n').every((l) => l.length <= 76));
  } finally {
    await fake.close();
  }
});

test('without the send scope the capability says not_granted and sends nothing; an unconnected or ended account says so', async () => {
  const grants = createSendGrants(() => NOW);
  const { fake, kit } = await rig(() => ({ body: { id: 'x' } }));
  try {
    const sender = createSender({ account: kit.account, redeem: grants.redeem, endpoint: `${fake.url}/` });
    assert.equal(await sender.canSend(), false);
    assert.deepEqual(await sender.send(msg, grants.mint(messageDigest(msg))), { ok: false, reason: 'not_granted' });
    kit.file.value = null;
    assert.deepEqual(await sender.send(msg, 'g'), { ok: false, reason: 'not_granted' });
    kit.file.value = record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] }, needsSignIn: { cause: 'revoked', since: 1 } });
    assert.equal(await sender.canSend(), false);
    assert.deepEqual(await sender.send(msg, 'g'), { ok: false, reason: 'needs_sign_in' });
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('injection in a header value or a bad address is refused before the grant is spent; grants expire', async () => {
  let t = NOW;
  const grants = createSendGrants(() => t);
  const { fake, kit } = await rig(
    () => ({ body: { id: 'x' } }),
    memoryFile(record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] } })),
  );
  try {
    const sender = createSender({ account: kit.account, redeem: grants.redeem, endpoint: `${fake.url}/` });
    const bad: OutgoingMessage[] = [
      { ...msg, subject: 'x\r\nBcc: evil@x.com' },
      { ...msg, to: ['a@x.com\r\nBcc: e@x.com'] },
      { ...msg, to: [] },
      { ...msg, cc: ['not an address'] },
      { ...msg, inReplyTo: '<a>\nX: y' },
    ];
    for (const m of bad) {
      const g = grants.mint(messageDigest(m));
      assert.deepEqual(await sender.send(m, g), { ok: false, reason: 'invalid' });
      assert.equal(grants.redeem(g, messageDigest(m)), true, 'the grant was not burned');
    }
    const old = grants.mint(messageDigest(msg));
    t += 10 * 60_000;
    assert.deepEqual(await sender.send(msg, old), { ok: false, reason: 'no_permission' });
    grants.mint('x');
    t += 11 * 60_000;
    grants.mint('y');
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('Google refusing the send ends the grant (401/403) or reports failure (5xx, no id, expired source)', async () => {
  let answer: FakeAnswer = { status: 403, body: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } } };
  const grants = createSendGrants(() => NOW);
  const { fake, kit } = await rig(() => answer, memoryFile(record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] } })));
  try {
    const sender = createSender({ account: kit.account, redeem: grants.redeem, endpoint: `${fake.url}/` });
    const go = () => sender.send(msg, grants.mint(messageDigest(msg)));
    assert.deepEqual(await go(), { ok: false, reason: 'needs_sign_in' });
    assert.equal((await kit.account.status()).state, 'needs_sign_in');
    kit.file.value = record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] } });
    answer = { status: 401, body: {} };
    assert.deepEqual(await go(), { ok: false, reason: 'needs_sign_in' });
    kit.file.value = record({ tokens: { ...record().tokens, scopes: [SEND_SCOPE] } });
    answer = { status: 500, body: {} };
    assert.deepEqual(await go(), { ok: false, reason: 'failed' });
    answer = { body: {} };
    assert.deepEqual(await go(), { ok: false, reason: 'failed' });
    // the token cannot be refreshed: the account ends during the call
    kit.clock.t = NOW + 2 * 3_600_000;
    answer = { status: 400, body: { error: 'invalid_grant' } };
    assert.deepEqual(await go(), { ok: false, reason: 'needs_sign_in' });
  } finally {
    await fake.close();
  }
});

test('the real endpoints are the public Gmail and Calendar hosts', () => {
  assert.deepEqual(GOOGLE_ENDPOINTS, { gmail: 'https://gmail.googleapis.com/', calendar: 'https://www.googleapis.com/' });
});

test("the calendar floor is the start of the connect day in the home's time zone, and the list answers its etag", async () => {
  const { fake, client } = await rig(() => ({ body: { items: [], etag: '"list-etag"' } }), memoryFile(record()), 'Asia/Tokyo');
  try {
    const out = await client.listEvents({
      showDeleted: true,
      timeMin: new Date(NOW - 40 * DAY).toISOString(),
      timeMax: new Date(NOW + 5 * DAY).toISOString(),
      maxResults: 5,
    });
    // NOW is 2026-11-24 10:00Z, which is 19:00 on the 24th in Tokyo: that day began at 15:00Z the day before
    assert.equal(fake.requests[0]?.query.get('timeMin'), '2026-11-23T15:00:00.000Z');
    assert.deepEqual(out, { events: [], etag: '"list-etag"' });
  } finally {
    await fake.close();
  }
});

test('startOfDayIn finds local midnight, also on days that are 23 or 25 hours long', () => {
  const at = (iso: string, tz: string) => new Date(startOfDayIn(Date.parse(iso), tz)).toISOString();
  assert.equal(at('2026-11-24T10:00:00Z', 'UTC'), '2026-11-24T00:00:00.000Z');
  assert.equal(at('2026-11-24T10:00:00.900Z', 'Asia/Tokyo'), '2026-11-23T15:00:00.000Z');
  assert.equal(at('2026-11-24T00:00:00Z', 'America/New_York'), '2026-11-23T05:00:00.000Z');
  // spring forward (New York, 2026-03-08, 23 hours): 15:00Z is 11:00 EDT and the day began at 05:00Z
  assert.equal(at('2026-03-08T15:00:00Z', 'America/New_York'), '2026-03-08T05:00:00.000Z');
  // fall back (2026-11-01, 25 hours): 15:00Z is 10:00 EST and the day began at 04:00Z
  assert.equal(at('2026-11-01T15:00:00Z', 'America/New_York'), '2026-11-01T04:00:00.000Z');
  // exactly at midnight
  assert.equal(at('2026-03-08T05:00:00Z', 'America/New_York'), '2026-03-08T05:00:00.000Z');
});
