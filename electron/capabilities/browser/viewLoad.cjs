// A pane's pending preview restoration yields to navigation, Stop and page disposal.
function cancelPaneLoad(entry) {
  entry.previewLoad = null;
}

function loadPanePage(entry, url, prepare, load, failed) {
  cancelPaneLoad(entry);
  entry.previewUrl = null;
  const pending = prepare?.(entry.chat, url);
  if (!pending) return load(url);
  const owner = {};
  entry.previewLoad = owner;
  entry.previewUrl = url;
  const current = () => entry.previewLoad === owner && !entry.wc.isDestroyed();
  return pending.then(
    (resolved) => {
      if (!current()) return;
      entry.previewLoad = null;
      entry.previewUrl = null;
      return load(resolved);
    },
    (error) => {
      if (!current()) return;
      entry.previewLoad = null;
      failed({ errorCode: -2, errorDescription: error.message, validatedURL: url, isMainFrame: true });
      throw error;
    },
  );
}

module.exports = { loadPanePage, cancelPaneLoad };
