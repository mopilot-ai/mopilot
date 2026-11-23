// electron/capabilities/tools/desktopVision.cjs: the vision fallback on the desktop_* and desktop_app_* captures, over the
// fakes of tests/support/desktop-kit.ts and app-scoped-kit.ts with the real VisionFallback. Each path for both tool
// families: an image model, a text-only model with a vision backend, consent declined, a failing backend and no backend;
// plus zoom, the app batch's screenshot and the ACP modality that drives it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as DK from './support/desktop-kit.ts';
import * as AK from './support/app-scoped-kit.ts';

const require = createRequire(import.meta.url);
const { VisionFallback } = require('../electron/capabilities/vision/index.cjs');
const { forModel, ocrLines } = require('../electron/capabilities/tools/desktopVision.cjs');
const { SPECS: DESKTOP_SPECS } = require('../electron/capabilities/tools/desktopSpecs.cjs');
const { SPECS: APP_SPECS } = require('../electron/capabilities/tools/appScopedSpecs.cjs');
const acp = require('../electron/harness/acp.cjs');
const { ChatController } = require('../electron/session/controller.cjs');

const SAME = { source: 'provider', vendor: 'Anthropic', model: 'claude-haiku-4-5', crossVendor: false };
const OTHER = { source: 'mopilot', vendor: 'MoPilot', model: 'vision-1', crossVendor: true };

/** The real VisionFallback on the rig's coordinator: the chat's model input, its backend, and what the backend answers. */
function vision(r: any, o: { modality: string | null; backend: any; read?: (req: any) => any }) {
  const reads: any[] = [];
  const broker = {
    ask: async (chatId: string, kind: string, params: any) => {
      r.asks.push({ chatId, kind, params });
      return r.answers[kind];
    },
  };
  const read = o.read ?? ((req: any) => (req.prompt.includes('Where is') ? '{"x": 110, "y": 55}' : 'A Notes window with a Send button'));
  const v = new VisionFallback({
    backendFor: () => o.backend,
    read: async (_b: any, req: any) => (reads.push(req), read(req)),
    broker,
  });
  r.cu.vision = v;
  r.cu.plan = (chatId: string) => v.plan(chatId, o.modality);
  return reads;
}

/* -- desktop_* ------------------------------------------------------------ */
/** Notes' OCR text in global points: one word the Send button already shows, one only OCR reads, one off the display. */
const DESKTOP_OCR = {
  elements: [
    { text: 'Send', frame: { x: 200, y: 100, w: 40, h: 20 }, source: 'ocr' },
    { text: 'Hello  world', frame: { x: 1000, y: 800, w: 100, h: 20 }, source: 'ocr' },
    { text: 'Far', frame: { x: 9000, y: 800, w: 10, h: 10 }, source: 'ocr' },
    { text: 'AX', frame: { x: 10, y: 10, w: 10, h: 10 }, source: 'ax' },
  ],
};

function desktop(ocr: any = DESKTOP_OCR) {
  const r = DK.rig();
  r.helper.call = async (method: string, ...args: any[]) => {
    r.helper.calls.push({ method, args });
    if (method !== 'ocr.elements') return { ok: true };
    if (ocr instanceof Error) throw ocr;
    return ocr;
  };
  return r;
}
const ocrCalls = (r: any) => r.helper.calls.filter((c: any) => c.method === 'ocr.elements');

test('desktop: an image model gets the screenshot unchanged; find has no vision model to ask', async () => {
  const r = desktop();
  await r.ready();
  const reads = vision(r, { modality: 'image', backend: SAME });
  const out = await r.call('desktop_screenshot');
  assert.equal(out[0].type, 'image');
  assert.equal(out.length, 2);
  assert.doesNotMatch(out[1].text, /OCR|No image/);
  const found = await r.call('desktop_screenshot', { find: 'the Send button' });
  assert.equal(found[0].type, 'image');
  assert.match(found[1].text, /find: no vision model can locate "the Send button" in this chat; look at the screenshot\./);
  assert.equal(ocrCalls(r).length, 0);
  assert.equal(reads.length, 0);
  // a coordinator without a plan (no vision fallback at all) is the same
  delete r.cu.plan;
  assert.match((await r.call('desktop_screenshot', { find: 'x' }))[1].text, /look at the screenshot/);
});

test('desktop: a text-only model with a same-vendor backend gets elements, OCR text and a description; find locates', async () => {
  const r = desktop();
  await r.ready();
  const reads = vision(r, { modality: 'text', backend: SAME });
  const out = await r.call('desktop_screenshot', { find: '  the Send button ' });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  const t = out[0].text;
  assert.match(t, /^Screenshot 1000x500/);
  assert.match(t, /No image: this chat's model takes text only/);
  assert.match(t, /\[1\] Button "Send" at \(110, 55\)/);
  assert.match(t, /on-device OCR; act on it by coordinate\):\n"Hello world" at \(525, 405\)$/m);
  assert.doesNotMatch(t, /^"Send" at|Far|"AX"/m);
  assert.match(t, /What claude-haiku-4-5 sees:\nA Notes window with a Send button/);
  assert.match(t, /find: "the Send button" is at \(110, 55\), element \[1\]\./);
  // no card for the chat's own vendor; the JPEG goes to the backend as JPEG
  assert.equal(r.asks.filter((a: any) => a.kind === 'visionConsent').length, 0);
  assert.deepEqual(
    reads.map((q) => [q.png, q.mimeType]),
    [
      ['JPEG', 'image/jpeg'],
      ['JPEG', 'image/jpeg'],
    ],
  );
  assert.deepEqual(ocrCalls(r)[0].args, [{ bundleIds: ['com.apple.Notes'] }, { timeoutMs: 60000 }]);
});

test('desktop: find on a point with no element, and on nothing found', async () => {
  const r = desktop();
  let answer = '{"x": 999, "y": 499}';
  await r.ready();
  vision(r, { modality: 'text', backend: SAME, read: (q) => (q.prompt.includes('Where is') ? answer : 'screen') });
  assert.match((await r.call('desktop_screenshot', { find: 'corner' }))[0].text, /find: "corner" is at \(999, 499\)\.$/);
  answer = '{"found": false}';
  assert.match((await r.call('desktop_screenshot', { find: 'ghost' }))[0].text, /find: "ghost" is not on the screen\.$/);
});

test('desktop: a cross-vendor backend asks first; declined, the model gets the accessibility and OCR text and says why', async () => {
  const r = desktop();
  r.answers.visionConsent = { decision: 'deny' };
  await r.ready();
  const reads = vision(r, { modality: 'text', backend: OTHER });
  const t = (await r.call('desktop_screenshot', { find: 'Send' }))[0].text;
  const card = r.asks.find((a: any) => a.kind === 'visionConsent');
  assert.deepEqual(card!.params, {
    harness: 'claude',
    app: { bundleId: 'com.apple.Notes', name: 'Notes' },
    model: 'vision-1',
    vendor: 'MoPilot',
  });
  assert.match(
    t,
    /The user didn't allow sending screenshots to MoPilot \(asked again in a later turn\), so no vision model read the screen: this is the accessibility and on-device OCR text only\./,
  );
  assert.match(t, /"Hello world" at/);
  // refused for the chat: the plan has no backend now, so find is not offered and nothing is asked again
  assert.match(t, /find: "Send" was not looked for\./);
  const again = (await r.call('desktop_screenshot', { find: 'Send' }))[0].text;
  assert.match(again, /No vision model can read the screen in this chat: this is the accessibility and on-device OCR text only\./);
  assert.match(again, /find: no vision model can locate "Send" in this chat; search the text above\./);
  assert.equal(r.asks.filter((a: any) => a.kind === 'visionConsent').length, 1);
  assert.equal(reads.length, 0);
});

test('desktop: allowed for the chat, the cross-vendor backend reads the screen', async () => {
  const r = desktop();
  r.answers.visionConsent = { decision: 'allow', scope: 'chat' };
  await r.ready();
  const reads = vision(r, { modality: 'text', backend: OTHER });
  assert.match((await r.call('desktop_screenshot'))[0].text, /What vision-1 sees:/);
  assert.equal(reads.length, 1);
});

test('desktop: a failing backend leaves the accessibility and OCR text, with an honest note', async () => {
  const r = desktop();
  await r.ready();
  vision(r, {
    modality: 'text',
    backend: SAME,
    read: () => {
      throw new Error('vision model answered 529');
    },
  });
  const t = (await r.call('desktop_screenshot', { find: 'Send' }))[0].text;
  assert.match(
    t,
    /The vision model couldn't read the screen \(vision model answered 529\): this is the accessibility and on-device OCR text only\./,
  );
  assert.match(t, /find: the vision model couldn't read the screen \(vision model answered 529\)\./);
  assert.match(t, /"Hello world" at/);
});

test('desktop: no backend: accessibility and OCR text only; an OCR failure still lists the elements', async () => {
  const r = desktop(new Error('ocr.elements unknown'));
  await r.ready();
  vision(r, { modality: 'text', backend: null });
  const t = (await r.call('desktop_screenshot'))[0].text;
  assert.match(t, /\[1\] Button "Send"/);
  assert.doesNotMatch(t, /OCR;/);
  assert.match(t, /No vision model can read the screen in this chat/);
});

test('desktop: unknown model input keeps the image and still answers find through the backend', async () => {
  const r = desktop();
  await r.ready();
  vision(r, { modality: null, backend: SAME });
  const out = await r.call('desktop_screenshot', { find: 'Send' });
  assert.equal(out[0].type, 'image');
  assert.match(out[1].text, /find: "Send" is at \(110, 55\), element \[1\]\./);
  assert.equal(ocrCalls(r).length, 0);
});

test('desktop: zoom for a text-only model describes the region and lists what is in it; the batch screenshot too', async () => {
  const r = desktop();
  await r.ready();
  const reads = vision(r, { modality: 'text', backend: SAME });
  const z = await r.call('desktop_zoom', { region: [100, 40, 600, 450] });
  assert.equal(z.length, 1);
  assert.match(z[0].text, /^Zoomed view of \[100, 40, 600, 450\]/);
  assert.match(z[0].text, /Elements in this region:\n\[1\] Button "Send" at \(110, 55\)/);
  assert.match(z[0].text, /"Hello world" at \(525, 405\)/);
  assert.match(z[0].text, /What claude-haiku-4-5 sees:/);
  const tight = (await r.call('desktop_zoom', { region: [0, 0, 50, 50] }))[0].text;
  assert.doesNotMatch(tight, /Elements in this region|Hello world/);
  assert.equal(reads.length, 2);
  const b = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.ok(b.every((c: any) => c.type === 'text'));
  assert.match(b.at(-1).text, /No image: this chat's model takes text only/);
});

/* -- desktop_app_* --------------------------------------------------------- */
/** Notes' window text in global points: the Send button's own word, one only OCR reads, one outside the window. */
const APP_OCR = {
  elements: [
    { text: 'Send', frame: { x: 110, y: 60, w: 40, h: 20 }, source: 'ocr' },
    { text: 'Draft saved', frame: { x: 300, y: 400, w: 100, h: 10 } },
    { text: 'Outside', frame: { x: 2000, y: 2000, w: 10, h: 10 } },
  ],
};

function app(ocr: any = APP_OCR) {
  const r = AK.rig();
  r.helper.answers['ocr.elements'] = () => {
    if (ocr instanceof Error) throw ocr;
    return ocr;
  };
  return r;
}

test('app: an image model gets the window unchanged; find has no vision model to ask', async () => {
  const r = app();
  vision(r, { modality: 'image', backend: SAME });
  const out = await r.call('desktop_app_screenshot', { app: 'Notes' });
  assert.equal(out[0].type, 'image');
  assert.doesNotMatch(out[1].text, /OCR|No image/);
  const found = await r.call('desktop_app_screenshot', { app: 'Notes', find: 'Send' });
  assert.match(found[1].text, /find: no vision model can locate "Send" in this chat; look at the screenshot\./);
  assert.equal(r.callsOf('ocr.elements').length, 0);
});

test('app: a text-only model with a backend gets elements, OCR text, a description, and find in the frame (scaled image)', async () => {
  const r = app();
  // the image is scaled to half the 1000x800 frame: the backend answers in image pixels
  const base = r.helper.answers['app.screenshot'];
  r.helper.answers['app.screenshot'] = () => ({ ...base(), width: 500, height: 400 });
  const reads = vision(r, {
    modality: 'text',
    backend: SAME,
    read: (q) => (q.prompt.includes('Where is') ? '{"x": 30, "y": 20}' : 'A draft'),
  });
  const out = await r.call('desktop_app_screenshot', { app: 'Notes', find: 'Send' });
  assert.equal(out.length, 1);
  const t = out[0].text;
  assert.match(t, /^Window 5 "Doc" of Notes/);
  assert.match(t, /Button "Send" at \(60, 40\)/);
  assert.match(t, /"Draft saved" at \(500, 710\)/);
  assert.doesNotMatch(t, /^"Send" at|Outside/m);
  assert.match(t, /What claude-haiku-4-5 sees:\nA draft/);
  assert.match(t, /find: "Send" is at \(60, 40\), element \[1\]\./);
  assert.match(reads[1].prompt, /500x400 pixel screenshot/);
  assert.deepEqual(r.last('ocr.elements'), { pid: 7, bundleIds: ['com.apple.Notes'] });
});

test('app: consent declined gives the accessibility and OCR text with a note', async () => {
  const r = app();
  r.answers.visionConsent = { decision: 'deny' };
  const reads = vision(r, { modality: 'text', backend: OTHER });
  const t = (await r.call('desktop_app_screenshot', { app: 'Notes' }))[0].text;
  assert.equal(r.asks.filter((a: any) => a.kind === 'visionConsent').length, 1);
  assert.match(t, /didn't allow sending screenshots to MoPilot/);
  assert.match(t, /"Draft saved" at/);
  assert.equal(reads.length, 0);
});

test('app: a failing backend leaves the accessibility and OCR text, with an honest note', async () => {
  const r = app();
  vision(r, {
    modality: 'text',
    backend: SAME,
    read: () => {
      throw new Error('timeout');
    },
  });
  const t = (await r.call('desktop_app_screenshot', { app: 'Notes', find: 'Send' }))[0].text;
  assert.match(t, /The vision model couldn't read the screen \(timeout\)/);
  assert.match(t, /find: the vision model couldn't read the screen \(timeout\)\./);
  assert.match(t, /"Draft saved" at/);
});

test('app: no backend: accessibility and OCR text only; an OCR failure still lists the elements', async () => {
  const r = app();
  vision(r, { modality: 'text', backend: null });
  const t = (await r.call('desktop_app_screenshot', { app: 'Notes' }))[0].text;
  assert.match(t, /"Draft saved" at/);
  assert.match(t, /No vision model can read the screen in this chat/);
  const broken = app(new Error('unknown method'));
  vision(broken, { modality: 'text', backend: null });
  const t2 = (await broken.call('desktop_app_screenshot', { app: 'Notes' }))[0].text;
  assert.match(t2, /Button "Send"/);
  assert.doesNotMatch(t2, /OCR;/);
});

test('app: zoom and a batch screenshot for a text-only model are text', async () => {
  const r = app();
  vision(r, { modality: 'text', backend: null });
  await r.shoot();
  const z = await r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 700, 800] });
  assert.equal(z.length, 1);
  assert.match(z[0].text, /Elements in this region:\n\[1\] Button "Send"/);
  assert.match(z[0].text, /"Draft saved" at \(500, 710\)/);
  const b = await r.call('desktop_app_batch', {
    app: 'Notes',
    actions: [{ action: 'click', element_index: 1 }, { action: 'screenshot' }],
  });
  assert.ok(b.every((c: any) => c.type === 'text'));
  assert.match(b.at(-1).text, /No image: this chat's model takes text only/);
});

/* -- pieces ---------------------------------------------------------------- */
test('ocrLines: the frame, a region and a cap', () => {
  const geom = { x: 0, y: 0, ppp: 1, width: 1000, height: 1000 };
  const many = { elements: Array.from({ length: 130 }, (_, i) => ({ text: `w${i}`, frame: { x: i, y: i, w: 2, h: 2 } })) };
  assert.equal(ocrLines(many, [], geom).length, 120);
  assert.deepEqual(ocrLines(many, [], geom, [0, 0, 2, 2]), ['"w0" at (1, 1)', '"w1" at (2, 2)']);
  // an element without a label never hides OCR text
  assert.equal(
    ocrLines({ elements: [{ text: 'a', frame: { x: 1, y: 1, w: 2, h: 2 } }] }, [{ frame: { x: 0, y: 0, w: 9, h: 9 } }], geom).length,
    1,
  );
});

test('forModel: a consent card that fails to save is the call failing', async () => {
  const cu = {
    harness: () => 'acp:dsh',
    plan: async () => ({ kinds: ['elements'], locate: true, backend: OTHER }),
    vision: {
      allowing: async () => {
        throw new Error("Couldn't save screenshot consent");
      },
    },
  };
  await assert.rejects(
    forModel({
      cu,
      chatId: 'c',
      app: { bundleId: 'b', name: 'B' },
      out: {
        record: {},
        content: [
          { type: 'image', data: 'X' },
          { type: 'text', text: 't' },
        ],
      },
      size: { width: 1, height: 1 },
      geom: { x: 0, y: 0, ppp: 1, width: 1, height: 1 },
      elements: [],
      ocr: async () => null,
    }),
    /Couldn't save/,
  );
});

test('forModel: unknown input refused keeps the image; a backend that throws a non-Error is still told', async () => {
  const base = {
    chatId: 'c',
    app: { bundleId: 'b', name: 'B' },
    out: {
      record: {},
      content: [
        { type: 'image', data: 'X' },
        { type: 'text', text: 't' },
      ],
    },
    size: { width: 10, height: 10 },
    geom: { x: 0, y: 0, ppp: 1, width: 10, height: 10 },
    elements: [],
    ocr: async () => null,
    find: 'Send',
  };
  const refused = await forModel({
    ...base,
    cu: {
      harness: () => 'codex',
      plan: async () => ({ kinds: ['screenshot', 'elements'], locate: true, backend: OTHER }),
      vision: { allowing: async () => ({ backend: null, why: 'refused' }) },
    },
  });
  assert.equal(refused.content[0].type, 'image');
  assert.match(
    refused.content[1].text,
    /didn't allow sending screenshots to MoPilot \(asked again in a later turn\), so no vision model read the screen\.\nfind: "Send" was not looked for\./,
  );
  const throwing = {
    allowing: async (_c: string, b: any) => ({ backend: b }),
    describe: async () => {
      throw 'overloaded';
    },
    locate: async () => {
      throw 'overloaded';
    },
  };
  const out = await forModel({
    ...base,
    cu: { harness: () => 'acp:dsh', plan: async () => ({ kinds: ['elements'], locate: true, backend: SAME }), vision: throwing },
  });
  assert.match(out.content[0].text, /couldn't read the screen \(overloaded\): this is/);
  assert.match(out.content[0].text, /find: the vision model couldn't read the screen \(overloaded\)\./);
});

test('specs: both screenshot tools take find and say what a text-only model gets', () => {
  for (const s of [
    DESKTOP_SPECS.find((x: any) => x.name === 'desktop_screenshot'),
    APP_SPECS.find((x: any) => x.name === 'desktop_app_screenshot'),
  ]) {
    assert.equal(s.schema.properties.find.type, 'string');
    assert.match(s.description, /takes text only gets no image/);
  }
});

/* -- the ACP modality ---------------------------------------------------- */
test('ACP: an agent that declares no image input makes the chat text-only for computer use', async () => {
  const host = new acp.AcpHost({ items: { read: () => [] }, quirks: () => null, resolveBin: () => null });
  assert.equal(host.takesImages('acp:dsh:k'), null);
  host.chats.set('acp:dsh:k', { agent: { caps: { image: false } } });
  host.chats.set('acp:gem:k', { agent: { caps: { image: true } } });
  assert.equal(host.takesImages('acp:dsh:k'), false);
  assert.equal(host.takesImages('acp:gem:k'), true);

  const patches: any[] = [];
  const state = {
    get: () => ({ turn: 'idle' }),
    patch: (id: string, p: any) => patches.push([id, p]),
    // the turn's start (SessionStore.step), before the modality the send learns
    step: (id: string, name: string, args: any) => patches.push([id, { step: name, ...args }]),
  };
  const c = Object.create(ChatController.prototype);
  Object.assign(c, {
    state,
    rt: () => ({}),
    acp: { send: async () => ({ turnId: 't' }), takesImages: (k: string) => host.takesImages(k) },
  });
  assert.deepEqual(await c.acpSend('c1', 'acp:dsh:k', {}, { uuid: 'u' }), { turnId: 't' });
  assert.deepEqual(patches.at(-1), ['c1', { modality: 'text' }]);
  await c.acpSend('c2', 'acp:gem:k', {}, { uuid: 'u' });
  assert.deepEqual(patches.at(-1), ['c2', { modality: 'image' }]);
  // a host that can't tell leaves the modality alone
  c.acp = { send: async () => ({}) };
  const n = patches.length;
  await c.acpSend('c3', 'k', {}, {});
  assert.equal(patches.length, n + 1);
  assert.equal(patches.at(-1)[1].step, 'start', 'the turn starts, and no modality is set');
});
