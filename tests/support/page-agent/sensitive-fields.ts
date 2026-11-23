// Page-agent sensitive-fields unit cases, using the shared DOM and agent fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { win, doc, box, define, agent, run, load, frameDoc } from './fixture';

export function registerSensitiveFieldsCases() {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test('secrets: password fields, ones the page turned into text, and fields named for a password never show their value', async () => {
    const $ = load(
      '<form id=f><input id=pw type=password value="hunter2" aria-label="Pass"><input id=named name="user_password" value="hunter3" aria-label="Named"><input id=ac autocomplete="current-password" type=text value="s3cret" aria-label="AC"><input id=pwd name="pwd" value="x9" aria-label="P"><input id=plain value="Ada" aria-label="Plain"><input id=empty type=password aria-label="Empty"><input id=cb type=checkbox name="password_remember" aria-label="Remember"></form><div id=nothing><input id=other value="ok" aria-label="Other"></div>',
    );
    // a "show password" toggle: the field is still a secret
    $('pw').setAttribute('type', 'text');
    $('plain').setAttribute('type', 'search');
    $('plain').setAttribute('type', 'text');
    await tick();
    const lines = run('tree').lines.join('\n');
    for (const s of ['hunter2', 'hunter3', 's3cret', 'x9']) assert.ok(!lines.includes(s), s);
    assert.match(lines, /textbox "Pass" value="••••"/);
    assert.match(lines, /textbox "Plain" value="Ada"/);
    assert.ok(!run('find', { query: 'pass' }).lines.join('\n').includes('hunter2'));
    const ref = (id: string) => agent.refFor($(id)).ref;
    const inspect = (id: string, what: string, name?: string) => run('inspect', { refs: [ref(id)], what, name })[0];
    assert.equal(inspect('pw', 'value'), '••••');
    assert.equal(inspect('empty', 'value'), '', 'an empty password field says so');
    assert.equal(inspect('plain', 'value'), 'Ada');
    assert.equal(inspect('pw', 'attr', 'VALUE'), '••••');
    assert.equal(inspect('pw', 'attr', 'type'), 'text');
    assert.equal(inspect('empty', 'attr', 'value'), null);
    assert.equal(inspect('plain', 'attr', 'value'), 'Ada');
    const html = inspect('f', 'innerHTML');
    for (const s of ['hunter2', 'hunter3', 's3cret', 'x9']) assert.ok(!html.includes(s), s);
    assert.match(html, /value="Ada"/);
    assert.equal($('pw').getAttribute('value'), 'hunter2', 'the page keeps its own value');
    assert.equal(inspect('nothing', 'innerHTML'), $('nothing').innerHTML);
    assert.equal(run('formInput', { ref: ref('named'), value: 'new' }).value, '••••');
    assert.equal(run('formInput', { ref: ref('cb'), value: true }).value, true, 'a checkbox is no secret');
  });

  test('intent: what a click, Enter or typing would act on - its role, name, form, and whether it is a secret or payment field', () => {
    const $ = load(
      '<form id=login><input id=u aria-label="User"><input id=p type=password aria-label="Password"><button id=go>Sign in</button><button id=show type=button>Show</button></form>' +
        '<form id=pay><label id=lab for=card>Card number</label><input id=card name="cardnumber"><select id=exp autocomplete="cc-exp-month" aria-label="Month"><option>1</option></select><input id=sub type=submit value="Pay now"></form>' +
        '<form id=change><input id=np type=password autocomplete="new-password" aria-label="New"><input id=img type=image alt="Save"></form>' +
        '<form id=search><input id=q aria-label="Q"><input name="filter"></form>' +
        '<a id=del href="/delete">Delete</a><div id=plain>Text</div><button id=lone>Alone</button>',
    );
    const at = (id: string) => run('intent', { ref: agent.refFor($(id)).ref });
    assert.deepEqual(at('go'), {
      tag: 'button',
      type: '',
      role: 'button',
      name: 'Sign in',
      button: true,
      submits: true,
      editable: false,
      secret: false,
      payment: false,
      // where it posts: the page itself when the form names no action (a tainted turn asks for a cross-origin one, G3)
      form: { secrets: 1, newPassword: false, payment: false, submit: 'Sign in', action: win.location.href },
      consent: null,
    });
    const pw = at('p');
    assert.deepEqual([pw.secret, pw.editable, pw.submits, pw.form.submit], [true, true, false, 'Sign in']);
    // a plain button in a form carries the form too (a "Pay" button that is no submit still sends payment details)
    assert.deepEqual([at('show').submits, at('show').form?.submit], [false, 'Sign in']);
    const card = at('card');
    assert.deepEqual([card.payment, card.form.payment, card.form.submit], [true, true, 'Pay now']);
    assert.equal(at('exp').payment, true);
    assert.deepEqual([at('sub').submits, at('sub').name], [true, 'Pay now']);
    assert.deepEqual([at('img').submits, at('img').form.newPassword], [true, true]);
    assert.deepEqual(at('q').form, { secrets: 0, newPassword: false, payment: false, submit: '', action: win.location.href });
    assert.deepEqual([at('del').button, at('del').role, at('del').name], [true, 'link', 'Delete']);
    assert.deepEqual([at('lone').submits, at('lone').form], [false, null]);
    const plain = run('intent', { ref: agent.refFor($('plain')).ref });
    assert.deepEqual([plain.tag, plain.button, plain.form], ['div', false, null]);
    assert.equal(run('intent', { ref: 'ref_999999' }), null, 'a stale ref');
    assert.equal(at('go').payment, false);
  });

  test('intent: a form whose card fields live in a payment provider frame holds payment details; other frames do not', () => {
    const $ = load(
      '<form id=stripe><iframe name="__privateStripeFrame5" title="Secure card payment input frame"></iframe><button id=pay type=button>Pay $49.00</button></form>' +
        '<form id=bt><iframe id="braintree-hosted-field-number"></iframe><button id=bpay>Place order</button></form>' +
        '<form id=chat><iframe title="Video"></iframe><button id=send>Send</button></form>',
    );
    const at = (id: string) => run('intent', { ref: agent.refFor($(id)).ref });
    assert.deepEqual([at('pay').submits, at('pay').form.payment], [false, true]);
    assert.equal(at('bpay').form.payment, true);
    assert.equal(at('send').form.payment, false);
  });

  test('a sign-in field MoPilot filled is masked, but a sign-in form is still not a password change', () => {
    const $ = load(
      '<form id=login><input id=u aria-label="User" autocomplete="username"><input id=p type=password aria-label="Password"><button id=go>Sign in</button></form>',
    );
    const at = (id: string) => run('intent', { ref: agent.refFor($(id)).ref });
    assert.equal(at('go').form.secrets, 1);
    assert.equal(run('credentialFocus', { ref: agent.refFor($('u')).ref, origin: win.location.origin }).ok, true);
    assert.equal(at('u').secret, true, 'the filled username is masked from now on');
    assert.deepEqual(
      at('go').form,
      { secrets: 1, newPassword: false, payment: false, submit: 'Sign in', action: win.location.href },
      'one password: a sign-in, not "change a password"',
    );
    assert.equal(run('credentialFocus', { ref: agent.refFor($('p')).ref, origin: win.location.origin }).ok, true);
    assert.equal(at('go').form.secrets, 1, 'the password is still the one password, filled or not');
    // a field named "action" shadows form.action: where the form really posts still comes from the form (#3879 review)
    const $$ = load('<form id=f2><input id=act name=action><button id=go2>Go</button></form>');
    // as browsers do (the test DOM doesn't): form.action is the field
    Object.defineProperty($$('f2'), 'action', { value: $$('act') });
    assert.equal(run('intent', { ref: agent.refFor($$('go2')).ref }).form.action, win.location.href);
  });

  test('#3840: the clicked submit button owns its form action, including override destinations', () => {
    const $ = load(
      '<form action="/notes"><input id=field><button id=note>Add note</button><button id=del formaction="/delete">Delete</button></form>',
    );
    const at = (id: string) => run('intent', { ref: agent.refFor($(id)).ref });
    assert.equal(at('note').form.action, 'https://site.test/notes');
    assert.equal(at('del').form.action, 'https://site.test/delete');
    assert.equal(at('field').form.action, 'https://site.test/notes');
  });

  test('#3879 review: Enter submits through the default button, even one outside the form that overrides its address', () => {
    const $ = load(
      '<button id=out form=f formaction="https://evil.test/x">Go</button><form id=f action="/ok"><input id=q><button id=save>Save</button></form>',
    );
    const q = run('intent', { ref: agent.refFor($('q')).ref });
    assert.equal(q.form.action, 'https://evil.test/x');
    assert.equal(q.form.submit, 'Go');
    // the button pressed still owns its own address; a form with no submit button posts to its action
    assert.equal(run('intent', { ref: agent.refFor($('save')).ref }).form.action, 'https://site.test/ok');
    // a button with an empty or unknown type is a submit button too, by the browser's normalized type (set by hand: the test DOM keeps the raw value)
    const $t = load('<form action="/ok"><input id=t><button id=typed type="" formaction="https://evil.test/y">Go</button></form>');
    Object.defineProperty($t('typed'), 'type', { value: 'submit' });
    assert.equal(run('intent', { ref: agent.refFor($t('t')).ref }).form.action, 'https://evil.test/y');
    assert.equal(run('intent', { ref: agent.refFor($t('typed')).ref }).submits, true);
    // a link with a type attribute is no submit button, and doesn't take the default button's place
    const $l = load('<form action="/ok"><a id=link href="#" type="submit">More</a><input id=f3><button id=b3>Save</button></form>');
    Object.defineProperty($l('link'), 'type', { value: 'submit' });
    assert.equal(run('intent', { ref: agent.refFor($l('link')).ref }).submits, false);
    assert.equal(run('intent', { ref: agent.refFor($l('f3')).ref }).form.submit, 'Save');
    const $$ = load('<form action="/ok"><input id=lone></form>');
    assert.equal(run('intent', { ref: agent.refFor($$('lone')).ref }).form.action, 'https://site.test/ok');
  });

  test('intent by point: through shadow roots and same-origin frames; a label clicks its control; a cross-origin frame is named for main to follow', () => {
    const $ = load(
      '<label id=lab for=cvv>Security code</label><input id=cvv aria-label="CVV"><span id=host></span><iframe id=same></iframe><iframe id=cross></iframe><iframe id=nulldoc></iframe><div id=bare>x</div>',
    );
    const sr = $('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id=deep>Delete</button>';
    const inner = frameDoc(box($('same'), 100, 50, 300, 200), '<button id=fb>Send</button>');
    define($('cross'), 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    define($('nulldoc'), 'contentDocument', { get: () => null });
    let under: any = null;
    const points: any[] = [];
    define(doc, 'elementFromPoint', { value: (x: number, y: number) => (points.push(['top', x, y]), under) });
    define(inner, 'elementFromPoint', { value: (x: number, y: number) => (points.push(['frame', x, y]), inner.getElementById('fb')) });
    try {
      const at = () => run('intent', { x: 120, y: 70 });
      under = $('lab');
      assert.deepEqual([at().tag, at().payment, at().name], ['input', true, 'CVV']);
      under = $('host');
      define(sr, 'elementFromPoint', { value: () => sr.getElementById('deep') });
      assert.deepEqual([at().tag, at().name], ['button', 'Delete']);
      define(sr, 'elementFromPoint', { value: () => $('host') });
      assert.equal(at().tag, 'span');
      define(sr, 'elementFromPoint', { value: () => null });
      assert.equal(at().tag, 'span');
      under = $('same');
      points.length = 0;
      assert.deepEqual([at().tag, at().name], ['button', 'Send']);
      assert.deepEqual(points.slice(0, 2), [
        ['top', 120, 70],
        ['frame', 20, 20],
      ]);
      // CM-J08: a cross-origin frame is named by its ref, with the point inside it, for main to follow
      under = box($('cross'), 100, 50, 300, 200);
      assert.deepEqual(at(), { frame: true, owner: agent.refFor($('cross')).ref, x: 20, y: 20 });
      under = $('nulldoc');
      assert.deepEqual(at(), { frame: true, owner: agent.refFor($('nulldoc')).ref, x: 120, y: 70 });
      under = null;
      assert.equal(at(), null);
      under = $('bare').firstChild;
      assert.equal(at(), null, 'not an element');
      // a point without both coordinates is the focused element instead
      assert.equal(run('intent', { x: 1 }).tag, 'body');
    } finally {
      delete doc.elementFromPoint;
    }
  });

  test('intent by focus: through shadow roots and same-origin frames; a cross-origin frame is named by its ref for main to follow', () => {
    const $ = load(
      '<div><div><textarea id=msg aria-label="Message"></textarea></div><button>Send</button></div><div id=quiet><textarea id=note aria-label="Note"></textarea><button>Bold</button></div><span id=host></span><iframe id=same></iframe><iframe id=cross></iframe>',
    );
    $('msg').focus();
    const msg = run('intent', {});
    assert.deepEqual(
      [msg.tag, msg.editable, msg.form],
      ['textarea', true, { secrets: 0, newPassword: false, payment: false, submit: 'Send' }],
    );
    $('note').focus();
    assert.equal(run('intent', {}).form.submit, '', 'buttons nearby, none of them a send');
    // focus inside a shadow root
    const sr = $('host').attachShadow({ mode: 'open' });
    sr.innerHTML = '<input id=si type=password aria-label="PIN">';
    define(doc, 'activeElement', { get: () => $('host') });
    define(sr, 'activeElement', { get: () => sr.getElementById('si') });
    try {
      assert.equal(run('intent', {}).secret, true);
      // a same-origin frame's focused element; a cross-origin frame is opaque
      const inner = frameDoc($('same'), '<input id=fi aria-label="Inner">');
      define(doc, 'activeElement', { get: () => $('same') });
      define(inner, 'activeElement', { get: () => inner.getElementById('fi') });
      assert.equal(run('intent', {}).name, 'Inner');
      define(inner, 'activeElement', { get: () => null });
      assert.equal(run('intent', {}), null);
      define($('cross'), 'contentDocument', {
        get: () => {
          throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
        },
      });
      define(doc, 'activeElement', { get: () => $('cross') });
      // CM-J08: main follows the frame's ref into that frame
      assert.deepEqual(run('intent', {}), { frame: true, owner: agent.refFor($('cross')).ref });
    } finally {
      delete doc.activeElement;
    }
    // a field with no buttons anywhere around it
    load('<textarea id=alone aria-label="Alone"></textarea>');
    doc.getElementById('alone').focus();
    assert.equal(run('intent', {}).form, null);
  });

  test('mask: password fields go transparent for a screenshot (same-origin frames too) and come back as they were', () => {
    const $ = load(
      '<input id=a type=password value=x style="color: red;"><input id=b type=password><input id=c value=plain><iframe id=same></iframe><iframe id=cross></iframe><iframe id=nulldoc></iframe>',
    );
    const inner = frameDoc($('same'), '<input id=fi type=password>');
    define($('cross'), 'contentDocument', {
      get: () => {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame', 'SecurityError');
      },
    });
    define($('nulldoc'), 'contentDocument', { get: () => null });
    assert.deepEqual(run('mask'), { count: 3 });
    for (const el of [$('a'), $('b'), inner.getElementById('fi')]) assert.match(el.getAttribute('style'), /color: transparent/);
    assert.equal($('c').getAttribute('style'), null);
    assert.deepEqual(run('mask', { on: true }), { count: 3 }, 'masking twice keeps the first state');
    assert.deepEqual(run('mask', { on: false }), { count: 3 });
    assert.equal($('a').getAttribute('style'), 'color: red;');
    assert.equal($('b').hasAttribute('style'), false);
    assert.equal(inner.getElementById('fi').hasAttribute('style'), false);
    assert.deepEqual(run('mask', { on: false }), { count: 0 });
  });
}
