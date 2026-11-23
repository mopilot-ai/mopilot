// Preserve one actual tool screenshot for the panel while full/reference histories still discard inline media bytes.
const { stepDetails } = require('../capabilities/contract/chromePanelStep.cjs');

class PanelHistoryMedia {
  constructor() {
    this.recent = new Map();
  }
  keep(source, turn) {
    if (typeof turn.id !== 'string') return;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!['mcpToolCall', 'dynamicToolCall'].includes(item?.type) || typeof item.id !== 'string') continue;
      const thumbnail = stepDetails(item).thumbnail;
      if (!thumbnail) continue;
      const key = JSON.stringify([source, turn.id, item.id]);
      this.recent.delete(key);
      this.recent.set(key, thumbnail);
      // Native histories can be huge, or contain parts excluded by segment slicing: at most 1.6 MB per read.
      if (this.recent.size > 4) this.recent.delete(this.recent.keys().next().value);
    }
  }
  apply(turns) {
    for (let t = turns.length - 1; t >= 0; t--) {
      const turn = turns[t];
      const items = Array.isArray(turn.items) ? turn.items : [];
      for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i];
        const thumbnail = this.recent.get(JSON.stringify([turn.sourceSession, turn.id, item?.id]));
        if (thumbnail) {
          item.panelThumbnail = thumbnail;
          return;
        }
      }
    }
  }
}
module.exports = { PanelHistoryMedia };
