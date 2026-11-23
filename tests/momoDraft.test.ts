// A draft MoMo wrote (shared/momoDraft.mjs): its words read the same everywhere (the tool, a saved note, a phone's row, an edit), refused rather than cut, and the one mailto link that hands it to the user's mail app, percent-encoded, capped and never another scheme.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODES,
  MAX_ADDRESS,
  MAX_BODY,
  MAX_MAILTO,
  MAX_SUBJECT,
  MAX_TO,
  draftLine,
  draftOf,
  isMailto,
  mailtoOf,
  readDraft,
  recipientsOf,
} from '../shared/momoDraft.mjs';

const ok = (input: unknown) => {
  const r = readDraft(input);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as any).draft;
};
const bad = (input: unknown, code: string) => {
  const r = readDraft(input);
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, code);
  assert.ok((r as any).why.length > 0 && (r as any).why.length < 100, 'a short line');
};

test('a draft keeps its addresses without repeats, its subject on one line and its body with plain line breaks', () => {
  assert.deepEqual(
    ok({ to: [' Sam@Example.com ', 'sam@example.com', 'lee@example.com', ''], subject: ' Re:\n  lunch ', body: 'Hi\r\nthere\rbye' }),
    {
      to: ['Sam@Example.com', 'lee@example.com'],
      subject: 'Re: lunch',
      body: 'Hi\nthere\nbye',
    },
  );
  // one string of addresses is read as a list; none is fine (the user may not know who it is for)
  assert.deepEqual(ok({ to: 'a@b.co; c@d.io, e@f.org', body: 'x' }).to, ['a@b.co', 'c@d.io', 'e@f.org']);
  assert.deepEqual(ok({ body: 'x' }), { to: [], subject: '', body: 'x' });
  assert.deepEqual(ok({ to: null, subject: null, body: 'tab\tand\nline' }), { to: [], subject: '', body: 'tab\tand\nline' });
});

test('what is not an address, a subject or a body is refused with its code, never cut', () => {
  bad(null, CODES.BAD_BODY);
  bad([], CODES.BAD_BODY);
  bad({ to: 5, body: 'x' }, CODES.BAD_TO);
  bad({ to: ['a@b.co', 7], body: 'x' }, CODES.BAD_TO);
  for (const a of ['sam', 'sam@', '@x.com', 'a b@c.de', 'a@b', 'Sam <a@b.co>', 'a@b.co>', 'a"@b.co', `${'x'.repeat(MAX_ADDRESS)}@b.co`])
    bad({ to: [a], body: 'x' }, CODES.BAD_TO);
  bad({ to: Array.from({ length: MAX_TO + 1 }, (_, i) => `p${i}@b.co`), body: 'x' }, CODES.TOO_LONG);
  assert.equal(ok({ to: Array.from({ length: MAX_TO }, (_, i) => `p${i}@b.co`), body: 'x' }).to.length, MAX_TO);
  bad({ subject: 4, body: 'x' }, CODES.BAD_SUBJECT);
  bad({ subject: 'a\u0000b', body: 'x' }, CODES.BAD_SUBJECT);
  bad({ subject: 'x'.repeat(MAX_SUBJECT + 1), body: 'x' }, CODES.TOO_LONG);
  assert.equal(ok({ subject: 'x'.repeat(MAX_SUBJECT), body: 'x' }).subject.length, MAX_SUBJECT);
  bad({}, CODES.BAD_BODY);
  bad({ body: '   \n ' }, CODES.BAD_BODY);
  bad({ body: 7 }, CODES.BAD_BODY);
  bad({ body: 'a\u0000b' }, CODES.BAD_BODY);
  bad({ body: 'a\u001bb' }, CODES.BAD_BODY);
  bad({ body: 'x'.repeat(MAX_BODY + 1) }, CODES.TOO_LONG);
  assert.equal(ok({ body: 'x'.repeat(MAX_BODY) }).body.length, MAX_BODY);
});

test('draftOf reads a saved note or a phone row’s draft, or says it is not one', () => {
  assert.deepEqual(draftOf({ to: ['a@b.co'], subject: 's', body: 'b' }), { to: ['a@b.co'], subject: 's', body: 'b' });
  for (const v of [undefined, null, 'text', { body: '' }, { to: ['nope'], body: 'x' }]) assert.equal(draftOf(v), null);
});

test('the mail link is percent-encoded: a recipient, a subject or a body cannot add a header or another address', () => {
  const r = mailtoOf({ to: ['a@b.co', 'c+d@e.io'], subject: 'Re: a&b=c?', body: 'Hi\nBcc: x@y.co\n100% ok' });
  assert.equal(r.ok, true);
  const url = (r as any).url as string;
  assert.equal(url, 'mailto:a@b.co,c%2Bd@e.io?subject=Re%3A%20a%26b%3Dc%3F&body=Hi%0D%0ABcc%3A%20x%40y.co%0D%0A100%25%20ok');
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.deepEqual([...query.keys()], ['subject', 'body'], 'only the two fields the draft has');
  // no recipient and no subject: just the body
  assert.equal((mailtoOf({ to: [], subject: '', body: 'x' }) as any).url, 'mailto:?body=x');
});

test('a draft whose link would be longer than the cap is not linked, so Copy is the way out', () => {
  const fits = mailtoOf({ to: [], subject: '', body: 'x'.repeat(MAX_MAILTO - 'mailto:?body='.length) });
  assert.equal(fits.ok, true);
  assert.equal((fits as any).url.length, MAX_MAILTO);
  const over = mailtoOf({ to: [], subject: '', body: 'x'.repeat(MAX_MAILTO) });
  assert.deepEqual(over, { ok: false, reason: CODES.TOO_LONG, why: 'Too long to open in Mail. Copy it instead.' });
  // encoding counts: a few newlines and symbols grow past the cap although the text is short
  assert.equal(mailtoOf({ to: [], subject: '', body: '\n'.repeat(400) }).ok, false);
});

test('a link is a mail link only, whatever the case', () => {
  assert.equal(isMailto('mailto:a@b.co'), true);
  assert.equal(isMailto('MAILTO:a@b.co'), true);
  for (const v of ['https://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'tel:123', ' mailto:a@b.co', '', null, undefined, 5])
    assert.equal(isMailto(v), false);
});

test('the transcript line and the recipients a card lists', () => {
  assert.equal(draftLine({ to: [], subject: 'Re: lunch', body: 'x' }), 'Draft · Re: lunch');
  assert.equal(draftLine({ to: [], subject: '', body: 'x' }), 'Draft · No subject');
  assert.deepEqual(recipientsOf({ to: ['a@b.co', 'c@d.io'], subject: '', body: 'x' }), {
    items: [
      { kind: 'email', label: 'a@b.co' },
      { kind: 'email', label: 'c@d.io' },
    ],
    count: 2,
  });
  assert.deepEqual(recipientsOf({ to: [], subject: '', body: 'x' }), { items: [], count: 0 });
});
