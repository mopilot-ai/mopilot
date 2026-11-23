// MGB task f5-hiring-research (#1381): audited on every seed; the role page's rule picks two candidates and a namesake
// with more years would change that; brief lines are read as people write them; and plausible wrong agents fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { FILE, KEYS, briefFor, briefOk, candidate, shortlistedTitle, task } = await import('../bench/lib/mgb/tasks/f5HiringResearch.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const solved = (seed = 's1') => {
  const s = setup(seed);
  task.solve(s.data, s.state, s.env);
  return s;
};
/** Shortlists two people in the CRM (each a candidate or the namesake), writes a brief and mails the manager. */
function agent(data: any, state: any, pick: any[], o: { brief?: string; browser?: string } = {}) {
  const docs = browse(state, 'docs');
  for (const id of ['PG-1', ...data.pageIds]) docs.get(`/p/${id}`);
  putFile(state, FILE, Buffer.from(o.brief ?? briefFor(data), 'utf8'));
  const crm = browse(state, 'crm');
  for (const c of pick) {
    const acc = state.crm.contacts.find((x: any) => x.id === c.contact).accountId;
    crm.post(`/contacts/${c.contact}`, { name: c.name, email: c.email, title: shortlistedTitle(data), accountId: acc });
    crm.post(`/deals/${c.deal}/notes`, { note: `Panel code ${data.panel}` });
  }
  for (const e of state.crm.events) Object.assign(e, { via: 'browser', browser: o.browser ?? 'chrome' });
  browse(state, 'mail').post('/compose', { to: data.manager.email, subject: 'Shortlist', body: pick.map((c) => c.name).join(' and ') });
  return state;
}

test('f5-hiring-research runs only in the full tier', () => {
  assert.equal(task.tier, 'full');
});

test('the data: the rule shortlists a and b, the namesake outranks b, and top skills need the role list', () => {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    const { data, state } = setup(seed);
    const [a, b, c, d] = data.candidates;
    const byYears = [...data.candidates].sort((x: any, y: any) => y.years - x.years);
    assert.deepEqual(
      byYears.slice(0, 2).map((x: any) => x.key),
      ['a', 'b'],
    );
    assert.ok(data.namesake.years > b.years, 'confusing the namesake changes the shortlist');
    assert.equal(data.namesake.name, c.name);
    assert.notEqual(data.namesake.email, c.email);
    for (const p of [a, b, c, d]) {
      const sum = p.jobs.reduce((n: number, j: any) => n + j.to - j.from, 0);
      assert.equal(sum, p.years, 'the years are the work history');
      assert.ok(!data.must.includes(p.skills[0].name), 'the most endorsed skill is off the list');
      const onList = p.skills.filter((s: any) => data.must.includes(s.name));
      assert.equal(onList.sort((x: any, y: any) => y.endorsements - x.endorsements)[0].name, p.top);
    }
    const ids = state.crm.contacts.map((x: any) => x.id);
    assert.equal(new Set(ids).size, 5);
    assert.equal(state.docs.pages.filter((p: any) => p.title === `${c.name}: profile`).length, 2, 'two pages share the title');
  }
});

test('brief lines: the name, the years and the skill on one line', () => {
  const c = { name: 'Lena Haddad', years: 7, top: 'SQL' };
  assert.ok(briefOk('| Lena Haddad | 7 years | SQL |', c));
  assert.ok(briefOk('# Brief\n- lena haddad: 7 yrs; best skill: sql', c));
  assert.ok(!briefOk('Lena Haddad: 9 years, SQL', c), 'another number');
  assert.ok(!briefOk('Lena Haddad: 7 years, Python', c), 'another skill');
  assert.ok(!briefOk('Lena Haddad: 7 years\nTop skill: SQL', c), 'split over two lines');
  assert.ok(!briefOk('', c));
});

test('the oracle shortlists a and b and mails the manager once', () => {
  const { env, data, state } = solved('s3');
  assert.deepEqual(
    state.crm.contacts
      .filter((x: any) => x.title !== 'Candidate')
      .map((x: any) => x.name)
      .sort(),
    [data.candidates[0].name, data.candidates[1].name].sort(),
  );
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
  for (const k of KEYS) assert.ok(briefOk(state.files.entries[FILE].text, candidate(data, k)), k);
});

test('plausible wrong agents do not pass', () => {
  // all right, but the CRM updated in the in-app browser instead of the user's Chrome
  {
    const { env, data, state } = setup();
    agent(data, state, data.candidates.slice(0, 2), { browser: 'app-browser' });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['crm-in-chrome']);
  }
  // the namesake's years read for candidate c: c is shortlisted instead of b, and the namesake's CRM record updated
  {
    const { env, data, state } = setup('s2');
    const c = candidate(data, 'c');
    const brief = briefFor(data).replace(`${c.name}: ${c.years} years`, `${c.name}: ${data.namesake.years} years`);
    agent(data, state, [candidate(data, 'a'), data.namesake], { brief });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), [
      'brief-c',
      'titles',
      'no-other-titles',
      'panel-notes',
      'no-other-notes',
      'mail-shortlist',
    ]);
  }
  // each candidate's most endorsed skill given, not the top one on the role's list
  {
    const { env, data, state } = solved('s3');
    let text = state.files.entries[FILE].text;
    for (const p of data.candidates) text = text.replace(`top skill ${p.top}`, `top skill ${p.skills[0].name}`);
    putFile(state, FILE, Buffer.from(text, 'utf8'));
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['brief-a', 'brief-b', 'brief-c', 'brief-d']);
  }
  // no brief line for d, no mail to the manager, and the pages read in Chrome
  {
    const { env, data, state } = solved();
    const d = candidate(data, 'd');
    putFile(state, FILE, Buffer.from(briefFor(data).replace(new RegExp(`.*${d.name}.*\\n?`), ''), 'utf8'));
    state.mail.messages = state.mail.messages.filter((m: any) => m.folder !== 'sent');
    for (const e of state.docs.events) Object.assign(e, { via: 'browser', browser: 'chrome' });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['brief-d', 'mail-shortlist', 'research-in-app']);
  }
  // the shortlist mailed twice
  {
    const { env, data, state } = solved('s2');
    const [a, b] = data.candidates;
    browse(state, 'mail').post('/compose', { to: data.manager.email, subject: 'Shortlist again', body: `${a.name}, ${b.name}` });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['mail-shortlist']);
  }
});
