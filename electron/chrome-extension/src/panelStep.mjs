// Native step disclosures preserve their open state and display only text and inline screenshot previews.

/** How long a turn worked, as ChatGPT's panel says it: "11s", "2m 5s", "1h 3m". */
export function workedFor(/** @type {number} */ ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}

export function stepElement(doc, row, key, opened) {
  const hasImage =
    typeof row.thumbnail === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/\r\n]+={0,2}$/.test(row.thumbnail);
  const el = doc.createElement(row.detail || hasImage ? 'details' : 'div');
  el.className = 'step';
  el.dataset.label = row.text;
  if (row.surface) el.dataset.surface = row.surface;
  // how far the call has got, when its harness says (a step with none is done): the stylesheet shimmers a running one
  if (row.state === 'running' || row.state === 'failed') el.dataset.state = row.state;
  if (row.workedMs) el.dataset.workedMs = String(row.workedMs);
  if (!row.detail && !hasImage) {
    el.textContent = row.text;
    return el;
  }
  el.open = opened.has(key);
  el.addEventListener('toggle', () => (el.open ? opened.add(key) : opened.delete(key)));
  const summary = doc.createElement('summary');
  summary.textContent = row.text;
  el.append(summary);
  if (row.detail) {
    const pre = doc.createElement('pre');
    pre.textContent = row.detail;
    el.append(pre);
  }
  if (hasImage) {
    const image = doc.createElement('img');
    image.src = row.thumbnail;
    image.alt = 'Screenshot returned by this step';
    image.className = 'step-thumbnail';
    el.append(image);
  }
  return el;
}
