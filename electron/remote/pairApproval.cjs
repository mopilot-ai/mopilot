// The user's confirmation of a phone being paired, through the app's one ApprovalBroker as a remotePair card (the phone's name and the twenty-digit safety number both screens show). The card lives in a chat's SessionState like every Sage card, so it waits with no window open; the pairing's signal (the QR closed, the confirmation timed out) withdraws it. No broker, no chat to put it in, or an answer that is neither allow nor deny counts as no confirmation.
const KIND = 'remotePair';

/**
 * @param {{ broker: () => { ask(chatId: string, kind: string, params: object, o: { signal: AbortSignal }): Promise<any> } | null, chatId: () => string | null }} o
 * @returns {(req: { device: { id: string, name: string }, safetyNumber: string, signal: AbortSignal }) => Promise<'allow' | 'deny' | null>}
 */
function createPairConfirm({ broker, chatId }) {
  return async ({ device, safetyNumber, signal }) => {
    const b = broker();
    const chat = chatId();
    if (!b || !chat) return null;
    const answer = await b.ask(chat, KIND, { remotePair: { deviceName: device.name, safetyNumber } }, { signal });
    const decision = answer?.decision;
    return decision === 'allow' || decision === 'deny' ? decision : null;
  };
}

module.exports = { createPairConfirm, KIND };
