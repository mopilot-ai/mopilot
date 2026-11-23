// Bot checks and CAPTCHAs (#1615, E-S4b): which targets the page agent and Your Chrome's reader call part of a bot check
// (electron/capabilities/browser/botCheck.cjs botCheckIn), with ordinary checkboxes and buttons left alone, and the
// refusal botCheckRefusal() gives each action and route. happy-dom pages; the page agent and the reader are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { pageAgent, PAGE_AGENT_SOURCE } = require('../electron/capabilities/browser/pageAgent.cjs');
const { ELEMENT_INTENT, FOCUS_INTENT } = require('../electron/capabilities/browser/chromeIntent.cjs');
const { botCheckIn, botCheckRefusal, HANDOFF } = require('../electron/capabilities/browser/botCheck.cjs');
const { CONSENT_SOURCE } = require('../electron/capabilities/browser/consent.cjs');
const { labelText } = require('../shared/labelText.mjs');
const { shadowKit } = require('../electron/capabilities/browser/pageAgentShadow.cjs');
const { anchorKit } = require('../electron/capabilities/browser/pageAgentAnchor.cjs');
const { needsIntent } = require('../electron/capabilities/browser/siteRisk.cjs');
const { explainRefusal } = require('../electron/capabilities/browser/refusals.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');

const PAGE =
  // the edge suite's fixture (bench/lib/edgePages.mjs /s/bot-check)
  `<label id="robot-label"><input type="checkbox" id="human"> I'm not a robot</label>` +
  `<button id="verify">Verify you are human</button>` +
  `<div role="checkbox" id="aria-box" aria-labelledby="none aria-label-text"><span id="aria-inner">☐</span></div><span id="aria-label-text">I am human</span>` +
  `<div role="switch" id="named-switch" aria-label="Confirm you're human"></div>` +
  `<div class="g-recaptcha" data-sitekey="k"><div><span id="widget-inner">tick</span></div></div>` +
  `<div class="cf-turnstile"><input type="checkbox" id="turnstile-box"></div>` +
  // negatives
  `<label><input type="checkbox" id="agree"> I agree to the terms</label>` +
  `<button class="g-recaptcha" data-sitekey="k" id="invisible">Submit</button>` +
  `<a href="/why" id="why">Why do I have to verify you're human?</a>` +
  `<p id="text">We noticed unusual activity. I'm not a robot</p>` +
  `<button id="hr">Human resources</button>` +
  `<input type="text" id="field" aria-label="I'm not a robot">` +
  `<input type="checkbox" id="unnamed">` +
  `<label><input type="checkbox" id="hr-pro"> I'm a human resources professional</label>` +
  `<label><input type="checkbox" id="readable"> I am human-readable output</label>` +
  `<label><input type="checkbox" id="i-am-human"> I am human</label>` +
  `<iframe id="recaptcha-frame" src="https://www.google.com/recaptcha/api2/anchor?k=1" title="reCAPTCHA"></iframe>` +
  `<iframe id="hcaptcha-frame" title="Widget containing checkbox for hCaptcha security challenge"></iframe>` +
  `<iframe id="turnstile-frame" src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2"></iframe>` +
  `<iframe id="video-frame" src="https://www.youtube.com/embed/x" title="Video"></iframe>`;

/** A happy-dom page at `url` with `html`, as the document the page agent reads, for the duration of `run`. */
function onPage(url: string, html: string, run: (win: Window) => void) {
  const win = new Window({ url });
  const G: any = globalThis;
  const saved = { document: G.document, getComputedStyle: G.getComputedStyle };
  win.document.body.innerHTML = html;
  G.document = win.document;
  G.getComputedStyle = (el: any) => win.getComputedStyle(el);
  try {
    run(win);
  } finally {
    Object.assign(G, saved);
    win.close();
  }
}

/** Both readers of what an action acts on: the in-app browser's page agent (by ref) and Your Chrome's reader. */
function readers(win: Window) {
  const agent = pageAgent();
  const chrome = new win.Function(`return (${ELEMENT_INTENT})`)();
  const el = (id: string) => win.document.getElementById(id);
  return {
    iab: (id: string) => agent.call('intent', { ref: agent.refFor(el(id)).ref }).value,
    chrome: (id: string) => chrome(el(id)),
  } as Record<string, (id: string) => any>;
}

test('a bot check is recognized by its name and role, by a provider widget, and by a provider frame, in the page agent and in Your Chrome', () => {
  onPage('https://shop.test/', PAGE, (win) => {
    for (const [reader, read] of Object.entries(readers(win))) {
      for (const id of [
        'human',
        'robot-label',
        'verify',
        'aria-inner',
        'aria-box',
        'named-switch',
        'widget-inner',
        'turnstile-box',
        'i-am-human',
      ])
        assert.equal(read(id)?.botCheck, true, `${reader}: ${id} is a bot check`);
      for (const id of ['agree', 'invisible', 'why', 'text', 'hr', 'field', 'unnamed', 'video-frame', 'hr-pro', 'readable'])
        assert.ok(!read(id)?.botCheck, `${reader}: ${id} is not a bot check`);
    }
    // the fixture's checkbox keeps its name, so the refusal can quote it
    assert.equal(readers(win).iab('human').name, "I'm not a robot");
  });
});

test("a provider's frame whose document can't be read is a bot check by its address or title; an ordinary frame is not", () => {
  onPage('https://shop.test/', PAGE, (win) => {
    const el = (id: string) => win.document.getElementById(id);
    for (const id of ['recaptcha-frame', 'hcaptcha-frame', 'turnstile-frame']) assert.equal(botCheckIn(el(id), el(id), ''), true, id);
    assert.equal(botCheckIn(el('video-frame'), el('video-frame'), ''), false);
  });
});

test("anything inside a provider's own frame is a bot check, whatever it is named", () => {
  for (const url of [
    'https://www.google.com/recaptcha/api2/bframe?k=1',
    'https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html',
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2',
    'https://client-api.arkoselabs.com/fc/gc/',
  ])
    onPage(url, '<input id="answer" type="text" aria-label="Type the text">', (win) => {
      assert.equal(readers(win).iab('answer').botCheck, true, url);
    });
  // google.com outside /recaptcha/ is an ordinary page
  onPage('https://www.google.com/search?q=recaptcha', '<button id="b">Search</button>', (win) => {
    assert.ok(!readers(win).iab('b').botCheck);
  });
});

test("the focus in a provider's cross-origin frame: the page agent's frame marker says it is a bot check, so main keeps it whatever the frame reads as", () => {
  onPage('https://shop.test/', PAGE, (win) => {
    const agent = pageAgent();
    const doc: any = win.document;
    for (const [id, bot] of [
      ['recaptcha-frame', true],
      ['video-frame', false],
    ] as const) {
      const frame: any = doc.getElementById(id);
      Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null });
      Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => frame });
      const marker = agent.call('intent', {}).value;
      assert.equal(marker.frame, true, id);
      assert.equal(!!marker.botCheck, bot, id);
    }
  });
});

test("Your Chrome's focus reader marks a provider's cross-origin frame as a bot check, and an ordinary one not", () => {
  onPage('https://shop.test/', PAGE, (win) => {
    const doc: any = win.document;
    const read = () => new win.Function(`return (${FOCUS_INTENT})`)()();
    for (const [id, bot] of [
      ['hcaptcha-frame', true],
      ['video-frame', false],
    ] as const) {
      const frame: any = doc.getElementById(id);
      Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null });
      Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => frame });
      assert.deepEqual([read().frame, read().botCheck], [true, bot], id);
    }
  });
});

test('the serialized page agent carries the bot-check test beside it, so a page without the module still has it', () => {
  assert.ok(
    PAGE_AGENT_SOURCE.endsWith(
      `(${botCheckIn.toString()}, ${CONSENT_SOURCE}, ${labelText.toString()}, ${shadowKit.toString()}, ${anchorKit.toString()})`,
    ),
  );
});

test('the refusal: every action that clicks, types, presses or drags on a bot check, named and with the route’s hand-off; nothing else', () => {
  const bot = { botCheck: true, name: "I'm  not a robot" };
  for (const kind of ['click', 'type', 'fill', 'key', 'check', 'drag']) {
    const e = botCheckRefusal(bot, { kind });
    assert.ok(e instanceof ToolError, kind);
    assert.equal(e.code, 'bot_check');
    assert.match(e.message, /^"I'm not a robot" is part of a bot check .*agents never solve these\. Call browser_request_signin/);
  }
  assert.match(botCheckRefusal({ botCheck: true }, { kind: 'click' }, HANDOFF.chrome).message, /^This control is part .* in their Chrome/);
  for (const [intent, action] of [
    [null, { kind: 'click' }],
    [{ name: 'I agree' }, { kind: 'click' }],
    [bot, { kind: 'dialog' }],
    [bot, { kind: 'select' }],
    [bot, null],
  ] as const)
    assert.equal(botCheckRefusal(intent, action), null);
});

test('each route’s refusal is explained with its next step and no workaround', () => {
  const next = (handoff: string) => explainRefusal(botCheckRefusal({ botCheck: true }, { kind: 'click' }, handoff)).next;
  assert.match(next(HANDOFF.pane), /^Call browser_request_signin/);
  assert.match(next(HANDOFF.chrome), /in their Chrome/);
  assert.match(next(HANDOFF.plugin), /in the browser pane/);
  const e = explainRefusal(botCheckRefusal({ botCheck: true }, { kind: 'click' }));
  assert.equal(e.reason, 'bot_check');
  assert.equal(e.retryable, false);
  assert.match(e.message, /Do not try to achieve the same outcome/);
});

test('a check and a drag from a known point read what they act on (a slider puzzle refuses the drag); a drag without one does not', () => {
  assert.equal(needsIntent({ kind: 'check' }), true);
  assert.equal(needsIntent({ kind: 'drag', target: { point: { x: 1, y: 2 } } }), true);
  assert.equal(needsIntent({ kind: 'drag' }), false);
  assert.equal(needsIntent({ kind: 'select' }), false);
});
