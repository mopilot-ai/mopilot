// window.native.momoHome: MoMo's home (electron/app/ipc/momoHome.cjs): its whole view, one intent at a time, its changes, and in a dev run the scripted home's scenario.
const { invoke, on } = require('./spec.cjs');

module.exports = {
  view: invoke('momoHome:view'),
  intent: invoke('momoHome:intent', 1),
  onChanged: on('momoHome:changed'),
  dev: invoke('momoHome:dev'),
  devScenario: invoke('momoHome:devScenario', 1),
  devRefuse: invoke('momoHome:devRefuse', 4),
  devTurnAnswer: invoke('momoHome:devTurnAnswer', 2),
  devRelease: invoke('momoHome:devRelease'),
  devSetView: invoke('momoHome:devSetView', 1),
};
