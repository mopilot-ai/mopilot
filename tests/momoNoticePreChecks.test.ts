// MoMo notice pre-checks and sender check (shared/momoNotice/preChecks.ts, senderCheck.ts): each rule only answers quiet, the narrow cases stay with the model, access secrets are private, and Gmail's DMARC result decides the sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { header, holdsAccessSecret, preCheck } from '../shared/momoNotice/preChecks.ts';
import { redactSecrets } from '../shared/momoNotice/signals.ts';
import {
  checkSender,
  fromDomain,
  judgeSender,
  mayOfferReply,
  mentionsMoneyOrCredentials,
  parseAuthResults,
} from '../shared/momoNotice/senderCheck.ts';
import type { MailMessage } from '../shared/momoNotice/types.d.ts';

const mail = (over: Partial<MailMessage> = {}): MailMessage => ({
  id: 'm',
  threadId: 't',
  from: 'Ana <ana@acme.com>',
  to: ['me@x.com'],
  cc: [],
  subject: 'Hello',
  date: '2026-11-24T10:00:00Z',
  headers: {},
  labels: ['INBOX'],
  body: 'Hi',
  ...over,
});

test('header lookup ignores case', () => {
  assert.equal(header(mail({ headers: { 'list-unsubscribe': '<x>' } }), 'List-Unsubscribe'), '<x>');
  assert.equal(header(mail(), 'Nope'), undefined);
});

test('bulk and category rules need Gmail’s own noise label', () => {
  assert.equal(preCheck(mail({ headers: { 'List-Unsubscribe': '<x>' }, labels: ['CATEGORY_PROMOTIONS'] }))?.decidedBy, 'rule:bulk');
  assert.equal(preCheck(mail({ headers: { Precedence: ' Bulk ' }, labels: ['CATEGORY_SOCIAL'] }))?.decidedBy, 'rule:bulk');
  assert.equal(preCheck(mail({ labels: ['CATEGORY_PROMOTIONS'] }))?.decidedBy, 'rule:category');
  // list headers alone, Updates and Forums labels stay with the model
  assert.equal(preCheck(mail({ headers: { 'List-Unsubscribe': '<x>', Precedence: 'list' }, labels: ['CATEGORY_FORUMS'] })), null);
  assert.equal(preCheck(mail({ headers: { Precedence: 'first-class' }, labels: ['CATEGORY_UPDATES'] })), null);
  assert.equal(preCheck(mail({ labels: ['CATEGORY_UPDATES'], subject: 'Payment failed' })), null);
});

test('auto-reply and calendar-response rules are narrow', () => {
  assert.equal(preCheck(mail({ headers: { 'Auto-Submitted': 'auto-replied' } }))?.decidedBy, 'rule:auto-reply');
  assert.equal(preCheck(mail({ headers: { 'Auto-Submitted': 'auto-generated' } })), null);
  for (const subject of ['Accepted: Review @ Fri', ' Declined: x', 'Tentatively accepted: y'])
    assert.equal(preCheck(mail({ subject }))?.decidedBy, 'rule:calendar-response');
  assert.equal(preCheck(mail({ subject: 'Re: Accepted: x' })), null);
  const result = preCheck(mail({ subject: 'Accepted: x' }));
  assert.deepEqual([result?.verdict, result?.private], ['quiet', false]);
});

test('mail holding a sign-in code or reset link is private and quiet', () => {
  const cases = [
    'Your verification code is 482913.',
    'Use security code: 1234 to continue',
    'OTP 998877 expires soon',
    '482913 is your code',
    '您的验证码 482913，五分钟内有效。',
    'Open https://app.example.com/auth/reset/abc123 to set a new password',
    'Sign in: https://x.example.com/login?token=abc',
    'Please reset your password: https://acme.example/p',
    '点击 https://acme.example/p 重置密码',
  ];
  for (const body of cases) {
    assert.equal(holdsAccessSecret(mail({ body })), true, body);
    assert.deepEqual(preCheck(mail({ body })), {
      verdict: 'quiet',
      reason: 'Holds a sign-in code or reset link, kept private.',
      decidedBy: 'rule:access-secret',
      private: true,
    });
  }
  assert.equal(holdsAccessSecret(mail({ subject: 'Your sign-in code is 55555', body: '' })), true);
});

test('a warning, a plain sign-in page link, or a reset mention without a link is not a secret', () => {
  for (const body of [
    'Your payment of 1234 failed.',
    'Visit https://acme.example/login to review.',
    'You can reset your password later in settings.',
    'Security alert: new sign-in on Windows.',
    'Order 12345 shipped',
  ]) {
    assert.equal(holdsAccessSecret(mail({ body })), false, body);
  }
});

test('Authentication-Results parsing reads the authserv-id, dmarc and header.from, and refuses odd input', () => {
  assert.deepEqual(parseAuthResults('mx.google.com; dkim=pass; dmarc=pass (p=NONE) header.from=Acme.com'), {
    authservId: 'mx.google.com',
    dmarc: 'pass',
    headerFrom: 'acme.com',
  });
  assert.deepEqual(parseAuthResults('mx.google.com 1;\n spf=pass'), { authservId: 'mx.google.com' });
  assert.equal(parseAuthResults('no separator'), undefined);
  assert.equal(parseAuthResults('; dmarc=pass'), undefined);
  assert.equal(parseAuthResults('bad id!; dmarc=pass'), undefined);
});

test('the From domain needs exactly one address', () => {
  assert.equal(fromDomain('Ana <ana@Acme.com>'), 'acme.com');
  assert.equal(fromDomain('bob@x.org'), 'x.org');
  assert.equal(fromDomain('a@x.com, b@y.com'), null);
  assert.equal(fromDomain('no address'), null);
});

test('the sender passes only on the topmost trusted dmarc pass for the From domain', () => {
  const ar = (value: string) => mail({ headers: { 'Authentication-Results': value } });
  assert.equal(checkSender(ar('mx.google.com; dmarc=pass header.from=acme.com')).status, 'pass');
  assert.equal(checkSender(ar('mx.google.com; dmarc=pass header.from=evil.com')).status, 'fail');
  assert.equal(checkSender(ar('mx.google.com; dmarc=fail header.from=acme.com')).status, 'fail');
  assert.equal(checkSender(ar('mx.google.com; spf=pass')).status, 'unknown');
  assert.equal(checkSender(ar('mx.google.com; dmarc=none')).status, 'unknown');
  assert.equal(checkSender(ar('mail.evil.test; dmarc=pass header.from=acme.com')).status, 'unknown');
  assert.equal(checkSender(mail()).status, 'unknown');
  assert.equal(checkSender(mail({ from: 'a@x.com, b@y.com' })).status, 'fail');
  assert.equal(checkSender(ar('mx.google.com; dmarc=pass header.from=acme.com'), ['other.test']).status, 'unknown');
  // a pass that does not name the domain it covers is not a pass
  assert.equal(checkSender(ar('mx.google.com; dmarc=pass')).status, 'unknown');
});

test('a block a sender forged below the receiving server’s is ignored', () => {
  const ar = (value: string) => mail({ headers: { 'Authentication-Results': value } });
  const real = 'mx.google.com; dmarc=fail header.from=acme.com';
  const forged = 'mx.google.com; dmarc=pass header.from=acme.com';
  assert.equal(checkSender(ar(`${real}\n${forged}`)).status, 'fail');
  assert.equal(checkSender(ar(`mx.google.com; dmarc=none\n${forged}`)).status, 'unknown');
  // a forged block placed first by a different server is not trusted either, and does not hand the pass to a later one
  assert.equal(checkSender(ar(`mail.evil.test; dmarc=pass header.from=acme.com\n${forged}`)).status, 'unknown');
  assert.equal(checkSender(ar(`${forged}\nmx.google.com; dmarc=fail header.from=acme.com`)).status, 'pass');
});

test('a genuine pass from a first-seen or look-alike domain gets no reply draft', () => {
  const pass = (domain: string, from = `Pay <service@${domain}>`) =>
    mail({ from, headers: { 'Authentication-Results': `mx.google.com; dmarc=pass header.from=${domain}` } });
  const known = ['paypal.com', 'acme.com'];
  const same = judgeSender(pass('acme.com'), known);
  assert.deepEqual([same.status, same.firstSeen, mayOfferReply(same)], ['pass', undefined, true]);
  const fresh = judgeSender(pass('brandnew.example'), known);
  assert.deepEqual([fresh.status, fresh.firstSeen, fresh.lookalikeOf, mayOfferReply(fresh)], ['pass', true, undefined, false]);
  for (const [domain, imitates] of [
    ['paypa1.com', 'paypal.com'],
    ['paypall.com', 'paypal.com'],
    ['paypl.com', 'paypal.com'],
    ['paypai.com', 'paypal.com'],
    ['acrne.com', 'acme.com'],
    ['acm.com', 'acme.com'],
  ]) {
    const look = judgeSender(pass(domain), known);
    assert.deepEqual([look.lookalikeOf, mayOfferReply(look)], [imitates, false], domain);
    assert.match(look.reason, /looks like/);
  }
  assert.equal(judgeSender(pass('unrelated.org'), known).lookalikeOf, undefined);
  assert.equal(judgeSender(pass('x.org'), ['payp.org']).lookalikeOf, undefined);
  // a failed or unknown check is returned as it is, whatever the history says
  assert.equal(judgeSender(mail(), known).status, 'unknown');
  assert.equal(mayOfferReply(judgeSender(mail(), known)), false);
  assert.equal(judgeSender(mail({ from: 'nobody' }), known).status, 'fail');
});

test('money and credential wording marks mail the sender check guards', () => {
  assert.equal(mentionsMoneyOrCredentials(mail({ subject: 'Invoice 55 overdue' })), true);
  assert.equal(mentionsMoneyOrCredentials(mail({ body: '请尽快付款' })), true);
  assert.equal(mentionsMoneyOrCredentials(mail({ body: 'Lunch on Friday?' })), false);
});

test('a security alert or a failed payment that carries a link or code is read, not silenced', () => {
  const risky = [
    ['Security alert: new sign-in', "If this wasn't you, reset your password: https://acct.example.com/reset?token=abc"],
    ['Payment failed', 'Update billing: https://pay.x/billing?token=abc'],
    ['Your store has been paused', 'Sign in with code 123456 to update your payment method: https://shop.example/billing?code=5541'],
    ['Unusual sign-in', 'Your sign-in code is 482913. If it was not you, change your password.'],
    ['Final notice', 'Verification code 112233; pay at https://x.example/pay?token=1'],
    ['\u8d26\u53f7\u5f02\u5e38', 'Your verification code 998877'],
  ];
  for (const [subject, body] of risky) {
    assert.equal(holdsAccessSecret(mail({ subject, body })), true, subject);
    assert.equal(preCheck(mail({ subject, body })), null, subject);
  }
  // the same secrets without a risk signal stay private and quiet
  assert.equal(preCheck(mail({ subject: 'Your sign-in code', body: 'Verification code 112233' }))?.private, true);
});

test('redaction removes codes and secret links from every text a model or a brief could carry', () => {
  assert.equal(redactSecrets('Your verification code is 482913, expires soon.'), 'Your verification code is [code removed], expires soon.');
  assert.equal(redactSecrets('482913 is your code'), '[code removed] is your code');
  assert.equal(
    redactSecrets('Open https://a.example/reset?token=abc now and https://a.example/docs'),
    'Open [link removed] now and https://a.example/docs',
  );
  assert.equal(redactSecrets('nothing secret, order 12345'), 'nothing secret, order 12345');
});

test('a mail the user sent is quiet by rule', () => {
  assert.equal(preCheck(mail({ labels: ['SENT'] }))?.decidedBy, 'rule:sent');
});

test('a booking confirmation code is not a sign-in code: the mail is read, but the code is still cut from what a model sees', () => {
  const flight = mail({ subject: 'Flight cancelled', body: 'Confirmation code: 482913. Rebook: https://air.example/rebook' });
  assert.equal(holdsAccessSecret(flight), false);
  assert.equal(preCheck(flight), null);
  assert.equal(redactSecrets(flight.body), 'Confirmation code: [code removed]. Rebook: https://air.example/rebook');
});

test('gift cards and a spaced "sign in" are money or credential asks', () => {
  assert.equal(mentionsMoneyOrCredentials(mail({ body: 'Buy gift cards for the team' })), true);
  assert.equal(mentionsMoneyOrCredentials(mail({ body: 'Please sign in to review' })), true);
});

test('a confirmation code that expires is a sign-in code, one without expiry is a booking record', () => {
  assert.equal(holdsAccessSecret(mail({ body: 'Your confirmation code is 90412 and expires soon.' })), true);
  assert.equal(holdsAccessSecret(mail({ body: 'Enter this code: confirmation code 90412' })), true);
  assert.equal(holdsAccessSecret(mail({ body: 'Booking confirmation code 90412. Boarding starts in 40 minutes.' })), false);
});
