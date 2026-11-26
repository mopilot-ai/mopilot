// The diagnostic receipt the signed update check observes from a live app before asking it to quit.
const preparedUpdateLine = (version) => `[updates] Prepared macOS update ${version}`;

module.exports = { preparedUpdateLine };
