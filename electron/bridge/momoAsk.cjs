// window.native.momoAsk: Ask MoMo in Quick Chat (electron/momo/askIpc.cjs): MoMo's main chat, a message to it, and opening it in the app.
const { call } = require('./spec.cjs');
module.exports = {
  chat: call('momoAsk:chat'),
  send: call('momoAsk:send'),
  open: call('momoAsk:open'),
};
