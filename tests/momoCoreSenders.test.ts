// What "the same kind of notice" means for a sender (shared/momoCore/senders.ts): the domain, except for public mail services where it is the full address; written in one plain form; and a crafted address cannot add a separator to the pattern key or the label.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SENDER_PREFIX,
  isPublicMail,
  namedSenders,
  namesSender,
  normalAddress,
  normalDomain,
  senderKey,
  senderOfPattern,
} from '../shared/momoCore/senders.ts';

test('a domain is written in one plain form, or is not a domain', () => {
  assert.equal(normalDomain('ACME.com.'), 'acme.com');
  assert.equal(normalDomain('  Acme.COM..  '), 'acme.com');
  assert.equal(normalDomain('münchen.example'), 'xn--mnchen-3ya.example');
  for (const bad of [
    'localhost',
    'acme',
    'a b.com',
    'acme.com:evil',
    'ac/me.com',
    'acme.com\u0000',
    '',
    7,
    null,
    undefined,
    'x'.repeat(90) + '.com',
    '-.com.',
  ])
    assert.equal(normalDomain(bad), null, String(bad));
});

test('an address is written in one plain form, or is not an address', () => {
  assert.deepEqual(normalAddress(' Ana.B+news@GMAIL.com. '), { address: 'ana.b+news@gmail.com', domain: 'gmail.com' });
  for (const bad of [
    'no-at.com',
    '@gmail.com',
    'ana@localhost',
    'a:na@gmail.com',
    'ana smith@gmail.com',
    'ana@gmail.com:x',
    `${'a'.repeat(65)}@gmail.com`,
    '',
    3,
    null,
  ])
    assert.equal(normalAddress(bad), null, String(bad));
});

test('a company’s sender is its domain; a public mail service’s is the full address, and with none there is no key', () => {
  assert.deepEqual(senderKey({ domain: 'Acme.com.' }), {
    pattern: 'notice:sender:acme.com',
    label: 'mail from acme.com',
    domain: 'acme.com',
    address: null,
  });
  // an address next to the domain changes nothing for a company
  assert.equal(senderKey({ domain: 'acme.com', address: 'ana@acme.com' })?.pattern, 'notice:sender:acme.com');
  for (const service of ['gmail.com', 'outlook.com', 'qq.com', '163.com']) {
    assert.ok(isPublicMail(service));
    assert.equal(senderKey({ domain: service }), null, `${service} alone is thousands of people`);
    assert.deepEqual(senderKey({ domain: service, address: `Ana@${service}` }), {
      pattern: `${SENDER_PREFIX}address:ana@${service}`,
      label: `mail from ana@${service}`,
      domain: service,
      address: `ana@${service}`,
    });
  }
  // the address of another domain does not speak for this one; the domain may come from the address alone
  assert.equal(senderKey({ domain: 'gmail.com', address: 'ana@outlook.com' }), null);
  assert.equal(senderKey({ address: 'ana@gmail.com' })?.pattern, 'notice:sender:address:ana@gmail.com');
  assert.equal(senderKey({}), null);
  assert.equal(senderKey({ domain: 'acme.com:evil' }), null);
});

test('only a pattern this module made is read back: a forged one names no sender', () => {
  assert.deepEqual(senderOfPattern('notice:sender:acme.com'), { domain: 'acme.com', address: null });
  assert.deepEqual(senderOfPattern('notice:sender:address:ana@gmail.com'), { domain: 'gmail.com', address: 'ana@gmail.com' });
  for (const forged of [
    'action:gmail.send|send|a@b.c',
    'notice:sender:ACME.com',
    'notice:sender:acme.com:x',
    'notice:sender:gmail.com',
    'notice:sender:address:ana@acme.com',
    'notice:sender:address:ANA@gmail.com',
    'notice:sender:address:ana@gmail.com ',
    'notice:sender:',
    'notice:sender:localhost',
  ])
    assert.equal(senderOfPattern(forged), null, forged);
});

test('public mail covers the common mailbox providers, their country variants and shared-hosting names; a domain under a shared-hosting suffix is one owner’s', () => {
  for (const d of [
    'web.de',
    'mail.ru',
    'naver.com',
    'hey.com',
    'fastmail.com',
    'pm.me',
    '188.com',
    'aliyun.com',
    'sina.com',
    'sohu.com',
    'foxmail.com',
    'comcast.net',
  ])
    assert.ok(isPublicMail(d), d);
  for (const d of [
    '189.cn',
    '139.com',
    'tom.com',
    '21cn.com',
    'gmx.at',
    'gmx.ch',
    'gmx.fr',
    'aol.de',
    'aol.co.uk',
    'gmx.net',
    'gmx.de',
    'yahoo.fr',
  ])
    assert.ok(isPublicMail(d), d);
  assert.equal(isPublicMail('yahoo.dev'), false, 'a provider name over a company tld is not the provider');
  for (const d of ['outlook.fr', 'outlook.com', 'hotmail.co.uk', 'hotmail.de', 'yahoo.co.jp', 'yahoo.com', 'live.com.au', 'msn.com'])
    assert.ok(isPublicMail(d), d);
  for (const d of ['github.io', 'blogspot.com', 'web.app', 'pages.dev', 'vercel.app', 'netlify.app', 'amazonaws.com', 'herokuapp.com'])
    assert.ok(isPublicMail(d), d);
  // a company's domain, a name that only looks like a provider, and one owner under a shared-hosting suffix
  for (const d of ['acme.com', 'outlookie.com', 'myoutlook.fr', 'hotmail.example.org', 'foo.github.io', 'shop.vercel.app'])
    assert.equal(isPublicMail(d), false, d);
  assert.equal(senderKey({ domain: 'github.io' }), null);
  assert.equal(senderKey({ domain: 'github.io', address: 'ana@github.io' })?.pattern, 'notice:sender:address:ana@github.io');
  assert.equal(senderKey({ domain: 'foo.github.io' })?.pattern, 'notice:sender:foo.github.io');
  assert.equal(senderKey({ domain: 'yahoo.co.jp', address: 'a@yahoo.co.jp' })?.pattern, 'notice:sender:address:a@yahoo.co.jp');
  assert.deepEqual(senderOfPattern('notice:sender:foo.github.io'), { domain: 'foo.github.io', address: null });
  assert.equal(senderOfPattern('notice:sender:github.io'), null);
});

test("the owner's words name a sender only as a whole word: a longer name, a different address or a domain for an address names nothing", () => {
  const acme = { domain: 'acme.com', address: null };
  const ana = { domain: 'gmail.com', address: 'ana@gmail.com' };
  assert.equal(namesSender('Tell me at once about Acme.com invoices', acme), true);
  assert.equal(namesSender('tell me about "acme.com".', acme), true);
  assert.equal(namesSender('tell me about mail from (@acme.com), please', acme), true);
  assert.equal(namesSender('tell me about notacme.com', acme), false);
  assert.equal(namesSender('tell me about acme.com.evil.example', acme), false);
  assert.equal(
    namesSender('tell me about billing@acme.com', acme),
    true,
    'an address at a domain-wide sender: the more specific wish wins',
  );
  assert.equal(namesSender('tell me about billing@notacme.com', acme), false);
  assert.equal(namesSender('tell me about Ana@Gmail.com!', ana), true);
  assert.equal(namesSender('tell me about bana@gmail.com', ana), false);
  assert.equal(namesSender('tell me about gmail.com', ana), false, 'a public mail domain is not one person');
  assert.equal(namesSender('', acme), false);
  // the ways an owner really writes it: a path, a wildcard, a bar, a dash, Chinese or full-width punctuation, a Chinese word next to it, an accented domain
  for (const text of [
    'tell me about acme.com/billing',
    'tell me about *@acme.com',
    'tell me about acme.com|acme.org',
    'acme.com\u2014 always',
    'acme.com\uff0c\u8bf7\u63d0\u9192\u6211',
    '\u6765\u81eaacme.com\u3002',
    '\u6765\u81eaacme.com\u7684\u90ae\u4ef6',
  ])
    assert.equal(namesSender(text, acme), true, text);
  assert.equal(namesSender('tell me about acme.com/billing', { domain: 'notacme.com', address: null }), false);
  assert.equal(namesSender('Tell me about m\u00fcnchen.example', { domain: 'xn--mnchen-3ya.example', address: null }), true);
  const named = namedSenders('mail from ben@gmail.com, acme.com; not a domain, nor x@@y, nor localhost');
  assert.deepEqual([...named.addresses], ['ben@gmail.com']);
  assert.deepEqual([...named.domains], ['acme.com']);
});
