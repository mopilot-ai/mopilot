// Each absolute-path/key tuple has its own atomic storage item, so independent windows cannot overwrite sibling controls.
export const MAX_CANVAS_STATE = 128_000;
export const canvasStoragePrefix = (path: string) => `mopilot:canvas:[${JSON.stringify(path)},`;
export const canvasStorageKey = (path: string, key: string) => `mopilot:canvas:${JSON.stringify([path, key])}`;
export function readCanvasState(storage: Storage, path: string, onInvalid?: () => void): Record<string, unknown> {
  const entries: [string, unknown][] = [];
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (!name?.startsWith(canvasStoragePrefix(path))) continue;
    try {
      const tuple = JSON.parse(name.slice('mopilot:canvas:'.length));
      if (tuple.length !== 2 || typeof tuple[1] !== 'string') throw Error('Invalid canvas state key.');
      const raw = storage.getItem(name);
      if (raw === null) continue;
      if (raw.length > MAX_CANVAS_STATE) throw Error('Canvas state is too large.');
      entries.push([tuple[1], JSON.parse(raw)]);
    } catch (error) {
      if (!onInvalid) throw error;
      onInvalid();
    }
  }
  return Object.fromEntries(entries);
}
export function serializeCanvasValue(key: string, value: unknown) {
  if (key.length > 256) throw Error('Canvas state key is too large.');
  const next = JSON.stringify(value);
  if (next === undefined) throw Error('Canvas state must be JSON data.');
  if (next.length > MAX_CANVAS_STATE) throw Error('Canvas state is too large.');
  return next;
}
export function saveCanvasValue(storage: Storage, path: string, key: string, value: unknown) {
  storage.setItem(canvasStorageKey(path, key), serializeCanvasValue(key, value));
}
