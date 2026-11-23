// A remote Host's requests to install a missing agent on it (host.install*, host/src/agentInstall.mjs): each one control request through the shared parsers, joined into createRemoteHost (remote.cjs); an older Host is refused before anything is sent (`feature_missing`).

/** @param {(method: string, params: object) => Promise<any>} control one control request to the Host */
function installCalls(control) {
  return {
    /** Install a missing agent on the Host, or join the install under way; how it goes comes back through `installStatus`. @param {{ harness: string }} p */
    install: (p) => control('host.install', p),
    /** How the agent's latest install stands (null when none was started). @param {{ harness: string }} p */
    installStatus: (p) => control('host.installStatus', p),
    /** Stop the install on the Host; false when none was under way. @param {{ harness: string }} p */
    installCancel: (p) => control('host.installCancel', p),
  };
}

module.exports = { installCalls };
