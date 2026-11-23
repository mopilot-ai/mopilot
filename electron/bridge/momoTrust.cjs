// window.native.momoTrust: MoMo's trust records in Settings › MoMo (electron/app/ipc/momoTrust.cjs): their state, exporting the audit log, starting a new log, setting unreadable approvals aside, and removing an always-allowed site.
const { call } = require('./spec.cjs');

module.exports = {
  status: call('momoTrust:status'),
  exportAudit: call('momoTrust:exportAudit'),
  startOverAudit: call('momoTrust:startOverAudit'),
  setAsideApprovals: call('momoTrust:setAsideApprovals'),
  removeSite: call('momoTrust:removeSite'),
};
