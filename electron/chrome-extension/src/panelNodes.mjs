// Reconcile bounded transcript blocks without detaching unchanged DOM, preserving native selection and inner scroll.
export function reconcile(parent, nodes) {
  const keep = new Set(nodes);
  for (const child of [...parent.children]) if (!keep.has(child)) parent.removeChild(child);
  nodes.forEach((node, i) => {
    if (parent.children[i] !== node) parent.insertBefore(node, parent.children[i] ?? null);
  });
}
