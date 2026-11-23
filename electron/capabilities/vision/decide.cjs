// What a chat's computer-use results carry, by what its model can take in, and who reads the
// screen when the model can't. Pure: no I/O, so the decision is testable on its own.

const MOPILOT_VENDOR = 'MoPilot';

/**
 * The backend that reads screenshots for a text-only model: the chat provider's own vision model
 * (same vendor, no consent needed), else a vision model on MoPilot credits (another vendor unless
 * the chat already runs on MoPilot), else none.
 * @param {{ provider?: { vendor: string, model: string } | null, mopilot?: { signedIn: boolean, model: string } | null, chatVendor?: string | null }} o
 * @returns {{ source: 'provider' | 'mopilot', vendor: string, model: string, crossVendor: boolean } | null}
 */
function pickBackend(o) {
  if (o.provider?.model) return { source: 'provider', vendor: o.provider.vendor, model: o.provider.model, crossVendor: false };
  if (o.mopilot?.signedIn && o.mopilot.model)
    return { source: 'mopilot', vendor: MOPILOT_VENDOR, model: o.mopilot.model, crossVendor: o.chatVendor !== MOPILOT_VENDOR };
  return null;
}

/** Whether a first use of this backend has to ask before a screenshot leaves for it. */
const needsConsent = (backend, consent) => !!backend && backend.crossVendor && consent === 'unasked';

/**
 * What a computer-use result carries and which tools help the model.
 * @param {{ modality: 'image' | 'text' | null | undefined, backend: ReturnType<typeof pickBackend>, consent?: 'unasked' | 'granted' | 'refused' }} o
 *   modality: what the model takes in (null/undefined: unknown). consent: the user's answer for this backend's vendor.
 * @returns {{ kinds: ('screenshot' | 'elements')[], ocr: boolean, locate: boolean, backend: ReturnType<typeof pickBackend> }}
 *   ocr: add the local OCR text elements to the list; locate: locate and describe are usable (through `backend`)
 */
function visionPlan(o) {
  const usable = o.backend && !(o.backend.crossVendor && o.consent === 'refused') ? o.backend : null;
  if (o.modality === 'image') return { kinds: ['screenshot'], ocr: false, locate: false, backend: null };
  // text-only: the screenshot never goes to the model itself; without a backend the element list gets OCR text
  if (o.modality === 'text') return { kinds: ['elements'], ocr: !usable, locate: !!usable, backend: usable };
  // unknown: may or may not see images, so both, and the helper tools when there is a backend
  return { kinds: ['screenshot', 'elements'], ocr: false, locate: !!usable, backend: usable };
}

/** What the activity bar says while the screen is being read, or null when the model reads it itself. */
function readerOf(plan) {
  if (plan.kinds.includes('screenshot')) return null;
  return plan.backend ? { model: plan.backend.model, vendor: plan.backend.vendor } : { text: true };
}

module.exports = { MOPILOT_VENDOR, pickBackend, needsConsent, visionPlan, readerOf };
