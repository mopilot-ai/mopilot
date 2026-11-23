// How long the person at this Mac has been idle (Electron's powerMonitor), read when asked: computer use on a Host's desktop counts the user as present only while they are here.
/** @returns {Promise<number>} seconds */
const userIdleSeconds = async () => require('electron').powerMonitor.getSystemIdleTime();

module.exports = { userIdleSeconds };
