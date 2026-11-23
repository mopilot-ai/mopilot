// The capability registry's operation log, kept on this machine only: what each tool call ran and how it ended. @host-portable
const { TranscriptWriter } = require('../../platform/transcriptWriter.cjs');

/**
 * Operation log, kept on this machine only: what ran, for which chat and segment, and how it ended.
 * It records argument names but never their values, so typed text, URLs and screenshots stay out of it,
 * and nothing here is ever handed to telemetry.
 */
class OperationLog {
  /** @param {{ file?: string, max?: number, writer?: { append(file: string, lines: string[], opts?: { mode?: number, what?: string }): void } }} [o] */
  constructor(o = {}) {
    this.file = o.file || null;
    this.max = o.max ?? 500;
    this.entries = [];
    this.writer = o.writer ?? new TranscriptWriter();
  }
  add(e) {
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    if (!this.file) return;
    // written in the background with the chat transcripts (electron/platform/transcriptWriter.cjs), never per call on the
    // main loop; the log is best effort, so a failure is only recorded there (the entry stays in memory)
    this.writer.append(this.file, [JSON.stringify(e) + '\n'], { mode: 0o600, what: 'append to the tool operation log' });
  }
  recent(n = 50) {
    return this.entries.slice(-n);
  }
}

module.exports = { OperationLog };
