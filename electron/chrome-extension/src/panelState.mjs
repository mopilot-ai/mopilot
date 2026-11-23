// The service worker owns all per-tab panel writes: chat choices, composer/selection drafts, closure and replacement share one ordered storage lane.
export const PANEL_PATH = 'sidepanel.html';
export const bindingKey = (/** @type {number} */ id) => `panelChat:${id}`;
export const draftKey = (/** @type {number} */ id) => `draft:${id}`;
const openKey = (id) => `panelOpen:${id}`;
const moveKey = (id) => `panelMove:${id}`;
export const composerKey = (/** @type {number} */ id) => `panelDraft:${id}`;
const valid = (id) => Number.isSafeInteger(id) && id >= 0;

export class PanelState {
  constructor(/** @type {any} */ chrome) {
    this.chrome = chrome;
    this.tail = Promise.resolve();
    this.retired = new Set();
    this.replacements = new Map();
  }
  run(/** @type {Function} */ work) {
    const result = this.tail.then(() => work());
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  live(/** @type {number} */ id) {
    if (!valid(id) || this.retired.has(id)) throw new Error('This tab has closed or was replaced. Open its current panel.');
  }
  bind(/** @type {number} */ id, /** @type {any} */ chat, explicit = true) {
    this.live(id);
    // Accepted writes keep their place ahead of a later replacement; new writes to a retired id are refused.
    return this.run(async () => {
      const source = await this.source(id);
      if (source !== undefined) await this.move(id, source);
      return explicit || chat
        ? this.chrome.storage.session.set({ [bindingKey(id)]: chat ?? { id: null } })
        : this.chrome.storage.session.remove(bindingKey(id));
    });
  }
  keep(/** @type {number} */ id, /** @type {string} */ text, selection = false) {
    this.live(id);
    if (text.length > 100_000) throw new Error('This draft is too long to save. Keep the panel open and shorten it.');
    return this.run(async () => {
      const source = await this.source(id);
      if (source !== undefined) await this.move(id, source);
      await this.chrome.storage.session.set({ [(selection ? draftKey : composerKey)(id)]: text });
    });
  }
  take(/** @type {number} */ id) {
    if (!valid(id) || this.retired.has(id)) return Promise.resolve('');
    return this.run(async () => {
      const key = draftKey(id);
      const saved = await this.chrome.storage.session.get(key);
      if (typeof saved?.[key] !== 'string') return '';
      await this.chrome.storage.session.remove(key);
      return saved[key];
    });
  }
  forget(/** @type {number} */ id) {
    this.retired.add(id);
    return this.run(async () => {
      const keys = [];
      let at = id;
      do {
        keys.push(bindingKey(at), draftKey(at), composerKey(at), openKey(at), moveKey(at));
        const source = await this.source(at);
        this.replacements.delete(at);
        at = source;
      } while (at !== undefined);
      await this.chrome.storage.session.remove(keys);
    });
  }
  replace(/** @type {number} */ added, /** @type {number} */ removed) {
    this.retired.add(removed);
    this.replacements.set(added, removed);
    return this.run(async () => {
      await this.chrome.storage.session.set({ [moveKey(added)]: removed });
      await this.move(added, removed);
    });
  }
  repair(/** @type {number} */ id, opened = false) {
    this.live(id);
    return this.run(async () => {
      if (opened) await this.chrome.storage.session.set({ [openKey(id)]: true });
      const source = await this.source(id);
      if (source !== undefined) await this.move(id, source);
    });
  }
  async source(id) {
    if (this.replacements.has(id)) return this.replacements.get(id);
    const key = moveKey(id);
    const saved = await this.chrome.storage.session.get(key);
    return valid(saved[key]) && saved[key] !== id ? saved[key] : undefined;
  }
  async move(/** @type {number} */ added, /** @type {number} */ removed, configure = true) {
    const earlier = await this.source(removed);
    if (earlier !== undefined) await this.move(removed, earlier, false);
    const from = [bindingKey(removed), draftKey(removed), composerKey(removed), openKey(removed)];
    const to = [bindingKey(added), draftKey(added), composerKey(added), openKey(added)];
    const saved = await this.chrome.storage.session.get(from);
    const moved = Object.fromEntries(from.filter((key) => Object.hasOwn(saved, key)).map((key) => [to[from.indexOf(key)], saved[key]]));
    if (Object.keys(moved).length) await this.chrome.storage.session.set(moved);
    await this.chrome.storage.session.remove(from);
    const target = await this.chrome.storage.session.get(to);
    if (configure && Object.keys(target).length)
      await this.chrome.sidePanel.setOptions({ tabId: added, path: `${PANEL_PATH}?tabId=${added}`, enabled: true });
    await this.chrome.storage.session.remove(moveKey(added));
    this.replacements.delete(added);
  }
}
