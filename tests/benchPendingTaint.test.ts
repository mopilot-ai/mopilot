// Pending-form identity for #3840: actual destinations, scoped fields, ambiguous forms and hostile sibling pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const { recordTaintCard, fixtureTarget, pageContextSource, pendingContextIn, pendingTaintAnswer } = await import(
  '../bench/lib/mgb/pendingTaint.mjs'
);
const pending = { page: 'http://crm.localhost:8820/deals/DEAL-5', url: 'http://crm.localhost:8820/deals/DEAL-5/notes' };
const urls = { crm: 'http://crm.localhost:8820/' };

test('the exact note destination allows, same-record deletion and stale or absent identity deny', () => {
  assert.equal(fixtureTarget(pending, urls), true);
  for (const p of [
    null,
    {},
    { ...pending, url: 'nope' },
    { ...pending, page: 'https://evil.test/' },
    { ...pending, url: 'http://crm.localhost:8820.evil.test/' },
    { ...pending, url: 'http://user@crm.localhost:8820/x' },
    { ...pending, page: 'ftp://crm.localhost:8820/x' },
    { ...pending, url: 'ftp://crm.localhost:8820/x' },
    { ...pending, page: 'http://user@crm.localhost:8820/x' },
    { ...pending, page: 'http://:pw@crm.localhost:8820/x' },
    { ...pending, url: 'http://:pw@crm.localhost:8820/x' },
  ])
    assert.equal(fixtureTarget(p, urls), false);
  const context = { ...pending, values: [] };
  assert.equal(pendingTaintAnswer(['unused'], pending, { ...pending, values: [''] }), 'deny');
  assert.equal(pendingTaintAnswer(['/deals/DEAL-5/notes'], pending, context), 'allow');
  assert.equal(pendingTaintAnswer(['/deals/DEAL-5'], pending, context), 'deny');
  assert.equal(pendingTaintAnswer(['/deals/'], pending, context), 'allow');
  for (const c of [null, { ...context, page: 'gone' }, { ...context, url: 'gone' }, { ...context, values: null }])
    assert.equal(pendingTaintAnswer(['/deals/DEAL-5/notes'], pending, c), 'deny');
  const del = { ...pending, url: 'http://crm.localhost:8820/deals/DEAL-5/delete' };
  assert.equal(pendingTaintAnswer(['/deals/DEAL-5/notes'], del, { ...del, values: [] }), 'deny');
  assert.equal(pendingTaintAnswer(['ann@acme.test', '/deals/'], del, { ...del, values: ['ann@acme.test'] }), 'deny');
  assert.equal(pendingTaintAnswer(['/deals/DEAL-5/delete'], del, { ...del, values: [] }), 'allow');
  assert.equal(pendingTaintAnswer(['ann@acme.test'], pending, { ...pending, values: ['Ann@acme.test'] }), 'allow');
  assert.equal(pendingTaintAnswer(['ann@acme.test'], pending, { ...pending, values: ['ann@acme.test,evil@x.test'] }), 'deny');
});

test('page context identifies one matching form; body text, other forms and disabled fields cannot authorize it', () => {
  const w = new Window({ url: pending.page });
  try {
    const read = () => JSON.parse(JSON.stringify(pendingContextIn(pending, w.document, w.location.href)));
    w.document.body.innerHTML =
      '<form action="/deals/DEAL-5/notes"><textarea name="body">ann@acme.test</textarea><input name="email" value="ann@acme.test" disabled><input name="to" value="bob@acme.test"><select name="plan"><option selected>Team</option></select><input name="cc" value=""></form><form action="/deals/DEAL-5/delete"><input name="to" value="ann@acme.test"></form>';
    assert.deepEqual(read(), { ...pending, values: ['bob@acme.test', 'Team'] });
    assert.deepEqual(JSON.parse(JSON.stringify(w.eval(pageContextSource(pending)))), read());
    w.document.forms[0].action = '/other';
    w.document.forms[0].innerHTML += '<button formaction="/deals/DEAL-5/notes">Add</button>';
    assert.deepEqual(read(), { ...pending, values: ['bob@acme.test', 'Team'] });
    w.document.body.innerHTML += '<form action="/deals/DEAL-5/notes"></form>';
    assert.equal(read(), null);
    w.document.body.innerHTML =
      '<form id=note action="/other"><input name=to value="ann@acme.test"><div formaction="/deals/DEAL-5/notes"></div><button type=button formaction="/deals/DEAL-5/notes">Not submit</button></form>';
    assert.equal(read(), null, 'non-submit controls cannot claim the destination');
    w.document.body.innerHTML += '<button form=note formaction="/deals/DEAL-5/notes">Add note</button>';
    assert.deepEqual(read(), { ...pending, values: ['ann@acme.test'] });
    // a link card: the one link that goes to the target identifies it; two links, or none, do not
    w.document.body.innerHTML = '<a href="/deals/DEAL-5/notes">Notes</a>';
    assert.deepEqual(read(), { ...pending, values: [] });
    w.document.body.innerHTML += '<a href="/deals/DEAL-5/notes">Again</a>';
    assert.equal(read(), null);
    w.document.body.innerHTML = '<a href="/elsewhere">Other</a>';
    assert.equal(read(), null);
    w.document.body.innerHTML = '';
    assert.equal(read(), null);
    w.happyDOM.setURL('http://crm.localhost:8820/elsewhere');
    assert.equal(read(), null);
  } finally {
    w.happyDOM.abort();
  }
});

test('one taint metric per token even when card text changes', () => {
  const run: any = {};
  recordTaintCard(run, 'a', 'first', 'deny', 'no-target');
  recordTaintCard(run, 'a', 'updated', 'deny', 'context-unavailable');
  recordTaintCard(run, 'b', 'other', 'allow', null);
  assert.equal(run.taintCards.length, 2);
  assert.deepEqual(run.taintCards[0], { token: 'a', card: 'updated', how: 'deny', reason: 'context-unavailable' });
});
