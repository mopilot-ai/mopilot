// window.native.momoSuggestions: what MoMo suggested for the Tasks panel's Up next (A7, electron/momo/suggestionsIpc.cjs): read the live ones, and the user's own Add, Start or Hide on one. Refused while MoMo is not allowed. Nothing here starts work except the user's Start.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  /** the live suggestions, best first, each with its source line and score inputs */
  list: invoke('momoSuggestions:list'),
  /** the user's act on one: (id, 'add' | 'start' | 'hide'); Start sends its first step to MoMo's chat */
  act: invoke('momoSuggestions:act', 2),
  /** a suggestion was added, started, hidden or expired: read again */
  onChanged: on('momoSuggestions:changed'),
};
