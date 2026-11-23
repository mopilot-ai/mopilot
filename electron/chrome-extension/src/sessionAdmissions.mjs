// Tab admission for extension Sessions: source-proven popups and exact panel pages, with one-use grants, serialized transfers and rollback of retired native effects.
export class SessionAdmissions {
  /** @param {any} sessions @param {{ own: Function, release: Function, report: Function, save: Function }} ops */
  constructor(sessions, ops) {
    this.s = sessions;
    this.ops = ops;
    this.grants = new Map();
    this.tails = new Map();
    this.moving = new Map();
  }

  /** Only this operation's own group event is suppressed; a different user move still retires it. */
  isMove(tabId, groupId) {
    const move = this.moving.get(tabId);
    return !!move && move.groupId === groupId;
  }

  revoke(grant) {
    this.grants.delete(grant);
  }

  /** No admission can acknowledge a receipt that retired while its native effect or report was waiting. */
  assertReceipt(method, result, required) {
    if (!required || !['chrome.tabs.create', 'session.adopt'].includes(method)) return;
    const membership = this.s.memberships.get(result?.id);
    if (!membership || membership.id !== result?.membership)
      throw new Error(
        `This Chrome tab membership was retired before its ${method === 'chrome.tabs.create' ? 'creation' : 'handoff'} could be reported.`,
      );
  }

  /** Reconcile final native group facts after dropping this operation's event suppression. */
  async reconcile(tabId) {
    try {
      const tab = await this.s.chrome.tabs.get(tabId);
      if (this.s.memberships.get(tabId)?.groupId !== tab.groupId)
        this.s.onTabUpdated(tabId, { groupId: tab.groupId }, tab, 'group_changed');
    } catch (error) {
      this.s.log('read a panel tab after its group move', error);
    }
  }

  /** A panel Send grants one admission of this exact page, never another tab or a page it navigated to later.
   * @param {number} tabId @param {number} [now] @param {string | null} [targetChat] */
  async offer(tabId, now = Date.now(), targetChat = null) {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw new Error('This panel has no Chrome tab.');
    const tab = await this.s.chrome.tabs.get(tabId);
    if (tab?.id !== tabId || !/^https?:\/\//.test(String(tab.url))) throw new Error('Open a web page to use it from the panel.');
    for (const [key, g] of this.grants) if (g.expires <= now) this.grants.delete(key);
    const grant = globalThis.crypto.randomUUID();
    this.grants.set(grant, {
      tabId,
      url: tab.url,
      targetChat,
      owner: this.s.owner.get(tabId),
      membership: this.s.memberships.get(tabId),
      expires: now + 60_000,
    });
    return { id: tabId, url: tab.url, grant, owner: this.s.owner.get(tabId) ?? null };
  }

  /** Consume before awaiting the tab lane. Same-chat overlapping sends reuse the first acknowledged admission. */
  async panel(chat, session, request, now = Date.now()) {
    const grant = this.grants.get(request?.grant);
    this.grants.delete(request?.grant);
    if (grant && Number.isSafeInteger(request?.deadline)) grant.expires = Math.min(grant.expires, request.deadline);
    if (!session.receipts) throw new Error('Update the MoPilot Chrome extension, then send again from this page.');
    if (!grant || grant.expires <= now || grant.tabId !== request?.id || (grant.targetChat && grant.targetChat !== chat))
      throw new Error('The panel tab grant expired. Send again from that tab.');
    if (this.moving.get(grant.tabId)?.expires <= now)
      throw new Error('Chrome is still finishing an earlier page handoff. Try again when Chrome responds.');
    const result = (this.tails.get(grant.tabId) ?? Promise.resolve()).then(() => {
      if (grant.expires <= Date.now()) throw new Error('The panel tab grant expired. Send again from that tab.');
      return this.#panel(chat, session, grant);
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(grant.tabId, tail);
    void tail.then(() => {
      if (this.tails.get(grant.tabId) === tail) this.tails.delete(grant.tabId);
    });
    return result;
  }

  async #panel(chat, session, grant) {
    const { s, ops } = this;
    const offered = () => s.owner.get(grant.tabId) === grant.owner && s.memberships.get(grant.tabId) === grant.membership;
    const current = () =>
      Date.now() < grant.expires &&
      s.chats.get(chat) === session &&
      (offered() || s.owner.get(grant.tabId) === chat) &&
      (!busy() || s.owner.get(grant.tabId) === chat);
    const busy = () => grant.owner && grant.owner !== chat && ['running', 'waiting'].includes(s.chats.get(grant.owner)?.status);
    const check = () => {
      if (Date.now() >= grant.expires) throw new Error('The panel tab grant expired. Send again from that tab.');
      if (busy() && s.owner.get(grant.tabId) !== chat)
        throw new Error('Another chat is still working in this tab. Stop it before moving the tab.');
      if (!current()) throw new Error('This tab changed owners or its chat closed while the panel was handing it over.');
    };
    check();
    const tab = await s.chrome.tabs.get(grant.tabId);
    check();
    if (tab?.id !== grant.tabId || tab.url !== grant.url) throw new Error('The page changed after Send. Send again from its panel.');
    const report = (owned) => {
      const membership = s.memberships.get(grant.tabId);
      membership.manual = Number.isSafeInteger(owned.groupId) && owned.groupId >= 0 && owned.groupId === session.groupId;
      membership.groupId = owned.groupId;
      ops.save();
      ops.report(chat, session, owned);
      if (!current() || s.memberships.get(grant.tabId) !== membership)
        throw new Error('This page left the chat while it was being connected.');
      return { ...owned, membership: membership.id };
    };
    if (s.owner.get(grant.tabId) === chat) {
      const membership = s.memberships.get(grant.tabId);
      if (tab.groupId !== membership.groupId) {
        s.onTabUpdated(tab.id, { groupId: tab.groupId }, tab);
        throw new Error('This tab left its chat’s group. Send again from its panel.');
      }
      return report(tab);
    }
    /** @type {{ title: string, color: string } | null} */
    let originalGroup = null;
    if (Number.isSafeInteger(tab.groupId) && tab.groupId >= 0) {
      try {
        originalGroup = { ...(await s.chrome.tabGroups.get(tab.groupId)) };
      } catch (error) {
        s.log('read the panel tab’s original group', error);
        throw new Error('The page’s tab group changed. Send again from this page.');
      }
    }
    check();
    const move = { groupId: null, effectId: null, expires: grant.expires };
    this.moving.set(tab.id, move);
    const restore = async (groupId) => {
      const untouched = () => offered() || (!s.owner.has(tab.id) && grant.owner && !s.chats.has(grant.owner));
      if (!untouched() || !Number.isSafeInteger(groupId) || groupId < 0) return;
      try {
        const actual = await s.chrome.tabs.get(tab.id);
        if (!untouched() || actual.groupId !== groupId) return;
        if (!originalGroup || (grant.owner && !s.chats.has(grant.owner))) return await s.chrome.tabs.ungroup([tab.id]);
        if (grant.owner) {
          const originalOwner = s.chats.get(grant.owner);
          const restoring = () => offered() && s.chats.get(grant.owner) === originalOwner;
          const restored = await s.groups.put(originalOwner, tab.id, restoring, {
            grouped: (id) => {
              move.groupId = id;
            },
          });
          const final = await s.chrome.tabs.get(tab.id);
          if (restoring() && final.groupId === restored && restored === originalOwner.groupId) {
            grant.membership.groupId = restored;
            ops.save();
            ops.report(grant.owner, originalOwner, final);
          }
          return;
        }
        const alive = await s.chrome.tabGroups.get(tab.groupId).then(
          () => true,
          () => false,
        );
        if (!untouched()) return;
        const mutation = {};
        s.grouping.set(tab.id, mutation);
        let restored;
        try {
          restored = await s.chrome.tabs.group({ tabIds: [tab.id], ...(alive ? { groupId: tab.groupId } : {}) });
          move.groupId = restored;
        } finally {
          if (s.grouping.get(tab.id) === mutation) s.grouping.delete(tab.id);
        }
        if (untouched() && !alive) await s.chrome.tabGroups.update(restored, { title: originalGroup.title, color: originalGroup.color });
      } catch (error) {
        s.log('restore a panel tab after its transfer failed', error);
      }
    };
    let admitted;
    try {
      const groupId = await s.groups.put(session, tab.id, current, {
        grouped: (id) => {
          move.groupId = move.effectId = id;
        },
        // Rollback runs outside the receiving group lane, so crossed transfers cannot deadlock.
        retired: () => undefined,
      });
      if (!current()) throw new Error('The panel page handoff expired or its tab or chat changed. Send again from this page.');
      if (groupId < 0 || groupId !== session.groupId) throw new Error('Chrome could not move the panel tab into this chat.');
      const actual = await s.chrome.tabs.get(tab.id);
      if (!current()) throw new Error('The panel page handoff expired or its tab or chat changed. Send again from this page.');
      if (actual.url !== grant.url || actual.groupId !== groupId)
        throw new Error('The page changed while it was joining this chat. Send again from its panel.');
      if (s.owner.get(tab.id) !== chat) {
        if (grant.owner) ops.release(grant.owner, tab.id, 'transferred_by_panel');
        ops.own(chat, session, tab.id);
      }
      admitted = report(actual);
    } catch (error) {
      await restore(move.effectId);
      throw error;
    } finally {
      // The per-tab admission lane owns this entry until its cleanup completes.
      this.moving.delete(tab.id);
      if (typeof move.effectId === 'number' && move.effectId >= 0) await this.reconcile(tab.id);
    }
    return admitted;
  }

  /** A source-proven popup joins its source chat, under the same membership fences as a created tab. */
  async popup(tab) {
    const { s, ops } = this;
    const chat = s.owner.get(tab?.openerTabId);
    if (!chat || s.owner.has(tab.id)) return;
    const session = s.chats.get(chat);
    const current = ops.own(chat, session, tab.id);
    let groupId;
    try {
      groupId = await s.groups.put(session, tab.id, current);
    } catch (error) {
      s.log('read an adopted popup after grouping failed', error);
      return;
    }
    if (!current()) return;
    s.memberships.get(tab.id).groupId = groupId;
    ops.save();
    ops.report(chat, session, { ...tab, groupId });
  }
}
