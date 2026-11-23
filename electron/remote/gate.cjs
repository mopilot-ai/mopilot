// remote.enabled gates phones: the service serves a transport only while the switch is on, and drops every pair's state when it turns off.

/**
 * @param {object} o
 * @param {InstanceType<typeof import('./service.cjs').RemoteService>} o.service
 * @param {import('../../shared/remote/transport.mjs').RemoteTransport} o.transport the sealed channel's Mac end
 * @param {() => boolean} o.enabled the remote.enabled flag now
 * @returns {{ apply: () => boolean }} apply() after the flag may have changed; true while serving
 */
function gateRemote({ service, transport, enabled }) {
  const apply = () => {
    if (!enabled()) {
      service.detach();
      return false;
    }
    if (service.transport !== transport) service.attach(transport);
    return true;
  };
  apply();
  return { apply };
}

module.exports = { gateRemote };
