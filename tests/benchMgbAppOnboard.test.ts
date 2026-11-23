// bench/lib/mgb/apps/onboard.mjs (#1381): the F2 onboarding wizard (four steps, server-side validation, the
// cross-origin identity check, the PDF upload and the signed copy) and the idcheck iframe, with their checksums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { form, multipart, req, text } from './support/mgb-app-kit.ts';

const ob = await import('../bench/lib/mgb/apps/onboard.mjs');
const { pdfDoc } = await import('../bench/lib/edgePages.mjs');
const {
  accountFor,
  idCheckDigit,
  idToken,
  idcheck,
  initIdcheck,
  initOnboard,
  onboard,
  stepErrors,
  validAccount,
  validDocNumber,
  verifiedDoc,
} = ob;

const NOW = Date.parse('2026-10-19T09:00:00Z');
const fixture = () => ({
  secret: 'shh-secret-1',
  company: 'Copperleaf',
  today: '2026-10-19',
  departments: ['Finance', 'Ops'],
  directory: ['Lena.Moreau@copperleaf.test'],
});
const on = (s: any, method: string, path: string, o: any = {}) =>
  onboard.handle(req(method, path, { app: 'onboard', ...o }), s, { now: NOW });
const id = (s: any, method: string, path: string, o: any = {}) =>
  idcheck.handle(req(method, path, { app: 'idcheck', ...o }), s, { now: NOW });
const DOC = `AB123456${idCheckDigit('123456')}`;
const personal = { name: 'Nia Okafor', email: 'nia@home.test', dob: '1990-04-02', phone: '+351 912 345 678', address: '1 Rua Nova, Porto' };

test('checksums: document numbers, bank accounts and the identity token', () => {
  assert.equal(idCheckDigit('123456'), String((7 + 6 + 3 + 28 + 15 + 6) % 10));
  assert.ok(validDocNumber(DOC));
  assert.ok(!validDocNumber(`AB123456${(Number(idCheckDigit('123456')) + 1) % 10}`));
  assert.ok(!validDocNumber('A1234567'));
  const acct = accountFor('000123456789');
  assert.ok(validAccount(acct));
  assert.ok(validAccount(`${acct.slice(0, 6)} ${acct.slice(6)}`.toLowerCase()), 'spaces and case do not matter');
  assert.ok(!validAccount(acct.replace(/9$/, '8')));
  assert.ok(!validAccount('MG12'));
  const tok = idToken('shh-secret-1', 'APP-1', DOC);
  assert.equal(verifiedDoc('shh-secret-1', 'APP-1', tok), DOC);
  assert.equal(verifiedDoc('shh-secret-1', 'APP-2', tok), null, 'a token is bound to its application');
  assert.equal(verifiedDoc('other-secret', 'APP-1', tok), null);
  assert.equal(verifiedDoc('shh-secret-1', 'APP-1', `ZZ0000000.${tok.split('.')[1]}`), null);
});

test('init rejects broken fixtures', () => {
  assert.throws(() => initOnboard({}), /needs a secret/);
  assert.throws(() => initOnboard({ secret: 'shh-secret-1' }), /needs today/);
  assert.throws(() => initOnboard({ secret: 'shh-secret-1', today: '2026-10-19', departments: [] }), /departments and a directory/);
  assert.throws(() => initOnboard({ secret: 'shh-secret-1', today: '2026-10-19', departments: ['A'] }), /departments and a directory/);
  assert.equal(initOnboard({ ...fixture(), company: undefined }).company, 'Acme');
  assert.throws(() => initIdcheck({ secret: 'x' }), /needs the wizard secret/);
  assert.throws(() => initIdcheck(null), /needs the wizard secret/);
});

test('step validation names each problem', () => {
  const s = initOnboard(fixture());
  const a = { id: 'APP-1' };
  const names = (n: number, v: any) => stepErrors(s, n, v, a).map(([f]: string[]) => f);
  assert.deepEqual(names(1, personal), []);
  assert.deepEqual(names(1, { name: 'Nia', email: 'x', dob: '1990-02-30x', phone: '912', address: '' }), ['name', 'email', 'dob', 'phone']);
  assert.deepEqual(names(1, { ...personal, name: '' }), ['name']);
  assert.deepEqual(names(1, { ...personal, dob: '2010-01-01' }), ['dob']);
  assert.deepEqual(names(1, { ...personal, dob: '1990-02-30' }), ['dob'], 'not a calendar day');
  // the 18th birthday by the calendar: today (2026-10-19) is enough, tomorrow is not
  assert.deepEqual(names(1, { ...personal, dob: '2008-10-19' }), []);
  assert.deepEqual(names(1, { ...personal, dob: '2008-10-20' }), ['dob']);
  const leap = (today: string) => stepErrors({ ...s, today }, 1, { ...personal, dob: '2008-02-29' }, a).map(([f]: string[]) => f);
  assert.deepEqual(leap('2026-02-28'), ['dob']);
  assert.deepEqual(leap('2026-03-01'), []);
  const good2 = {
    department: 'Ops',
    start: '2026-10-26',
    manager: 'lena.moreau@copperleaf.test',
    idToken: idToken('shh-secret-1', 'APP-1', DOC),
  };
  assert.deepEqual(names(2, good2), []);
  assert.deepEqual(names(2, { department: 'HR', start: '2026-10-27', manager: 'boss@x.test', idToken: '' }), [
    'department',
    'start',
    'manager',
    'idToken',
  ]);
  assert.deepEqual(names(2, { ...good2, start: '2026-10-19' }), ['start'], 'today is not after today');
  assert.deepEqual(names(2, { ...good2, start: 'soon' }), ['start']);
  assert.deepEqual(names(2, { ...good2, start: '2026-13-45' }), ['start']);
  assert.deepEqual(names(3, { account: accountFor('111122223333'), tax: '123-456-789' }), []);
  assert.deepEqual(names(3, { account: 'MG00', tax: '123456789' }), ['account', 'tax']);
  assert.deepEqual(names(4, {}), []);
});

test('the wizard: four steps with errors that keep the input, the identity iframe, a PDF upload and the signed copy', () => {
  const s = initOnboard(fixture());
  const ids = initIdcheck({ secret: 'shh-secret-1' });
  assert.match(text(on(s, 'GET', '/')), /New hire onboarding/);
  const started = on(s, 'POST', '/start');
  assert.equal(started.headers.location, '/a/APP-1/step/1');
  // a later step redirects to the first one not done
  assert.equal(on(s, 'GET', '/a/APP-1/step/3').headers.location, '/a/APP-1/step/1');
  assert.equal(on(s, 'POST', '/a/APP-1/step/3', form({})).headers.location, '/a/APP-1/step/1');
  const bad = on(s, 'POST', '/a/APP-1/step/1', form({ ...personal, phone: '12' }));
  assert.equal(bad.status, 422);
  assert.match(bad.body, /role="alert">Please fix: Phone must be in international format/);
  assert.match(bad.body, /value="Nia Okafor"/);
  assert.match(bad.body, /id="phone" name="phone" type="text" value="12" aria-invalid="true"/);
  assert.equal(on(s, 'POST', '/a/APP-1/step/1', form(personal)).headers.location, '/a/APP-1/step/2');

  const step2 = on(s, 'GET', '/a/APP-1/step/2');
  assert.match(step2.body, /<iframe title="Identity check" src="http:\/\/idcheck.localhost:8820\/verify\?app=APP-1"/);
  assert.match(step2.body, /e.origin!=="http:\/\/idcheck.localhost:8820"/);
  assert.match(text(step2), /Identity not verified yet/);
  assert.match(text(step2), /Step 2 of 4 · Application APP-1 Employment and identity/);
  // the identity check, inside the iframe's own origin
  assert.match(text(id(ids, 'GET', '/verify?app=APP-1')), /Document number/);
  const wrong = id(ids, 'POST', '/verify?app=APP-1', form({ doc: 'AB1234560' === DOC ? 'AB1234561' : 'AB1234560' }));
  assert.equal(wrong.status, 422);
  assert.match(text(wrong), /not valid/);
  const okId = id(ids, 'POST', '/verify?app=APP-1', form({ doc: DOC.toLowerCase() }));
  const token = idToken('shh-secret-1', 'APP-1', DOC);
  assert.match(
    okId.body,
    new RegExp(`postMessage\\(\\{type:'idcheck',token:"${token}",last4:"${DOC.slice(-4)}"\\},"http://onboard.localhost:8820"\\)`),
  );
  assert.deepEqual(
    ids.events.map((e: any) => e.type),
    ['rejected', 'verified'],
  );
  assert.equal(id(ids, 'GET', '/other').status, 404);
  assert.match(text(id(ids, 'POST', '/verify', form({ doc: '' }))), /not valid/);

  const step2Bad = on(
    s,
    'POST',
    '/a/APP-1/step/2',
    form({ department: 'Ops', start: '2026-10-26', manager: 'lena.moreau@copperleaf.test', idToken: 'forged' }),
  );
  assert.equal(step2Bad.status, 422);
  assert.match(step2Bad.body, /Verify the identity document first/);
  assert.match(step2Bad.body, /<option selected>Ops<\/option>/);
  const step2Ok = on(
    s,
    'POST',
    '/a/APP-1/step/2',
    form({ department: 'Ops', start: '2026-10-26', manager: 'Lena.Moreau@copperleaf.test', idToken: token }),
  );
  assert.equal(step2Ok.headers.location, '/a/APP-1/step/3');
  assert.equal(s.applications[0].verifiedDoc, DOC);
  assert.match(text(on(s, 'GET', '/a/APP-1/step/2')), new RegExp(`Identity verified \\(document ending ${DOC.slice(-4)}\\)`));
  assert.match(on(s, 'GET', '/a/APP-1/step/2').body, /<a href="\/a\/APP-1\/step\/1">Back<\/a>/);
  // redoing a done step keeps it done once
  on(s, 'POST', '/a/APP-1/step/1', form(personal));
  assert.deepEqual(s.applications[0].done, [1, 2]);
  assert.equal(
    on(s, 'POST', '/a/APP-1/step/3', form({ account: accountFor('000000000042'), tax: '987-654-321' })).headers.location,
    '/a/APP-1/step/4',
  );

  const step4 = on(s, 'GET', '/a/APP-1/step/4');
  assert.match(step4.body, /enctype="multipart\/form-data"/);
  assert.match(text(step4), /name Nia Okafor/);
  const notPdf = on(
    s,
    'POST',
    '/a/APP-1/step/4',
    multipart({ agree: 'yes' }, [{ field: 'declaration', name: 'decl.pdf', content: 'hello' }]),
  );
  assert.equal(notPdf.status, 422);
  assert.match(notPdf.body, /must be a PDF file/);
  const noAgree = on(
    s,
    'POST',
    '/a/APP-1/step/4',
    multipart({}, [{ field: 'declaration', name: 'decl.pdf', type: 'application/pdf', content: pdfDoc(['Declaration']) }]),
  );
  assert.equal(noAgree.status, 422);
  assert.match(noAgree.body, /Confirm the details are correct/);
  assert.match(text(on(s, 'GET', '/a/APP-1/step/4')), /Uploaded: decl.pdf/);
  const none = initOnboard(fixture());
  on(none, 'POST', '/start');
  none.applications[0].done = [1, 2, 3];
  assert.match(on(none, 'POST', '/a/APP-1/step/4', multipart({ agree: 'yes' })).body, /Upload the signed declaration/);

  const done = on(s, 'POST', '/a/APP-1/step/4', multipart({ agree: 'yes' }));
  assert.equal(done.headers.location, '/a/APP-1/done?flash=Application%20submitted.');
  const a = s.applications[0];
  assert.equal(a.status, 'submitted');
  assert.match(a.confirmation, /^ONB-[0-9A-F]{8}$/);
  assert.match(text(on(s, 'GET', '/a/APP-1/done?flash=Application%20submitted.')), new RegExp(`Confirmation number: ${a.confirmation}`));
  // a submitted application cannot be edited again
  assert.equal(on(s, 'GET', '/a/APP-1/step/1').headers.location, '/a/APP-1/done');
  assert.equal(on(s, 'POST', '/a/APP-1/step/1', form(personal)).headers.location, '/a/APP-1/done');
  const signed = on(s, 'GET', '/a/APP-1/signed.pdf');
  assert.equal(signed.headers['content-type'], 'application/pdf');
  assert.match(Buffer.from(signed.body, 'latin1').toString('latin1'), new RegExp(`Confirmation: ${a.confirmation}`));
  assert.deepEqual(
    s.events.map((e: any) => e.type),
    ['started', 'invalid', 'step', 'invalid', 'step', 'step', 'step', 'uploaded', 'submitted', 'downloaded'],
  );
});

test('unknown applications, steps and early downloads are not found', () => {
  const s = initOnboard(fixture());
  on(s, 'POST', '/start');
  for (const [m, p] of [
    ['GET', '/a/APP-9/step/1'],
    ['GET', '/a/APP-1/step/5'],
    ['POST', '/a/APP-9/step/1'],
    ['POST', '/a/APP-1/step/0'],
    ['GET', '/a/APP-1/done'],
    ['GET', '/a/APP-9/done'],
    ['GET', '/a/APP-1/signed.pdf'],
    ['GET', '/nowhere'],
  ])
    assert.equal(on(s, m, p, m === 'POST' ? form({}) : {}).status, 404, `${m} ${p}`);
});
