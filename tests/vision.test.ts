// Vision fallback (WP8-11): what a result carries by the model's input, who reads the screen,
// consent for another vendor, the OCR element list, and locate/describe over a scripted helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pickBackend, visionPlan, readerOf, needsConsent } = require('../electron/capabilities/vision/decide.cjs');
const { mergeOcr } = require('../electron/capabilities/vision/ocr.cjs');
const { anthropicVision, parsePoint, providerVision, MOPILOT_VISION_MODEL } = require('../electron/capabilities/vision/backend.cjs');
const { VisionFallback, VisionConsent } = require('../electron/capabilities/vision/index.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { GrantStore } = require('../electron/capabilities/grants.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const MOPILOT = { signedIn: true, model: 'vision-1' };

test('backend: the chat provider first, then MoPilot credits (another vendor unless the chat is on MoPilot), else none', () => {
  assert.deepEqual(pickBackend({ provider: { vendor: 'Acme', model: 'acme-v' }, mopilot: MOPILOT, chatVendor: 'Acme' }), {
    source: 'provider',
    vendor: 'Acme',
    model: 'acme-v',
    crossVendor: false,
  });
  assert.deepEqual(pickBackend({ mopilot: MOPILOT, chatVendor: 'Acme' }), {
    source: 'mopilot',
    vendor: 'MoPilot',
    model: 'vision-1',
    crossVendor: true,
  });
  assert.equal(pickBackend({ mopilot: MOPILOT, chatVendor: 'MoPilot' })!.crossVendor, false);
  assert.equal(pickBackend({ mopilot: { signedIn: false, model: 'x' }, chatVendor: 'Acme' }), null);
  assert.equal(pickBackend({}), null);
});

test('provider backend: the provider own vision model when something can call it, else MoPilot credits', () => {
  const anthropic = { id: 'anthropic', label: 'Anthropic', visionFallbackModel: 'claude-haiku-4-5' };
  const auth = { baseUrl: 'https://api.anthropic.com', headers: { 'x-api-key': 'k' } };
  const own = providerVision(anthropic, auth);
  assert.deepEqual(own, { vendor: 'Anthropic', model: 'claude-haiku-4-5' });
  // same provider: no consent, and it wins over MoPilot credits
  assert.deepEqual(pickBackend({ provider: own, mopilot: { signedIn: true, model: MOPILOT_VISION_MODEL }, chatVendor: 'Anthropic' }), {
    source: 'provider',
    vendor: 'Anthropic',
    model: 'claude-haiku-4-5',
    crossVendor: false,
  });
  // no vision model on the provider, or nothing to call it with (a CLI login): fall back to MoPilot credits
  assert.equal(providerVision({ id: 'openai', label: 'OpenAI', visionFallbackModel: null }, auth), null);
  assert.equal(providerVision(anthropic, null), null);
  assert.equal(providerVision(null, auth), null);
  assert.deepEqual(
    pickBackend({
      provider: providerVision(anthropic, null),
      mopilot: { signedIn: true, model: MOPILOT_VISION_MODEL },
      chatVendor: 'Anthropic',
    }),
    { source: 'mopilot', vendor: 'MoPilot', model: 'claude-haiku-4-5', crossVendor: true },
  );
  assert.equal(
    pickBackend({
      provider: providerVision(anthropic, null),
      mopilot: { signedIn: false, model: MOPILOT_VISION_MODEL },
      chatVendor: 'Anthropic',
    }),
    null,
  );
});

test('the registry gives only Anthropic a vision model, and the caps view carries it', () => {
  const { PROVIDERS } = require('../electron/identity/contract/registry.cjs');
  const { providerProfile } = require('../electron/session/caps.cjs');
  assert.equal(PROVIDERS.anthropic.visionFallbackModel, MOPILOT_VISION_MODEL);
  assert.equal(PROVIDERS.openai.visionFallbackModel, undefined);
  assert.equal(providerProfile({ harness: 'claude', provider: PROVIDERS.anthropic }, null, null)!.visionFallbackModel, 'claude-haiku-4-5');
  assert.equal(providerProfile({ harness: 'codex', provider: PROVIDERS.openai }, null, null)!.visionFallbackModel, null);
});

test('plan: an image model gets the screenshot; a text-only model the element list and, with a backend, locate and describe', () => {
  const cross = pickBackend({ mopilot: MOPILOT, chatVendor: 'Acme' });
  assert.deepEqual(visionPlan({ modality: 'image', backend: cross }), { kinds: ['screenshot'], ocr: false, locate: false, backend: null });
  const text = visionPlan({ modality: 'text', backend: cross, consent: 'unasked' });
  assert.deepEqual([text.kinds, text.ocr, text.locate], [['elements'], false, true]);
  assert.deepEqual(readerOf(text), { model: 'vision-1', vendor: 'MoPilot' });
});

test('plan: no backend, or consent refused, falls back to the OCR element list and injects nothing', () => {
  const none = visionPlan({ modality: 'text', backend: null });
  assert.deepEqual([none.kinds, none.ocr, none.locate], [['elements'], true, false]);
  assert.deepEqual(readerOf(none), { text: true });
  const cross = pickBackend({ mopilot: MOPILOT, chatVendor: 'Acme' });
  const refused = visionPlan({ modality: 'text', backend: cross, consent: 'refused' });
  assert.deepEqual([refused.ocr, refused.locate], [true, false]);
  // a same-vendor backend never needs consent
  assert.equal(needsConsent(pickBackend({ provider: { vendor: 'A', model: 'm' } }), 'unasked'), false);
  assert.equal(needsConsent(cross, 'unasked'), true);
  assert.equal(needsConsent(cross, 'granted'), false);
});

test('plan: unknown input sends the screenshot and the element list, and locate/describe when a backend exists', () => {
  const cross = pickBackend({ mopilot: MOPILOT, chatVendor: 'Acme' });
  const p = visionPlan({ modality: null, backend: cross, consent: 'unasked' });
  assert.deepEqual([p.kinds, p.ocr, p.locate], [['screenshot', 'elements'], false, true]);
  assert.equal(readerOf(p), null);
  const q = visionPlan({ modality: undefined, backend: null });
  assert.deepEqual([q.kinds, q.locate], [['screenshot', 'elements'], false]);
});

test('OCR: text the accessibility tree already names is dropped; the rest becomes ocr-N elements the model can click', () => {
  const byId = new Map<string, any>([['0.0', { id: '0.0', title: 'Send', frame: { x: 0, y: 0, w: 100, h: 20 } }]]);
  const lines = mergeOcr(
    byId,
    {
      elements: [
        { text: 'Send', frame: { x: 10, y: 5, w: 30, h: 10 } },
        { text: 'Hello world', frame: { x: 200, y: 100, w: 100, h: 20 } },
        { text: '  ', frame: { x: 1, y: 1, w: 1, h: 1 } },
      ],
    },
    (p: any) => ({ x: p.x * 2, y: p.y * 2 }),
  );
  assert.deepEqual(lines, ['[ocr-0] Text "Hello world" at (500, 220)']);
  assert.deepEqual(byId.get('ocr-0').frame, { x: 200, y: 100, w: 100, h: 20 });
  assert.deepEqual(
    mergeOcr(new Map(), null, (p: any) => p),
    [],
  );
});

test('parsePoint: pixels, a 0-1000 grid and fractions all land in the image', () => {
  const size = { width: 2000, height: 1000 };
  assert.deepEqual(parsePoint('{"x": 120, "y": 340}', size), { x: 120, y: 340 });
  assert.deepEqual(parsePoint('(1500, 900)', size), { x: 1500, y: 900 });
  assert.deepEqual(parsePoint('{"x": 500, "y": 500}', { width: 400, height: 300 }), { x: 200, y: 150 });
  assert.deepEqual(parsePoint('0.5, 0.25', size), { x: 1000, y: 250 });
  assert.equal(parsePoint('nothing here', size), null);
  assert.equal(parsePoint('5000, 5000', size), null);
});

test('the Anthropic wire call sends the image and the prompt and returns the text', async () => {
  let seen: any = null;
  const call = anthropicVision({
    baseUrl: 'https://gw.test/',
    headers: async () => ({ authorization: 'Bearer k' }),
    model: 'vision-1',
    fetch: async (url: string, init: any) => (
      (seen = { url, init, body: JSON.parse(init.body) }),
      { ok: true, json: async () => ({ content: [null, { type: 'text', text: '{"x": 1, "y": 2}' }] }) }
    ),
  });
  assert.equal(await call({ png: 'AAAA', prompt: 'where?' }), '{"x": 1, "y": 2}');
  assert.equal(seen.url, 'https://gw.test/v1/messages');
  assert.equal(seen.init.headers.authorization, 'Bearer k');
  assert.equal(seen.body.model, 'vision-1');
  assert.deepEqual(seen.body.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: 'AAAA' });
  const bad = anthropicVision({ baseUrl: 'https://x', headers: () => ({}), model: 'm', fetch: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(bad({ png: 'A', prompt: 'p' }), /500/);
});

/* -- the tools over a scripted helper ------------------------------------ */
function fakeChats() {
  const meta = new Map<string, any>();
  return {
    get: (id: string) => (meta.has(id) ? { meta: meta.get(id) } : null),
    patchMeta: (id: string, patch: any) => (meta.set(id, { ...(meta.get(id) ?? {}), ...patch }), true),
  };
}

function rig(o: { modality?: string | null; backend?: any; ocr?: any } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-'));
  const approvals: any[] = [];
  const ctl = {
    addApproval: (_c: string, a: any) => approvals.push(a),
    resolveApproval: (id: string) => (approvals.splice(0, approvals.length, ...approvals.filter((a) => a.id !== id)), true),
  };
  const broker = new ApprovalBroker({ controller: ctl });
  const reads: any[] = [];
  const vision = new VisionFallback({
    backendFor: () => (typeof o.backend === 'function' ? o.backend() : (o.backend ?? null)),
    read: async (backend: any, req: any) => (
      reads.push({ backend, prompt: req.prompt }), req.prompt.includes('Where is') ? '{"x": 40, "y": 20}' : 'A notes window'
    ),
    broker,
    consent: new VisionConsent({ file: path.join(dir, 'vision.json') }),
  });
  const calls: string[] = [];
  const snap = {
    app: { bundleId: 'com.apple.Notes', name: 'Notes' },
    root: {
      id: '0',
      role: 'AXApplication',
      children: [{ id: '0.0', role: 'AXButton', title: 'Delete', frame: { x: 10, y: 5, w: 20, h: 10 } }],
    },
  };
  const helper = {
    start: async () => ({}),
    targetInfo: async () => ({ pid: 7, bundleId: 'com.apple.Notes', name: 'Notes' }),
    screenshot: async () => (
      calls.push('screenshot'), { png: 'AAAA', width: 200, height: 100, display: { x: 0, y: 0 }, pixelsPerPoint: 2 }
    ),
    axSnapshot: async () => snap,
    ocrElements: async () => {
      calls.push('ocr');
      if (o.ocr === 'missing') throw new Error('method not found');
      return o.ocr ?? { elements: [{ text: 'Untitled note', frame: { x: 50, y: 40, w: 60, h: 10 } }] };
    },
  };
  const grants = new GrantStore({ file: path.join(dir, 'computer.json'), chats: fakeChats() });
  grants.grant('c1', { bundleId: 'com.apple.Notes', name: 'Notes' }, 'full', 'always');
  const activity: any[] = [];
  const cu = new ComputerUse({
    helper,
    grants,
    broker,
    vision,
    session: () => ({ modality: o.modality === undefined ? 'text' : o.modality, permission: 'default' }),
    harness: () => 'claude',
    onActivity: (_c: string, a: any) => activity.push(a),
    settleMs: 0,
  });
  const reg = new Registry();
  for (const t of cu.tools()) reg.register(t);
  const answerNext = async (result: any) => {
    while (!approvals.length) await new Promise((r) => setTimeout(r, 1));
    const card = approvals[0];
    broker.answer(card.id, result);
    return card;
  };
  return { cu, reg, reads, calls, activity, answerNext, approvals, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const CROSS = { source: 'mopilot', vendor: 'MoPilot', model: 'vision-1', crossVendor: true };
const SAME = { source: 'provider', vendor: 'Acme', model: 'acme-v', crossVendor: false };

test('text-only model, same-vendor backend: elements only, locate runs without a card and the bar names the model', async () => {
  const r = rig({ backend: SAME });
  const shot = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
  assert.deepEqual(
    shot.content.map((c: any) => c.type),
    ['text'],
  );
  assert.match(shot.content[0].text, /\[0\.0\] Button "Delete"/);
  assert.equal(r.calls.includes('ocr'), false);
  const found = await r.reg.invoke('c1', 'c1', 'computer_locate', { query: 'the delete button' });
  assert.equal(found.ok, true);
  assert.match(found.content[0].text, /Found at \(40, 20\)/);
  assert.match(found.content[0].text, /element 0\.0/);
  assert.equal(r.approvals.length, 0);
  assert.deepEqual(r.activity[0], { app: 'Notes', state: 'reading', read: { model: 'acme-v', vendor: 'Acme' } });
  assert.equal(r.activity.at(-1), null);
  const described = await r.reg.invoke('c1', 'c1', 'computer_describe', { region: 'the toolbar' });
  assert.equal(described.content[0].text, 'A notes window');
  assert.match(r.reads.at(-1).prompt, /the toolbar/);
  r.done();
});

test('first cross-vendor use asks once per chat when allowed for the chat; the card names the model and vendor', async () => {
  const r = rig({ backend: CROSS });
  const first = r.reg.invoke('c1', 'c1', 'computer_describe', {});
  const card = await r.answerNext({ decision: 'allow', scope: 'chat' });
  assert.equal(card.method, 'sage/visionConsent');
  assert.deepEqual([card.params.model, card.params.vendor, card.params.app.name], ['vision-1', 'MoPilot', 'Notes']);
  assert.equal((await first).ok, true);
  assert.equal((await r.reg.invoke('c1', 'c1', 'computer_describe', {})).ok, true);
  assert.equal(r.reads.length, 2);
  r.done();
});

test('Allow once asks again; refusing sends no screenshot and the elements get OCR text instead', async () => {
  const r = rig({ backend: CROSS });
  const a = r.reg.invoke('c1', 'c1', 'computer_describe', {});
  await r.answerNext({ decision: 'allow', scope: 'once' });
  assert.equal((await a).ok, true);
  const b = r.reg.invoke('c1', 'c1', 'computer_describe', {});
  await r.answerNext({ decision: 'deny' });
  const denied = await b;
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /computer_elements/);
  assert.equal(r.reads.length, 1);
  // refused: the next elements list carries OCR text, and locate/describe are gone for the chat
  const list = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
  assert.match(list.content[0].text, /\[ocr-0\] Text "Untitled note"/);
  const again = await r.reg.invoke('c1', 'c1', 'computer_locate', { query: 'x' });
  assert.equal(again.ok, false);
  assert.equal(r.approvals.length, 0);
  r.done();
});

test('no vision backend at all: the element list carries OCR text, the bar says so, and locate is unavailable', async () => {
  const r = rig({ backend: null });
  const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
  assert.deepEqual(
    out.content.map((c: any) => c.type),
    ['text'],
  );
  assert.match(out.content[0].text, /OCR/);
  assert.match(out.content[0].text, /\[ocr-0\] Text "Untitled note" at \(80, 45\)/);
  assert.deepEqual(r.activity[0], { app: 'Notes', state: 'reading', read: { text: true } });
  const loc = await r.reg.invoke('c1', 'c1', 'computer_locate', { query: 'x' });
  assert.equal(loc.ok, false);
  assert.equal(loc.error.code, 'unavailable');
  r.done();
});

test('a helper without ocr.elements still lists the accessibility elements', async () => {
  const r = rig({ backend: null, ocr: 'missing' });
  const out = await r.reg.invoke('c1', 'c1', 'computer_elements', {});
  assert.equal(out.ok, true);
  assert.match(out.content[0].text, /Delete/);
  assert.doesNotMatch(out.content[0].text, /OCR/);
  r.done();
});

test('unknown input: screenshot and element list together, plus locate when a backend exists', async () => {
  const r = rig({ modality: null, backend: SAME });
  const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
  assert.deepEqual(
    out.content.map((c: any) => c.type),
    ['image', 'text', 'text'],
  );
  assert.equal((await r.reg.invoke('c1', 'c1', 'computer_locate', { query: 'x' })).ok, true);
  r.done();
});

test('an image model gets the screenshot and no helper tools work', async () => {
  const r = rig({ modality: 'image', backend: SAME });
  const out = await r.reg.invoke('c1', 'c1', 'computer_screenshot', {});
  assert.deepEqual(
    out.content.map((c: any) => c.type),
    ['image', 'text'],
  );
  assert.equal((await r.reg.invoke('c1', 'c1', 'computer_describe', {})).ok, false);
  r.done();
});

test('Always allow screenshot consent is atomic and a failed write leaves consent unasked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-consent-failure-'));
  const file = path.join(dir, 'consent.json');
  try {
    const consent = new VisionConsent({ file });
    fs.mkdirSync(file);
    assert.throws(() => consent.set('c1', 'Vendor', 'always'), { code: 'save_failed' });
    assert.equal(consent.get('c1', 'Vendor'), 'unasked');
    fs.rmSync(file, { recursive: true });
    consent.set('c1', 'Vendor', 'always');
    assert.equal(new VisionConsent({ file }).get('c2', 'Vendor'), 'granted');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.throws(() => new VisionConsent().set('c1', 'Vendor', 'always'), { code: 'save_failed' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('locate and describe refuse cleanly when the vision backend goes away after the call was checked', async () => {
  // runCall reads the plan once to check the call, and see() reads it again: the second read finds no backend
  let reads = 0;
  const r = rig({ backend: () => (reads++ === 0 ? SAME : null) });
  const out = await r.reg.invoke('c1', 'c1', 'computer_locate', { query: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'unavailable');
  assert.match(out.error.message, /No vision model can read the screen/);
  assert.equal(r.reads.length, 0);
  // and without a vision fallback at all
  r.cu.vision = null;
  await assert.rejects(r.cu.see('c1', 'computer_describe', {}, { bundleId: 'com.apple.Notes', name: 'Notes' }, {}), {
    code: 'unavailable',
  });
  r.done();
});

test('vision consent and turn refusal cleanup keep exact opaque chat/vendor owners', () => {
  const c = new VisionConsent();
  c.set('opaque', 'part\0Vendor', 'chat');
  assert.equal(c.get('opaque\0part', 'Vendor'), 'unasked');
  c.set('opaque\0part', 'Vendor', 'refused');
  c.forgetRefusals('opaque');
  assert.equal(c.get('opaque\0part', 'Vendor'), 'refused');
  c.forgetRefusals('opaque\0part');
  assert.equal(c.get('opaque\0part', 'Vendor'), 'unasked');
  assert.equal(c.get('opaque', 'part\0Vendor'), 'granted');
});
