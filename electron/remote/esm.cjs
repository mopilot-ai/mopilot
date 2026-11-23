// The shared ESM modules of Mobile Remote (shared/remote/*.mjs) for CommonJS main code: require() of an ES module that has no top-level await.
const envelope = require('../../shared/remote/envelope.mjs');
const crypto = require('../../shared/remote/crypto.mjs');

module.exports = { ...envelope, ...crypto };
