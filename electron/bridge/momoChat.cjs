// window.native.momoChat: MoMo's main chat (electron/momo/mainChatIpc.cjs): make sure it exists, read and change its brain, list the earlier ones.
const { call, on } = require('./spec.cjs');
module.exports = {
  mainChat: call('momoChat:mainChat'),
  getBrain: call('momoChat:brain:get'),
  setBrain: call('momoChat:brain:set'),
  previousChats: call('momoChat:previous'),
  greet: call('momoChat:greet'),
  enableNotices: call('momoChat:enableNotices'),
  setChatModel: call('momoChat:model:set'),
  activityList: call('momoChat:activity:list'),
  watchActivity: call('momoChat:activity:watch'),
  onBrainChanged: on('momoChat:brainChanged'),
  onActivityChanged: on('momoChat:activityChanged'),
};
