// The side panel's sidebar (sidepanel.html #sidebar), laid out like Claude in Chrome's: search, New chat, projects, scheduled tasks, pinned chats and recents (active or archived, by project), each chat with Pin and Open in MoPilot.
//
// Every list is MoPilot's own (electron/app/chromePanel.cjs): the chats its sidebar shows, its saved projects and
// its scheduled tasks. A project picked here filters the chats and is where a new chat goes. Text from MoPilot
// only ever goes in as text.

/** How a chat's turn reads in a list: its dot's tone and, when it waits for the user, a word. */
const TONE = Object.assign(Object.create(null), { running: 'wait', waiting: 'wait', idle: '' });

/** A scheduled task's next time, as the app's Scheduled list says it: "Today 3:02 PM", "Tomorrow 9:00 AM", or the date. */
export function whenOf(/** @type {number | null} */ next, /** @type {Date} */ now = new Date()) {
  if (next == null) return 'Paused';
  const d = new Date(next);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

export class PanelSidebar {
  /**
   * @param {{ document: any, request: (method: string, params?: object) => Promise<any>, onPick: (chat: any) => void,
   *           onNew: (project: { id: string, name: string } | null) => void, onOpen: (chatId: string | null, page?: string) => void,
   *           onSettings: () => void, onError: (text: string) => void }} o
   *   request: one panel request to MoPilot (rejects with the line to show); onPick: a chat opens in the panel
   */
  constructor(o) {
    this.o = o;
    this.doc = o.document;
    /** @type {any[]} */
    this.chats = [];
    /** @type {{ id: string, name: string }[]} */
    this.projects = [];
    /** @type {{ id: string, name: string, next: number | null }[]} */
    this.tasks = [];
    /** @type {{ id: string, name: string } | null} the project the list is filtered to */
    this.project = null;
    this.query = '';
    this.archived = false;
    this.grouped = false;
    const $ = (/** @type {string} */ id) => this.$(id);
    $('side-close').addEventListener('click', () => this.close());
    $('side-new').addEventListener('click', () => {
      this.close();
      this.o.onNew(this.project);
    });
    $('side-all').addEventListener('click', () => this.o.onOpen(null));
    $('side-settings').addEventListener('click', () => this.o.onSettings());
    $('search').addEventListener('input', (/** @type {any} */ e) => {
      this.query = String(e.target.value ?? '');
      this.render();
    });
    $('recents-filter').addEventListener('change', (/** @type {any} */ e) => {
      this.archived = e.target.value === 'archived';
      void this.load();
    });
    $('group').addEventListener('change', (/** @type {any} */ e) => {
      this.grouped = !!e.target.checked;
      this.render();
    });
  }

  $(/** @type {string} */ id) {
    return this.doc.getElementById(id);
  }

  get shown() {
    return !this.$('sidebar').hidden;
  }

  /** Opens the sidebar and reads its lists. */
  open() {
    this.$('sidebar').hidden = false;
    this.$('side').setAttribute('aria-expanded', 'true');
    return this.load();
  }

  close() {
    this.$('sidebar').hidden = true;
    this.$('side').setAttribute('aria-expanded', 'false');
  }

  /** The chats, projects and tasks from MoPilot; one that fails says why in its own list. */
  async load() {
    const line = (/** @type {string} */ id, /** @type {string} */ text) => this.$(id).replaceChildren(this.none(text));
    line('recents', 'Loading…');
    const [chats, projects, tasks] = await Promise.allSettled([
      this.o.request('recent', { limit: 200, archived: this.archived }),
      this.o.request('projects'),
      this.o.request('scheduled'),
    ]);
    this.chats = chats.status === 'fulfilled' ? (chats.value.chats ?? []) : [];
    this.projects = projects.status === 'fulfilled' ? (projects.value.projects ?? []) : [];
    this.tasks = tasks.status === 'fulfilled' ? (tasks.value.tasks ?? []) : [];
    this.render();
    // a refused request rejects with the line to show (sidePanel.mjs request)
    for (const [id, r] of /** @type {const} */ ([
      ['recents', chats],
      ['projects', projects],
      ['tasks', tasks],
    ]))
      if (r.status === 'rejected') line(id, String(r.reason.message));
  }

  none(/** @type {string} */ text) {
    const p = this.doc.createElement('p');
    p.className = 'none';
    p.textContent = text;
    return p;
  }

  /** The chats the search and the project leave, in the list's order. */
  visible() {
    const q = this.query.trim().toLowerCase();
    return this.chats.filter(
      (c) =>
        (!q ||
          String(c.title ?? '')
            .toLowerCase()
            .includes(q)) &&
        (!this.project || c.project === this.project.name),
    );
  }

  render() {
    const doc = this.doc;
    // projects: each filters the chats; the one picked again, or All, clears it
    const projectRow = (/** @type {{ id: string, name: string } | null} */ p) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `row-chat${(this.project?.id ?? null) === (p?.id ?? null) ? ' on' : ''}`;
      const t = doc.createElement('span');
      t.className = 't';
      t.textContent = p ? p.name : 'All chats';
      b.append(t);
      b.addEventListener('click', () => {
        this.project = p && this.project?.id === p.id ? null : p;
        this.render();
      });
      return b;
    };
    this.$('projects').replaceChildren(
      ...(this.projects.length ? [projectRow(null), ...this.projects.map(projectRow)] : [this.none('No projects yet.')]),
    );
    // scheduled tasks: each opens the app's Scheduled page
    this.$('tasks').replaceChildren(
      ...(this.tasks.length
        ? this.tasks.map((task) => {
            const b = doc.createElement('button');
            b.type = 'button';
            b.className = 'row-chat';
            const t = doc.createElement('span');
            t.className = 't';
            t.textContent = String(task.name);
            const s = doc.createElement('small');
            s.textContent = whenOf(task.next);
            b.append(t, s);
            b.addEventListener('click', () => this.o.onOpen(null, 'scheduled'));
            return b;
          })
        : [this.none('No scheduled tasks.')]),
    );
    const list = this.visible();
    // pinned on top, as the app's sidebar has them (not in the archive, not while searching)
    const pinned = this.archived || this.query.trim() ? [] : list.filter((c) => c.pinned);
    this.$('pinned').replaceChildren(...pinned.map((c) => this.row(c)));
    this.$('pinned').hidden = !pinned.length;
    this.$('pinned-head').hidden = !pinned.length;
    const rest = list.filter((c) => !pinned.includes(c));
    if (!rest.length) {
      this.$('recents').replaceChildren(
        this.none(this.query.trim() ? 'No chats match.' : this.archived ? 'No archived chats.' : 'No chats yet.'),
      );
      return;
    }
    if (!this.grouped) {
      this.$('recents').replaceChildren(...rest.map((c) => this.row(c)));
      return;
    }
    // by project, in the order each project's newest chat comes; chats with none last
    /** @type {Map<string, any[]>} */
    const groups = new Map();
    for (const c of rest) {
      const k = c.project ?? '';
      groups.set(k, [...(groups.get(k) ?? []), c]);
    }
    const out = [];
    for (const k of [...groups.keys()].sort((a, b) => Number(a === '') - Number(b === ''))) {
      const h = doc.createElement('p');
      h.className = 'group-head';
      h.textContent = k || 'No project';
      out.push(h, .../** @type {any[]} */ (groups.get(k)).map((c) => this.row(c)));
    }
    this.$('recents').replaceChildren(...out);
  }

  /** One chat: opens in the panel; its ⋯ has Pin (or Unpin) and Open in MoPilot. */
  row(/** @type {any} */ c) {
    const doc = this.doc;
    const wrap = doc.createElement('div');
    wrap.className = 'row';
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'row-chat';
    const dot = doc.createElement('span');
    dot.className = `dot ${TONE[c.state] ?? ''}`;
    const t = doc.createElement('span');
    t.className = 't';
    t.textContent = String(c.title ?? 'New chat');
    b.append(dot, t);
    if (c.state === 'waiting') {
      const s = doc.createElement('small');
      s.textContent = 'Waiting';
      b.append(s);
    }
    b.addEventListener('click', () => {
      this.close();
      this.o.onPick(c);
    });
    const more = doc.createElement('button');
    more.type = 'button';
    more.className = 'row-more';
    more.textContent = '⋯';
    more.setAttribute('aria-label', `More options for ${String(c.title ?? 'New chat')}`);
    /** @type {any} the open menu, while it shows */
    let menu = null;
    more.addEventListener('click', () => {
      if (menu) {
        menu.remove();
        menu = null;
        return;
      }
      menu = doc.createElement('div');
      menu.className = 'row-menu';
      menu.setAttribute('role', 'menu');
      const item = (/** @type {string} */ label, /** @type {() => void} */ act) => {
        const i = doc.createElement('button');
        i.type = 'button';
        i.setAttribute('role', 'menuitem');
        i.textContent = label;
        i.addEventListener('click', act);
        return i;
      };
      menu.append(
        item(c.pinned ? 'Unpin' : 'Pin', () => void this.pin(c, !c.pinned)),
        item('Open in MoPilot', () => this.o.onOpen(String(c.id))),
      );
      wrap.append(menu);
    });
    wrap.append(b, more);
    return wrap;
  }

  /** Pins or unpins the chat in MoPilot (its sidebar too), then shows the lists as they are now. */
  async pin(/** @type {any} */ c, /** @type {boolean} */ pinned) {
    try {
      await this.o.request('pin', { chatId: String(c.id), pinned });
      c.pinned = pinned;
    } catch (e) {
      this.o.onError(String(/** @type {Error} */ (e).message));
    }
    this.render();
  }
}
