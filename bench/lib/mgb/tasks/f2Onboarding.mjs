// MGB task f2-onboarding (#1381, F2): onboard a new hire from an HR email (a passport scan to download, a phone
// correction, a relative start date), pass the cross-origin identity check, upload a TextEdit PDF declaration, and
// file the signed copy on the Mac under the folder's own naming pattern.
import { createHmac } from 'node:crypto';
import { has, same } from '../grade.mjs';
import { dayOffset, nextMonday, people } from '../seed.mjs';
import { accountFor, idCheckDigit } from '../apps/onboard.mjs';
import { at, isPdf } from './common.mjs';
import { browse } from './drive.mjs';
import { bodyBytes, digits, fileAt, pdfBase64, pdfTextOf, putFile } from './f2Common.mjs';

export const CONFIRM_LINE = 'I confirm the details above are correct.';
const DEPARTMENTS = ['Finance', 'Operations', 'Engineering', 'Sales', 'People', 'Legal'];
const STREETS = ['Rua Nova', 'Harbour Lane', 'Elm Street', 'Kanalvej', 'Mill Road', 'Calle Mayor', 'Station Road'];
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXZ';

/** @param {import('../seed.mjs').Rng} r */
const docNumber = (r) => {
  const six = String(r.int(100000, 999999));
  return `${LETTERS[r.int(0, LETTERS.length - 1)]}${LETTERS[r.int(0, LETTERS.length - 1)]}${six}${idCheckDigit(six)}`;
};
/** @param {import('../seed.mjs').Rng} r */
const phone = (r) => `+351 9${r.int(10, 99)} ${r.int(100, 999)} ${r.int(100, 999)}`;
/** The confirmation number the wizard gives an application (from the secret it shares with idcheck). @param {string} secret @param {string} app */
export const confirmationFor = (secret, app) => `ONB-${createHmac('sha256', secret).update(app).digest('hex').slice(0, 8).toUpperCase()}`;
/** Where the signed copy belongs: the folder's pattern, "<Last>, <First> - <start>.pdf". @param {any} d */
export const signedPath = (d) => `signed/${d.hire.last}, ${d.hire.first} - ${d.start}.pdf`;

/** The applications that were submitted. @param {any} state */
const submitted = (state) => state.onboard.applications.filter((/** @type {any} */ a) => a.status === 'submitted');
/** The application the hire's details went into: the first one submitted. @param {any} state */
const appOf = (state) => submitted(state)[0];
/** Whether every [got, want] pair reads the same. @param {[unknown, unknown][]} pairs */
const allSame = (pairs) => pairs.every(([got, want]) => same(got, want));

/**
 * The oracle, and the wrong agents the tests build from it: fills the wizard with the hire's details (any of them
 * overridden), verifies the passport in the idcheck frame, uploads the declaration, submits and files the signed copy.
 * @param {any} d @param {any} state
 * @param {{ phone?: string, passport?: string, start?: string, declaration?: string[], signedAs?: string }} [o]
 */
export function fillAndFile(d, state, o = {}) {
  const ob = browse(state, 'onboard');
  const id = ob.post('/start').headers.location.split('/')[2];
  const h = d.hire;
  ob.post(`/a/${id}/step/1`, { name: h.name, email: h.email, dob: h.dob, phone: o.phone ?? h.phone, address: h.address });
  // the iframe posts the document to idcheck and hands the wizard the token it answers with
  const verified = browse(state, 'idcheck').post(`/verify?app=${id}`, { doctype: 'Passport', doc: o.passport ?? d.passport });
  const token = /** @type {RegExpExecArray} */ (/token:"([^"]+)"/.exec(verified.body))[1];
  ob.post(`/a/${id}/step/2`, { department: d.department, start: o.start ?? d.start, manager: d.manager.email, idToken: token });
  ob.post(`/a/${id}/step/3`, { account: d.accountShown, tax: d.tax });
  const pdf = Buffer.from(pdfBase64(o.declaration ?? [`Declaration of ${h.name}`, CONFIRM_LINE]), 'base64');
  ob.post(`/a/${id}/step/4`, {
    fields: { agree: 'yes' },
    files: [{ field: 'declaration', name: 'Declaration.pdf', type: 'application/pdf', content: pdf }],
  });
  putFile(state, o.signedAs ?? signedPath(d), bodyBytes(ob.get(`/a/${id}/signed.pdf`)));
  return state;
}

/** @type {import('../schema.mjs').Task} */
export const task = {
  id: 'f2-onboarding',
  family: 'F2',
  title: 'Onboard a new hire from an HR email and file the signed copy',
  surfaces: ['iab', 'cu'],
  tier: 'smoke',
  apps: ['mail', 'onboard', 'idcheck'],
  actions: [30, 80],
  cards: 0,
  data(r, env) {
    const company = r.company();
    const domain = `${company.toLowerCase().replace(/[^a-z]+/g, '')}.test`;
    const [user, hr, manager, it, other, hireP, ...earlier] = people(r, 9, domain);
    const year = Number(env.today.slice(0, 4)) - r.int(22, 55);
    const hire = {
      ...hireP,
      email: `${hireP.first}.${hireP.last}${r.int(10, 99)}@homemail.test`.toLowerCase(),
      dob: `${year}-${String(r.int(1, 12)).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`,
      phone: phone(r),
      address: `${r.int(2, 180)} ${r.pick(STREETS)}, ${r.city()}`,
    };
    const after = dayOffset(env.today, r.int(4, 24));
    const account = accountFor(String(r.int(100000, 999999)) + String(r.int(100000, 999999)));
    return {
      company,
      user,
      hr,
      manager,
      it,
      other,
      hire,
      oldPhone: phone(r),
      department: r.pick(DEPARTMENTS),
      after,
      start: nextMonday(after),
      passport: docNumber(r),
      oldPassport: docNumber(r),
      account,
      // written the way a bank statement groups it
      accountShown: account.replace(/(.{4})/g, '$1 ').trim(),
      tax: `${r.int(100, 999)}-${r.int(100, 999)}-${r.int(100, 999)}`,
      secret: r.token('OBS', 12),
      earlier: earlier.map((p, i) => ({ ...p, start: nextMonday(dayOffset(env.today, -14 * (i + 1) - r.int(0, 6))) })),
    };
  },
  fixtures(d, env) {
    const h = d.hire;
    const subject = `New hire: ${h.name}, onboarding details`;
    const scan = [
      'PASSPORT (scan, OCR text)',
      `Surname: ${h.last.toUpperCase()}`,
      `Given names: ${h.first.toUpperCase()}`,
      `Date of birth: ${h.dob}`,
      `Document no.: ${d.passport}`,
      `Date of expiry: ${Number(env.today.slice(0, 4)) + 7}${env.today.slice(4)}`,
      '',
      `Previous passport (cancelled, no longer valid): ${d.oldPassport}`,
    ].join('\n');
    const prev = d.earlier[0];
    return {
      mail: {
        user: { name: d.user.name, email: d.user.email },
        messages: [
          {
            from: { name: d.hr.name, email: d.hr.email },
            cc: [d.it.email, d.manager.email],
            subject,
            body: [
              `Hi ${d.user.first},`,
              '',
              `${h.name} has signed! Please complete their onboarding application. Details:`,
              `- Full name: ${h.name}`,
              `- Personal email: ${h.email}`,
              `- Date of birth: ${h.dob}`,
              `- Mobile: ${d.oldPhone}`,
              `- Home address: ${h.address}`,
              `- Department: ${d.department}`,
              `- Start date: the first Monday after ${d.after}`,
              `- Manager: ${d.manager.name} (copied here)`,
              `- Bank account: ${d.accountShown}`,
              `- Tax number: ${d.tax}`,
              '- Passport: see the attached scan',
              '',
              'Thanks,',
              `${d.hr.name}`,
              `People team, ${d.company}`,
            ].join('\n'),
            date: at(dayOffset(env.today, -3), 9),
            attachments: [{ name: 'passport-scan.txt', type: 'text/plain', text: scan }],
          },
          {
            from: { name: d.hr.name, email: d.hr.email },
            subject: `Re: ${subject}`,
            body: `Small correction: ${h.first}'s mobile number is ${h.phone}, not the one in my first email. Everything else stands.\n\n${d.hr.name}`,
            date: at(dayOffset(env.today, -2), 14),
          },
          {
            from: { name: d.it.name, email: d.it.email },
            subject: `Laptop for ${h.first}`,
            body: `I've ordered ${h.first}'s laptop. It will be ready on their first day.\n\n${d.it.name}, IT`,
            date: at(dayOffset(env.today, -2), 10),
          },
          {
            from: { name: d.hr.name, email: d.hr.email },
            subject: `New hire: ${prev.name}, onboarding details`,
            body: `Hi ${d.user.first},\n\n${prev.name} starts on ${prev.start} in Sales. Their application is done; thanks!\n\n${d.hr.name}`,
            date: at(dayOffset(prev.start, -10), 11),
            read: true,
          },
        ],
      },
      onboard: {
        secret: d.secret,
        company: d.company,
        today: env.today,
        departments: DEPARTMENTS,
        directory: [d.hr.email, d.manager.email, d.it.email, d.other.email, d.user.email],
      },
      idcheck: { secret: d.secret },
      files: {
        entries: Object.fromEntries(
          d.earlier.map((/** @type {any} */ p) => [
            `signed/${p.last}, ${p.first} - ${p.start}.pdf`,
            { base64: pdfBase64([`${d.company} onboarding: signed copy`, `Name: ${p.name}`, `Start: ${p.start}`]) },
          ]),
        ),
      },
    };
  },
  prompt(d, env) {
    return [
      `I'm ${d.user.name} at ${d.company}. HR emailed me the details of our new hire, ${d.hire.name} (my mailbox: ${env.urls.mail}). Use the in-app browser for the websites and the Mac's apps (Finder, TextEdit) for files. First gather everything the onboarding needs: personal details, department, start date, manager, bank and tax details, and the passport number from the scan HR attached (download it and read it). Check for any follow-up from HR. Tell me what you found; don't start the application yet.`,
      `Now complete ${d.hire.first}'s onboarding at ${env.urls.onboard}: one application, all four steps, including the identity check. For the declaration, write a one-page document in TextEdit with ${d.hire.name}'s full name and the line "${CONFIRM_LINE}", export it as a PDF (File > Export as PDF) and upload it on the last step, then submit. Finally download the signed copy and save it in the "signed" folder of ${env.files}, named the same way as the files already there.`,
    ];
  },
  secrets: (d) => [d.passport, d.account, d.accountShown, d.tax, d.manager.email, d.start, d.hire.phone, signedPath(d)],
  checkpoints: [
    {
      id: 'step-personal',
      title: 'Step 1 has the hire’s name, email, birth date, corrected phone and address',
      check: ({ data, state }) => {
        const a = appOf(state);
        const h = data.hire;
        return (
          !!a &&
          digits(a.values.phone) === digits(h.phone) &&
          allSame([
            [a.values.name, h.name],
            [a.values.email, h.email],
            [a.values.dob, h.dob],
            [a.values.address, h.address],
          ])
        );
      },
    },
    {
      id: 'step-employment',
      title: 'Step 2 has the department, the computed Monday start and the manager’s email',
      check: ({ data, state }) => {
        const v = appOf(state)?.values ?? {};
        return allSame([
          [v.department, data.department],
          [v.start, data.start],
          [v.manager, data.manager.email],
        ]);
      },
    },
    {
      id: 'step-bank',
      title: 'Step 3 has the bank account and tax number',
      check: ({ data, state }) => {
        const v = appOf(state)?.values ?? {};
        return allSame([
          [String(v.account).replace(/\s+/g, ''), data.account],
          [v.tax, data.tax],
        ]);
      },
    },
    {
      id: 'identity',
      title: 'The identity check verified the current passport, not the cancelled one',
      check: ({ data, state }) => appOf(state)?.verifiedDoc === data.passport,
    },
    { id: 'declaration-pdf', title: 'The uploaded declaration is a PDF', check: ({ state }) => isPdf(appOf(state)?.declaration) },
    {
      id: 'declaration-text',
      title: 'The declaration names the hire and carries the confirmation line',
      required: false,
      weight: 0.5,
      check: ({ data, state }) => {
        const pdf = appOf(state)?.declaration;
        if (!pdf) return false;
        const text = pdfTextOf(pdf.data);
        return {
          met: [data.hire.name, CONFIRM_LINE].every((x) => has(text, x)),
          why: text ? undefined : 'no text could be read from the PDF',
        };
      },
    },
    { id: 'submitted-once', title: 'Exactly one application was submitted', check: ({ state }) => submitted(state).length === 1 },
    {
      id: 'signed-copy',
      title: 'The signed copy is in the signed folder under the folder’s naming pattern',
      check: ({ data, state }) => typeof fileAt(state.files, signedPath(data))?.pdfText === 'string',
    },
    {
      id: 'signed-confirmation',
      title: 'The filed signed copy carries the submitted application’s confirmation number',
      canary: true,
      check: ({ data, state }) => {
        const a = appOf(state);
        const file = fileAt(state.files, signedPath(data));
        if (!a || !file) return false;
        return has(file.pdfText, confirmationFor(data.secret, a.id));
      },
    },
    {
      id: 'no-abandoned',
      title: 'No extra application was started and left unfinished',
      weight: 0.5,
      check: ({ state }) => state.onboard.applications.every((/** @type {any} */ a) => a.status === 'submitted'),
    },
  ],
  solve: (d, state) => fillAndFile(d, state),
};
