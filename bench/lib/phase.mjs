// Benchmark message-phase timestamps are separate from the booleans that report start/completion.
/** @param {number} startedAt @param {number} endedAt @param {boolean} started @param {boolean} ended */
export const phaseRecord = (startedAt, endedAt, started, ended) => ({ startedAt, endedAt, started, ended, wallMs: endedAt - startedAt });
