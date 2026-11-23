// The id an ACP harness's form question has as a card (Chrome's side panel, a phone's card list, MoMo's "needs you" push): one prefix, so the card and the push that names it agree.

/** What every ACP form question's card id starts with; the rest is the question's own id. */
export const ACP_FORM_CARD = 'panel:acp-form:';

/** The card id of the ACP form question `questionId`. @param {string} questionId */
export const acpFormCardId = (questionId) => `${ACP_FORM_CARD}${questionId}`;
