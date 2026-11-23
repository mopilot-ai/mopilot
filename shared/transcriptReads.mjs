// Latest-read ownership for external transcript refreshes; unwatch and local takeover retire pending replies.
export class TranscriptReads {
  reads = new Map();

  /** Only the newest read whose captured source and displayed transcript still match may publish. */
  begin(id, valid) {
    const current = () => this.reads.get(id) === current && valid();
    this.reads.set(id, current);
    return current;
  }

  forget(id) {
    this.reads.delete(id);
  }
}
