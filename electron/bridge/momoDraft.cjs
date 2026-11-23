// window.native.momoDraft: a MoMo draft card's native calls (A3, electron/app/momoDrafts.cjs and momoDraftSend.cjs): Open in Mail hands the draft's words to the user's own mail app as a mailto link main builds; the From chooser's accounts, Send and a note's send state go through the trust layer in main. Every call is refused while MoMo is not allowed.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  /** open the user's mail app on the draft (to, subject, body), or say why not */
  openInMail: invoke('momoDraft:openInMail', 1),
  /** the connected mail accounts the draft can be sent from */
  accounts: invoke('momoDraft:accounts'),
  /** send the card's words from one account, through the trust layer; answers when the send ended */
  send: invoke('momoDraft:send', 1),
  /** how far a draft note's send got */
  state: invoke('momoDraft:state', 1),
  /** a draft note's send moved */
  onState: on('momoDraft:state'),
};
