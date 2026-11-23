// Approval identity survives asynchronous operator decisions; retries retain deny and never act on a replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
const { approvalPoint, answerOwnedApproval } = await import('../bench/lib/mgb/approvalOwner.mjs');

test('a replacement during the answer is untouched; a missed deny stays deny on retry', async () => {
  const w = new Window();
  try {
    w.document.body.innerHTML =
      '<div class="approval-card" data-edge-token="one"><button class="ap-btn allow">Allow</button><button class="ap-btn deny">Deny</button></div>';
    const c = w.document.querySelector('.approval-card')! as any;
    const card = { token: 'one', text: c.innerText, actionTarget: null };
    let settle!: (v: string) => void;
    const clicks: any[] = [];
    const answers = new Map();
    const o = {
      answers,
      answer: () =>
        new Promise<string>((r) => {
          settle = r;
        }),
      number: 0,
      ev: async (js: string) => w.eval(js),
      click: async (p: any) => {
        clicks.push(JSON.parse(JSON.stringify(p)));
      },
      scopeCards: '.scope',
    };
    const pending = answerOwnedApproval(card, o);
    c.dataset.edgeToken = 'two';
    settle('allow');
    await pending;
    assert.deepEqual(clicks, []);
    c.dataset.edgeToken = 'one';
    const deny = c.querySelector('.deny');
    deny.getBoundingClientRect = () => ({ x: 10, y: 20, width: 2, height: 2 });
    deny.scrollIntoView = () => {};
    answers.clear();
    o.answer = async () => 'deny';
    await answerOwnedApproval(card, o);
    o.answer = async () => {
      throw new Error('must reuse decision');
    };
    await answerOwnedApproval(card, o);
    assert.deepEqual(clicks, [
      { x: 11, y: 21 },
      { x: 11, y: 21 },
    ]);
    deny.remove();
    await answerOwnedApproval(card, o);
    assert.equal(clicks.length, 2, 'missing deny cannot fall through to allow');
    await answerOwnedApproval(
      { ...card, token: 'unknown' },
      {
        ...o,
        answer: async () => 'invalid',
        ev: async () => {
          throw new Error('gone');
        },
      },
    );
    assert.equal(clicks.length, 2);
  } finally {
    w.happyDOM.abort();
  }
});

test('points reject stale target/text and handle radio, scoped, ordinary and question controls', async () => {
  const w = new Window();
  try {
    const read = (html: string, how = 'allow', extra: any = {}) => {
      w.document.body.innerHTML = html;
      const c = w.document.querySelector('.approval-card') as any;
      if (c) {
        c.dataset.edgeToken = 'one';
        for (const b of w.document.querySelectorAll('button')) {
          b.scrollIntoView = () => {};
          b.getBoundingClientRect = () => ({ x: 0, y: 0, width: 2, height: 2 }) as any;
        }
      }
      return approvalPoint(w.document, { token: 'one', text: c?.innerText, actionTarget: null, ...extra }, how, '.scope');
    };
    assert.equal(read(''), null);
    assert.deepEqual(read('<div class="approval-card"><button class="ap-btn deny">Deny</button></div>', 'deny'), { x: 1, y: 1 });
    assert.equal(read('<div class="approval-card"><button class="ap-btn allow">Allow</button></div>', 'deny'), null);
    assert.equal(read('<div class="approval-card">x</div>', 'allow', { text: 'old' }), null);
    assert.equal(read('<div class="approval-card"><span data-action-target="{}"></span></div>'), null);
    assert.equal(read('<div class="approval-card"><button class="ap-btn allow" disabled>Allow</button></div>'), null);
    assert.equal(read('<div class="approval-card"></div>', 'read-only'), null);
    assert.deepEqual(read('<div class="approval-card"><button class="ap-btn allow">Allow</button></div>'), { x: 1, y: 1 });
    assert.deepEqual(read('<div class="approval-card"><button class="btn primary">Go</button></div>'), { x: 1, y: 1 });
    assert.deepEqual(read('<div class="approval-card question-card"><button>Other</button><button>Skip</button></div>'), { x: 1, y: 1 });
    assert.deepEqual(
      read(
        '<div class="approval-card"><div class="sage-levels"><button role=radio>Write</button><button role=radio aria-checked=false>Read only</button></div></div>',
        'read-only',
      ),
      { x: 1, y: 1 },
    );
    assert.deepEqual(
      read(
        '<div class="approval-card"><div class="sage-levels"><button role=radio aria-checked=true>Read only</button></div><button class="ap-btn allow">Allow</button></div>',
        'read-only',
      ),
      { x: 1, y: 1 },
    );
    assert.deepEqual(read('<div class="approval-card scope"><div class="ap-split"><button class=chevron>Scopes</button></div></div>'), {
      x: 1,
      y: 1,
    });
    assert.deepEqual(
      read(
        '<div class="approval-card scope"><div class="ap-split"><button class=chevron>Scopes</button></div></div><div class=popover-layer><button role=menuitem>Other</button><button role=menuitem>Allow once</button></div>',
      ),
      { x: 1, y: 1 },
    );
    let clicks = 0;
    await answerOwnedApproval(
      { token: 'q', text: '', actionTarget: null, q: true },
      {
        answers: new Map(),
        answer: async () => 'deny',
        number: 0,
        ev: async () => null,
        click: async () => clicks++,
        scopeCards: '.scope',
      },
    );
    await answerOwnedApproval(
      { token: 'q', text: '', actionTarget: null },
      { answers: new Map(), answer: undefined, number: 0, ev: async () => null, click: async () => clicks++, scopeCards: '.scope' },
    );
    assert.equal(clicks, 0);
  } finally {
    w.happyDOM.abort();
  }
});
