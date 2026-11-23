// MGB task f2-supplier-forms (#1381): beside the audit (benchMgbAudit.test.ts), the forms are real PDFs only the download
// reveals, and plausible wrong agents (the duplicate onboarded too, a typo, no attachment, download names) fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { bodyBytes, pdfTextOf, putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { PAGE, filedAs, task } = await import('../bench/lib/mgb/tasks/f2SupplierForms.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const page = (state: any) => state.docs.pages.find((p: any) => p.title === PAGE);

/** A whole run with one mistake or another; each flag is a different wrong agent. */
function agent(
  data: any,
  state: any,
  o: { dupAsNew?: boolean; email?: string; attach?: boolean; body?: string; fileAs?: (f: any) => string } = {},
) {
  const docs = browse(state, 'docs');
  const pdfs: Record<string, Buffer> = {};
  data.order.forEach((k: string, i: number) => {
    pdfs[k] = bodyBytes(docs.get(`/p/${page(state).id}/att/${i}`));
    putFile(state, (o.fileAs ?? filedAs)(data[k]), pdfs[k]);
  });
  const onboard = (k: string, accountId: string) => {
    const f = data[k];
    browse(state, 'crm').post('/contacts', { name: f.contact.name, title: f.title, email: o.email ?? f.email, phone: f.phone, accountId });
    browse(state, 'tracker').post('/issues', {
      fields: { title: `Legal review: ${f.company}`, body: o.body ?? `Tax ID ${f.taxId}`, priority: 'medium' },
      files: o.attach === false ? [] : [{ field: 'attach', name: 'form.pdf', type: 'application/pdf', content: pdfs[k] }],
    });
  };
  onboard('fresh', 'ACC-12');
  if (o.dupAsNew) onboard('dup', 'ACC-11');
  else browse(state, 'crm').post('/deals/DEAL-31/notes', { note: `Duplicate registration, tax ID ${data.dup.taxId}` });
  return state;
}

test('the data: two PDF forms named only by number, one company already active in the CRM', () => {
  const { env, data, state } = setup();
  const atts = page(state).attachments;
  assert.deepEqual(
    atts.map((a: any) => a.name),
    ['supplier-registration-1.pdf', 'supplier-registration-2.pdf'],
  );
  for (const [i, k] of data.order.entries()) {
    const text = pdfTextOf(atts[i].data);
    for (const v of [data[k].company, data[k].taxId, data[k].email, data[k].phone, data[k].terms]) assert.ok(text.includes(v), v);
  }
  const acc = (id: string) => state.crm.accounts.find((a: any) => a.id === id);
  assert.deepEqual([acc('ACC-11').name, acc('ACC-11').tier], [data.dup.company, 'Active']);
  assert.deepEqual([acc('ACC-12').name, acc('ACC-12').tier], [data.fresh.company, 'Pending']);
  assert.equal(state.crm.contacts.filter((c: any) => c.accountId === 'ACC-12').length, 0);
  assert.notEqual(data.dup.contact.name, data.keeper.name, 'the duplicate’s form names someone the CRM does not have yet');
  const prompt = task.prompt(data, env).join('\n');
  for (const s of [data.fresh.company, data.dup.company]) assert.ok(!prompt.includes(s), 'the prompt names neither company');
});

test('the oracle-like agent passes; onboarding the duplicate as well fails only the duplicate checks', () => {
  {
    const { env, data, state } = setup('s2');
    assert.equal(gradeTask({ task, data, state: agent(data, state), env }).verdict, 'PASS');
  }
  const { env, data, state } = setup('s2');
  const g = gradeTask({ task, data, state: agent(data, state, { dupAsNew: true }), env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['dup-note', 'no-duplicate']);
});

test('plausible wrong agents do not pass', () => {
  // a typo in the email and no form attached to the issue
  {
    const { env, data, state } = setup();
    agent(data, state, { email: data.fresh.email.replace('@', '1@'), attach: false });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['contact-values', 'legal-pdf']);
  }
  // the issue without the tax ID: the canary misses
  {
    const { env, data, state } = setup('s3');
    agent(data, state, { body: `Payment terms: ${data.fresh.terms}` });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['legal-tax-id']);
    assert.equal(g.verdict, 'FAIL');
  }
  // the forms kept under their download names
  {
    const { env, data, state } = setup('s2');
    agent(data, state, { fileAs: (f: any) => `suppliers/supplier-registration-${f === data.fresh ? 'a' : 'b'}.pdf` });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['file-fresh', 'file-dup']);
  }
  // a re-saved copy is not the downloaded form, and two contacts on the pending account are one too many
  {
    const { env, data, state } = setup();
    agent(data, state);
    putFile(state, filedAs(data.dup), Buffer.from('%PDF-1.4\nprinted again\n%%EOF\n', 'latin1'));
    const f = data.fresh;
    browse(state, 'crm').post('/contacts', { name: f.contact.name, title: f.title, email: f.email, phone: f.phone, accountId: 'ACC-12' });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['contact-new', 'file-dup']);
  }
});
