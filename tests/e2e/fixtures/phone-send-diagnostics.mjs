// Keeps bounded, explicitly marked scratch-app diagnostics in native CI failures without publishing unrelated build output.
/** `tail` (a run killed by its timeout) also keeps the last 30 log lines, 200 characters each, to show where a hang stopped. */
export function phoneSendDiagnostics(log, { tail = false } = {}) {
  const errors = [];
  const trees = [];
  const steps = [];
  let tree;
  for (const line of log.split('\n')) {
    const marker = line.trim();
    if (marker === 'PHONE_SEND_UI_TREE_BEGIN') tree = '';
    else if (marker === 'PHONE_SEND_UI_TREE_END') {
      if (tree !== undefined && trees.length < 2) trees.push(tree.length > 16_000 ? `${tree.slice(0, 16_000)} [truncated]` : tree);
      tree = undefined;
    } else if (tree !== undefined) tree = `${tree}${line}\n`.slice(0, 16_001);
    else if (/(^|\s)error: /.test(line) && errors.length < 20) errors.push(line.slice(0, 2000));
    // XCTest's own step trace ("t = 12.30s Tap ..."), so a hang shows the last step it reached
    else if (/^\s*(t =\s+\d|Test Case '|Test Suite ')/.test(line)) {
      steps.push(line.slice(0, 300));
      if (steps.length > 60) steps.shift();
    }
  }
  const lines = tail
    ? log
        .split('\n')
        .filter(Boolean)
        .slice(-30)
        .map((line) => line.slice(0, 200))
    : [];
  return [
    ...errors,
    ...trees,
    ...(steps.length > 0 ? ['XCTest last steps:', ...steps] : []),
    ...(tail ? ['Log tail:', ...lines] : []),
  ].join('\n');
}
