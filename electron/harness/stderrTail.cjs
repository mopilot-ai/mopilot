// A process's diagnostic stderr tail, bounded by report size instead of the number or size of incoming chunks.
const { suffixUnits } = require('../../shared/textPrefix.mjs');

class StderrTail {
  /** @param {number} max positive UTF-16-unit budget of the process's diagnostic report */
  constructor(max) {
    this.max = max;
    this.text = '';
  }

  /** @param {string | Buffer} chunk */
  push(chunk) {
    const text = String(chunk);
    const next = text.length >= this.max ? text.slice(-this.max) : this.text + text;
    // Copy only the small suffix: a sliced string must not retain a large chunk's backing storage.
    this.text = Buffer.from(suffixUnits(next, this.max), 'utf16le').toString('utf16le');
  }
}

module.exports = { StderrTail };
