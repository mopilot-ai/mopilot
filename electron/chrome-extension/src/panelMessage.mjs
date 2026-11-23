// Message and code-copy controls plus persistent long-user-message disclosures in the Chrome panel, using only text and DOM nodes.
const copy = (doc, text, label, truncated = false) => {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'message-copy';
  button.dataset.panelCopy = text;
  button.dataset.copyState = truncated ? 'Copy shown text' : 'Copy';
  button.dataset.copyIdle = button.dataset.copyState;
  button.dataset.copyDone = truncated ? 'Copied shown text' : 'Copied';
  button.setAttribute('aria-label', label);
  button.title = label;
  return button;
};

export function messageTools(doc, el, row, key, open) {
  if (row.role !== 'user' && row.role !== 'assistant') return;
  if (row.role === 'user' && row.text.length > 600) {
    const details = doc.createElement('details');
    details.className = 'message-fold';
    details.open = open.has(key);
    details.addEventListener('toggle', () => (details.open ? open.add(key) : open.delete(key)));
    const summary = doc.createElement('summary');
    summary.textContent = `${Array.from(row.text).slice(0, 180).join('')}…`;
    const full = doc.createElement('div');
    full.textContent = el.textContent;
    details.append(summary, full);
    el.textContent = '';
    el.append(details);
  }
  el.append(copy(doc, row.text, row.truncated ? 'Copy shown text (this message is truncated)' : 'Copy message', !!row.truncated));
  for (const pre of el.querySelectorAll?.('pre') ?? []) {
    pre.append(copy(doc, pre.querySelector('code')?.textContent ?? pre.textContent, 'Copy code'));
  }
}
