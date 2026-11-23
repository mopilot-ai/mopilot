// window.native.pullRequests: the sidebar PR badges' saved replies, kept in main across launches (electron/app/ipc/pullRequestReplies.cjs).
const { invoke } = require('./spec.cjs');

module.exports = {
  savedReplies: invoke('pullRequests:savedReplies', 2),
  saveReplies: invoke('pullRequests:saveReplies', 3),
};
