// What MoMo's home needs of the app to reach a phone (remote/service.cjs `momoHome`): the home API main holds, the `momo.home` flag and the home's changes.
const { getHomeApi, onHomeChanged } = require('../momo/homeSlot.cjs');
const { isEnabled } = require('../platform/flags.cjs');

/** The service option for phones: the home API once main has one, whether the flag is on, and how to hear a change. */
const homeChannel = () => ({ momoHome: { api: getHomeApi, flagOn: () => isEnabled('momo.home'), on: onHomeChanged } });

module.exports = { homeChannel };
