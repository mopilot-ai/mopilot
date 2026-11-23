// Superagent stable content-derived ids: equal inputs always produce the same id.
// Ported to CommonJS from deepseek-ai/dsh-superagent-prototype src/core/ids.ts (MIT, Copyright (c) 2026 DeepSeek Harness Team; see NOTICE).
const { createHash } = require('node:crypto');

/** @param {...string} values @returns {string} a 32-character hex id derived from the values */
const key = (...values) => createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);

module.exports = { key };
