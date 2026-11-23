// MGB task f2-onboarding (#1381): beside the audit (benchMgbAudit.test.ts), its oracle completes the wizard through the apps'
// own routes, and plausible wrong agents (old phone, cancelled passport, wrong file name, an abandoned draft) fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { validAccount, validDocNumber } = await import('../bench/lib/mgb/apps/onboard.mjs');
const { CONFIRM_LINE, confirmationFor, fillAndFile, signedPath, task } = await import('../bench/lib/mgb/tasks/f2Onboarding.mjs');

const setup = (seed = 's1') => setupTask(task, seed);

test('the data: valid documents, a Monday start, a corrected phone and the folder’s naming pattern', () => {
  const { env, data, state } = setup();
  assert.ok(validDocNumber(data.passport) && validDocNumber(data.oldPassport), 'both passports pass the check digit');
  assert.notEqual(data.passport, data.oldPassport);
  assert.ok(validAccount(data.accountShown) && data.accountShown.includes(' '));
  assert.equal(new Date(`${data.start}T12:00:00Z`).getUTCDay(), 1);
  assert.ok(data.start > data.after && data.start > env.today);
  assert.notEqual(data.hire.phone, data.oldPhone);
  const hr = state.mail.messages[0];
  assert.ok(hr.cc.includes(data.manager.email) && hr.body.includes(data.manager.name));
  assert.ok(!hr.body.includes(data.passport), 'the passport number is only in the scan');
  assert.ok(Buffer.from(hr.attachments[0].data, 'base64').toString('utf8').includes(data.passport));
  assert.ok(state.mail.messages[1].body.includes(data.hire.phone));
  const examples = Object.keys(state.files.entries);
  assert.equal(examples.length, 3);
  for (const p of examples) assert.match(p, /^signed\/[A-Z][a-z]+, [A-Z][a-z]+ - \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(signedPath(data), /^signed\/[A-Z][a-z]+, [A-Z][a-z]+ - \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.ok(!examples.includes(signedPath(data)));
  assert.ok(!task.prompt(data, env).join('\n').includes('signed/'), 'the pattern is not stated');
});

test('the oracle files the signed copy with the confirmation the wizard gave', () => {
  const { env, data, state } = setup('s2');
  task.solve(data, state, env);
  const [app] = state.onboard.applications;
  assert.equal(app.confirmation, confirmationFor(data.secret, app.id));
  assert.ok(state.files.entries[signedPath(data)].pdfText.includes(app.confirmation));
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
});

test('plausible wrong agents do not pass', () => {
  // the phone from the first email and the cancelled passport: both still pass the forms' checks
  {
    const { env, data, state } = setup();
    fillAndFile(data, state, { phone: data.oldPhone, passport: data.oldPassport });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['step-personal', 'identity']);
  }
  // off by a week: the Monday after the first Monday
  {
    const { env, data, state } = setup('s2');
    const late = new Date(`${data.start}T12:00:00Z`);
    late.setUTCDate(late.getUTCDate() + 7);
    fillAndFile(data, state, { start: late.toISOString().slice(0, 10) });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['step-employment']);
  }
  // the signed copy kept under its download name: neither the file nor its confirmation is where it belongs
  {
    const { env, data, state } = setup('s3');
    fillAndFile(data, state, { signedAs: 'signed/signed-APP-1.pdf' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['signed-copy', 'signed-confirmation']);
    assert.equal(g.verdict, 'FAIL');
  }
  // a draft started and left behind, and a declaration without the name: the abandoned draft fails the run
  {
    const { env, data, state } = setup();
    browse(state, 'onboard').post('/start');
    fillAndFile(data, state, { declaration: ['Declaration', CONFIRM_LINE] });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['declaration-text', 'no-abandoned']);
    assert.equal(g.verdict, 'FAIL');
  }
  // two submitted applications: the second signed copy replaces the first, so its confirmation is not the first's
  {
    const { env, data, state } = setup('s2');
    fillAndFile(data, state);
    fillAndFile(data, state);
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['submitted-once', 'signed-confirmation']);
  }
});

test('a TextEdit PDF whose text cannot be read costs only the optional check, with the reason', () => {
  const { env, data, state } = setup('s3');
  task.solve(data, state, env);
  // embedded font subsets draw glyph codes, not text: stands in as a PDF with no readable strings
  state.onboard.applications[0].declaration.data = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1').toString('base64');
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'PASS');
  const text: any = g.checkpoints.find((c: any) => c.id === 'declaration-text');
  assert.deepEqual([text.met, text.required, text.why], [false, false, 'no text could be read from the PDF']);
  assert.ok(g.score < 1);
});
