// Vision fallback for text-only models: what each computer-use result carries (decide.cjs), the
// consent to send screenshots to another vendor, and the locate and describe calls to the backend.
const { identityKey } = require('../../../shared/identityKey.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { pickBackend, needsConsent, visionPlan, readerOf } = require('./decide.cjs');
const { parsePoint } = require('./backend.cjs');

/** Who agreed to what, per vendor: 'always' on disk, 'chat' in memory for the chat, refusals until the chat's turn ends. */
class VisionConsent {
  constructor(o = {}) {
    this.file = o.file || null;
    this.always = new Set();
    this.chat = new Map();
    try {
      if (this.file) for (const v of JSON.parse(fs.readFileSync(this.file, 'utf8')).always || []) this.always.add(v);
    } catch (error) {
      // no saved choices yet (ENOENT), or an unreadable file: start with none, so the user is asked again
      noteIgnored('read the saved vision consent', error, ['ENOENT']);
    }
  }
  get(chatId, vendor) {
    if (this.always.has(vendor)) return 'granted';
    return this.chat.get(identityKey(chatId, vendor))?.answer || 'unasked';
  }
  set(chatId, vendor, answer) {
    if (answer === 'always') {
      const always = new Set([...this.always, vendor]);
      try {
        if (!this.file) throw new Error('No consent storage configured');
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        writePrivate(this.file, JSON.stringify({ always: [...always] }));
      } catch {
        throw new ToolError("Couldn't save screenshot consent. Please try again.", 'save_failed');
      }
      this.always = always;
    } else if (answer === 'chat' || answer === 'refused')
      this.chat.set(identityKey(chatId, vendor), { chatId, answer: answer === 'chat' ? 'granted' : 'refused' });
  }
  /** The chat's turn ended: a refusal no longer holds, so a later turn may ask again ("Allow for this chat" stays). */
  forgetRefusals(chatId) {
    for (const [k, v] of this.chat) if (v.answer === 'refused' && v.chatId === chatId) this.chat.delete(k);
  }
}

/**
 * `backendFor` behind the remote switch shared.visionFallback: off, no vision model reads the screen
 * (a text-only model keeps the OCR element list).
 */
function gatedBackend(enabled, backendFor) {
  return (chatId) => (enabled() ? backendFor(chatId) : null);
}

/**
 * Why a vision backend may not read the screen now (vision/index.cjs allowing), as the model is told.
 * @param {string} vendor
 * @param {{ why?: string, reason?: string }} r
 */
function notAllowed(vendor, r) {
  if (r.why === 'unattended') return `Nobody is here to allow sending screenshots to ${vendor} (${r.reason})`;
  if (r.why === 'dismissed') return `The card asking to send screenshots to ${vendor} went away unanswered (it is asked again next time)`;
  return `The user didn't allow sending screenshots to ${vendor} (asked again in a later turn)`;
}

class VisionFallback {
  /**
   * @param {object} o
   * @param {(chatId: string) => ReturnType<typeof pickBackend> | Promise<ReturnType<typeof pickBackend>>} o.backendFor the backend for the chat's model (see pickBackend)
   * @param {(backend: NonNullable<ReturnType<typeof pickBackend>>, req: { png: string, mimeType?: string, prompt: string, signal?: AbortSignal }) => Promise<string>} o.read asks the backend's model about a screenshot
   * @param {InstanceType<typeof import('../contract/approvals.cjs').ApprovalBroker>} o.broker
   * @param {VisionConsent} [o.consent]
   */
  constructor(o) {
    this.backendFor = o.backendFor;
    this.read = o.read;
    this.broker = o.broker;
    this.consent = o.consent || new VisionConsent();
  }

  /** What the chat's results carry now. */
  async plan(chatId, modality) {
    const backend = await this.backendFor(chatId);
    return visionPlan({ modality, backend, consent: backend ? this.consent.get(chatId, backend.vendor) : 'unasked' });
  }

  /** Asks on the first cross-vendor use; returns the backend, or null when it may not be used (see allowing). */
  async allow(chatId, backend, ctx) {
    return (await this.allowing(chatId, backend, ctx)).backend;
  }

  /**
   * Asks on the first cross-vendor use: {backend}, or {backend: null, why} when it may not be used now.
   * why: 'refused' (the user said no; not asked again until the turn ends), 'dismissed' (the card went away
   * unanswered: the turn ended or the harness stopped, so a later call asks again) or 'unattended' (nobody is
   * here to answer, e.g. a scheduled run: the card is not put up, and `reason` says why).
   * @param {string} chatId
   * @param {NonNullable<ReturnType<typeof pickBackend>>} backend
   * @param {{ harness: string, app: { bundleId: string, name: string },
   *           unattended?: () => string | null | Promise<string | null>, reveal?: () => void, signal?: AbortSignal | null }} ctx
   *   `unattended`: why nobody can answer now, or null; `reveal`: brings MoPilot's windows back before the card;
   *   `signal`: the tool call's, which withdraws the card (then 'dismissed')
   * @returns {Promise<{ backend: NonNullable<ReturnType<typeof pickBackend>> | null, why?: 'refused' | 'dismissed' | 'unattended', reason?: string }>}
   */
  async allowing(chatId, backend, ctx) {
    const state = this.consent.get(chatId, backend.vendor);
    if (state === 'refused') return { backend: null, why: 'refused' };
    if (!needsConsent(backend, state)) return { backend };
    const reason = ctx.unattended ? await ctx.unattended() : null;
    if (reason) return { backend: null, why: 'unattended', reason };
    ctx.reveal?.();
    const answer = await this.broker.ask(
      chatId,
      'visionConsent',
      { harness: ctx.harness, app: ctx.app, model: backend.model, vendor: backend.vendor },
      { signal: ctx.signal },
    );
    if (!answer) return { backend: null, why: 'dismissed' };
    if (answer.decision !== 'allow') {
      this.consent.set(chatId, backend.vendor, 'refused');
      return { backend: null, why: 'refused' };
    }
    // "Allow once" asks again next time
    if (answer.scope === 'chat' || answer.scope === 'always') this.consent.set(chatId, backend.vendor, answer.scope);
    return { backend };
  }

  /** The chat's turn ended: its refusals are forgotten (the next turn may ask again). */
  turnEnded(chatId) {
    this.consent.forgetRefusals(chatId);
  }

  /** Where `query` is on the screenshot, in the screenshot's pixels, or null. */
  async locate(backend, shot, query, signal) {
    const prompt = `This is a ${shot.width}x${shot.height} pixel screenshot. Where is the center of: ${query}? Answer with only JSON like {"x": 120, "y": 340} in pixels of this image, or {"found": false}.`;
    const text = await this.read(backend, { png: shot.png, mimeType: shot.mimeType, prompt, signal });
    if (/"found"\s*:\s*false/i.test(text)) return { text, point: null };
    return { text, point: parsePoint(text, { width: shot.width, height: shot.height }) };
  }

  /** A text description of the screenshot, or of `region` of it. */
  describe(backend, shot, region, signal) {
    const where = region ? ` Focus on: ${region}.` : '';
    const prompt = `Describe what is on this screenshot for someone who cannot see it: the app, the visible text, buttons, fields and their state.${where} Be concise.`;
    return this.read(backend, { png: shot.png, mimeType: shot.mimeType, prompt, signal });
  }
}

module.exports = { VisionFallback, VisionConsent, readerOf, pickBackend, gatedBackend, notAllowed };
