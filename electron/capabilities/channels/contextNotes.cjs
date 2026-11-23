// Context-note acknowledgments are scoped to the captured generation, retired on every note invalidation.
class ContextNotes extends Set {
  constructor() {
    super();
    this.receipts = new Map();
  }

  capture(threadId) {
    if (!this.receipts.has(threadId)) this.receipts.set(threadId, {});
    return this.receipts.get(threadId);
  }

  acknowledge(threadId, receipt) {
    if (receipt && this.receipts.get(threadId) === receipt) this.add(threadId);
  }

  delete(threadId) {
    this.receipts.delete(threadId);
    return super.delete(threadId);
  }

  clear() {
    this.receipts.clear();
    super.clear();
  }
}

module.exports = { ContextNotes };
