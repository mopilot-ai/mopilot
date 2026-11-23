// Serializes group allocation and joins per exact extension Session, returning each tab's own acknowledged membership, and titles each group for its chat and the chat's turn.

export const GROUP_COLOR = 'blue';
/** The mark before a group's title while the chat's turn runs, waits for the user, or is done (Claude in Chrome's). */
export const STATUS_MARK = Object.freeze(Object.assign(Object.create(null), { running: '⌛', waiting: '🔔', done: '✅' }));

/** The group's title: the chat's, after its turn's mark. @param {{ title: string, status?: string | null }} s */
export const groupTitle = (s) => (s.status && STATUS_MARK[s.status] ? `${STATUS_MARK[s.status]} ${s.title}` : s.title);

const validGroup = (id) => Number.isSafeInteger(id) && id >= 0;

export class Groups {
  constructor({ chrome, changed, log, owns = (_tabId) => true }) {
    this.chrome = chrome;
    this.changed = changed;
    this.log = log;
    this.owns = owns;
    this.tails = new WeakMap();
    /** Only the native mutation suppresses group events; queued tabs and metadata waits remain user-releasable. */
    this.active = new Map();
  }

  /** The caller keeps its result/rejection; the lane only keeps settlement, so failures never poison successors. */
  put(s, tabId, current, { grouped = (_groupId) => undefined, retired = (groupId) => this.discard(tabId, groupId) } = {}) {
    return this.#lane(s, () => this.#put(s, tabId, current, grouped, retired));
  }

  /** A late native effect may outlive its chat; undo only that effect on a still-unowned tab. */
  async discard(tabId, groupId) {
    if (!validGroup(groupId) || this.owns(tabId)) return;
    try {
      const tab = await this.chrome.tabs.get(tabId);
      if (this.owns(tabId) || tab.groupId !== groupId) return;
      await this.chrome.tabs.ungroup([tabId]);
    } catch (error) {
      this.log('release a retired tab group', error);
    }
  }

  /**
   * session.status: the chat's title and whether its turn runs, waits for the user or is done, shown on its group.
   * @param {any} s the chat's session, if it has one @param {{ title?: unknown, status?: unknown } | undefined} o @param {() => void} saved
   */
  status(s, o, saved) {
    if (!s) return;
    const { title, status } = o ?? {};
    if (typeof title === 'string' && title.trim()) s.title = title.trim().slice(0, 80);
    s.status = typeof status === 'string' && STATUS_MARK[status] ? status : null;
    saved();
    return this.retitle(s);
  }

  /** Titles the session's group as the session is now (its chat's title and turn), after any grouping under way. */
  retitle(s) {
    return this.#lane(s, async () => {
      if (!validGroup(s.groupId)) return;
      await this.chrome.tabGroups.update(s.groupId, { title: groupTitle(s) }).catch((error) => this.log('title a tab group', error));
    });
  }

  #lane(s, work) {
    const result = (this.tails.get(s) ?? Promise.resolve()).then(work);
    this.tails.set(
      s,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  async #put(s, tabId, current, grouped, retired) {
    if (!current()) return;
    let target = s.groupId;
    if (target != null) {
      const alive = await this.chrome.tabGroups.get(target).then(
        () => true,
        () => false,
      );
      if (!current()) return;
      if (!alive) {
        s.groupId = null;
        target = null;
      }
    }
    let groupId;
    try {
      const mutation = {};
      this.active.set(tabId, mutation);
      try {
        groupId = await this.chrome.tabs.group({ tabIds: [tabId], ...(target == null ? {} : { groupId: target }) });
        grouped(groupId);
      } finally {
        if (this.active.get(tabId) === mutation) this.active.delete(tabId);
      }
      if (!current()) {
        await retired(groupId);
        return;
      }
      if (!validGroup(groupId)) throw new Error('Chrome returned an invalid tab group id.');
    } catch (error) {
      if (!current()) return;
      // A grouping-ineligible popup stays owned. Read its actual membership instead of substituting the session's group.
      this.log('group a tab', error);
      const tab = await this.chrome.tabs.get(tabId);
      if (!current()) return;
      if (tab?.id !== tabId) throw new Error('Chrome did not return the tab whose grouping failed.');
      return validGroup(tab.groupId) ? tab.groupId : -1;
    }
    if (target == null) {
      s.groupId = groupId;
      // Retain the acknowledged allocation even if optional metadata fails or the worker stops while it waits.
      this.changed();
      await this.chrome.tabGroups
        .update(groupId, { title: groupTitle(s), color: GROUP_COLOR })
        .catch((error) => this.log('group a tab', error));
    }
    if (current()) return groupId;
    await retired(groupId);
  }
}
