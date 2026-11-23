// What the user does to the agents on one of their machines from here: sign in to one (machineSignin.cjs) and install a missing one (machineInstall.cjs), over the machine's shared remote Host, each refused while Host is not allowed, and all of it ended when a machine leaves or Host access ends.
const { createMachineSignin } = require('./machineSignin.cjs');
const { createMachineInstall } = require('./machineInstall.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {{ list: () => any[], check: () => Promise<unknown> }} o.registry
 * @param {(id: string) => any} o.hostFor a machine's remote Host (machines.cjs: one per machine, shared with chat sends)
 * @param {(url: string) => unknown} o.openExternal opens a sign-in link in the Mac's browser
 * @param {(view: any) => void} o.onSignin told how each sign-in stands, at every change
 * @param {(view: any) => void} o.onInstall told how each agent install stands, at every change
 * @param {() => void} o.refuseUnlessAllowed throws while Host is not available for the account
 */
function createMachineAgents({ registry, hostFor, openExternal, onSignin, onInstall, refuseUnlessAllowed }) {
  const signin = createMachineSignin({
    registry,
    hostFor,
    openExternal,
    onChange: onSignin,
    report: (error) => noteIgnored('finish a Host sign-in', error),
  });
  const install = createMachineInstall({
    registry,
    hostFor,
    onChange: onInstall,
    report: (error) => noteIgnored('finish installing an agent on a machine', error),
  });
  const actions = {
    /** Sign in to an agent on a machine, on the machine itself: its link opens on this Mac, its code shows in the window, and the token stays there. Returns how the sign-in stands (a second call joins the one under way); changes arrive through `onSignin`. @param {string} id @param {string} harness */
    signIn(id, harness, recoveryKey, openHere = true) {
      refuseUnlessAllowed();
      return signin.start(id, harness, recoveryKey, openHere);
    },
    /** How the latest sign-in of the agent on the machine stands; null when none was started. @param {string} id @param {string} harness */
    signInStatus(id, harness) {
      refuseUnlessAllowed();
      return signin.status(id, harness);
    },
    /** One line the person typed for the sign-in under way (the code the page asks for); false when none is. @param {string} id @param {string} harness @param {string} text */
    signInInput(id, harness, text) {
      refuseUnlessAllowed();
      return signin.input(id, harness, text);
    },
    /** @param {string} id @param {string} harness */
    cancelSignIn(id, harness) {
      refuseUnlessAllowed();
      return signin.cancel(id, harness);
    },
    signInViews() {
      refuseUnlessAllowed();
      return signin.views();
    },
    /** Install a missing agent on a machine, on the machine itself (no root, the vendor's own package). Returns how it stands (a second call joins the one under way); changes arrive through `onInstall`. @param {string} id @param {string} harness */
    installAgent(id, harness) {
      refuseUnlessAllowed();
      return install.start(id, harness);
    },
    /** How the latest install of the agent on the machine stands; null when none was started. @param {string} id @param {string} harness */
    installStatus(id, harness) {
      refuseUnlessAllowed();
      return install.status(id, harness);
    },
    /** @param {string} id @param {string} harness */
    cancelInstall(id, harness) {
      refuseUnlessAllowed();
      return install.cancel(id, harness);
    },
  };
  return {
    actions,
    /** The machine is leaving the list: its sign-ins and installs end and the machine is told to stop them. Resolves once it was told (null when nothing was under way); call before the registry drops the record. @param {string} id */
    forget(id) {
      const asked = [signin.forget(id), install.forget(id)].filter(Boolean);
      return asked.length > 0 ? Promise.all(asked).then(() => undefined) : null;
    },
    /** Host access was lost, or the app is closing: nothing is followed any more. */
    dispose() {
      signin.dispose();
      install.dispose();
    },
  };
}

module.exports = { createMachineAgents };
