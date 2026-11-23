// Linked children inherit a known ACP native permission anchor; absent or unknown scope never borrows app defaults.
const { acpCurrentMode } = require('../../../shared/acpMode.mjs');

const PERMISSION = { readOnly: 'read-only', ask: 'default', auto: 'auto-review', full: 'full-access' };

function inheritedPermission(state) {
  const mode = acpCurrentMode(state?.acp);
  const anchors = state?.acp?.anchors;
  const anchor =
    mode && anchors && typeof anchors === 'object' && !Array.isArray(anchors) && Object.hasOwn(anchors, mode) ? anchors[mode] : null;
  if (!Object.hasOwn(PERMISSION, anchor))
    throw new Error('The parent session has not reported a known permission scope; a linked session cannot safely inherit it.');
  return PERMISSION[anchor];
}

module.exports = { inheritedPermission };
