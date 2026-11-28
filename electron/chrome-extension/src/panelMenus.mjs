// The side panel's model and permission menus (sidePanel.mjs). The model menu is laid out like the app's composer picker (src/components/harnessPicker/FirstTierPicker.tsx): it opens on the effort, under a row naming the harness and model that leads to the harness list with the models (More models for older versions); and a permission menu with each row's one-line difference. A pick goes to MoPilot, which applies it as the app's composer does (electron/app/chromePanelOptions.cjs); a chat's harness picked moves the chat there with its next message, as the app's picker does.
import { trackMenuSpace } from './panelMenuLayout.mjs';

/**
 * @typedef {{ id: string, label: string }} Effort
 * @typedef {{ id: string, label: string, description: string | null, efforts: Effort[], defaultEffort: string | null, more: boolean }} Model
 * @typedef {{ id: string, label: string, detail: string, disabled?: string }} Permission
 * @typedef {{ models: Model[], model: string | null, effort: string | null, harness: string | null, automatic?: boolean, recommendedModel?: string | null, nativeModel?: boolean,
 *   harnessId?: string, switching?: boolean, permission: { title: string, value: string | null, rows: Permission[] } | null }} Options
 */

export class PanelMenus {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {(text: string) => void} o.onError the panel's error line
   * @param {(harness: string) => void} o.onHarness the next new chat's harness picked
   * @param {() => void} [o.onModelMenu] the model menu was opened: the harnesses it lists are asked again
   */
  constructor(o) {
    this.o = o;
    trackMenuSpace(o.document);
    /** @type {{ harness?: string, chatId?: string } | null} the chat the menus are for, or the next new chat's harness */
    this.target = null;
    /** @type {Options | null} */
    this.now = null;
    this.more = false;
    /** the model menu's level: the effort ('effort') or the harnesses and models ('list'); it opens on the effort */
    this.view = 'effort';
    this.confirmFull = false;
    /** the latest load: an older answer never replaces it */
    this.seq = 0;
    this.observed = null;
    /** @type {{ id: string, label: string }[]} the harnesses a chat can run on now */
    this.harnesses = [];
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    $('model').addEventListener('click', () => this.toggle('model-menu'));
    $('perm').addEventListener('click', () => this.toggle('perm-menu'));
  }

  /** The harnesses the menu offers. */
  setHarnesses(/** @type {{ id: string, label: string }[]} */ list) {
    // the list is asked again each time the menu opens, and the answer is usually the same: the rows are not drawn again then, so a press that began on one is not lost to a row that was replaced under it
    const same =
      list.length === this.harnesses.length && list.every((h, i) => h.id === this.harnesses[i].id && h.label === this.harnesses[i].label);
    this.harnesses = list;
    if (!same) this.render();
  }

  /** The model and effort a message goes with: what the menu shows (none before it has loaded). */
  get pick() {
    if (this.target?.chatId || this.now?.nativeModel) return {};
    return this.now?.model
      ? { model: this.now.automatic ? null : this.now.model, ...(this.now.effort ? { effort: this.now.effort } : {}) }
      : {};
  }

  /** Current metadata invalidates menu snapshots; sending text itself never writes the snapshot back to the chat. */
  observe(chatId, state) {
    if (this.target?.chatId !== chatId || typeof state?.harness !== 'string') return;
    const key = JSON.stringify([state.menuOwner ?? null, state.harness, state.account ?? null, state.model ?? null]);
    if (key === this.observed) return;
    this.observed = key;
    return this.load({ chatId });
  }

  /** Reads the menus for a chat or a new chat's harness. */
  async load(/** @type {{ harness?: string, chatId?: string }} */ target) {
    const seq = ++this.seq;
    if (this.target?.chatId !== target.chatId || this.target?.harness !== target.harness) this.observed = null;
    this.target = target;
    this.confirmFull = false;
    this.close();
    this.now = null;
    this.render();
    try {
      const now = await this.o.request('options', target);
      if (seq !== this.seq) return;
      this.now = now;
    } catch (e) {
      if (seq === this.seq) this.o.onError(String(/** @type {Error} */ (e).message));
    }
    this.render();
  }

  /** Closes both, and the + menu (one menu open at a time). */
  close() {
    this.confirmFull = false;
    this.$('model-menu').hidden = true;
    this.$('perm-menu').hidden = true;
    this.$('plus-menu').hidden = true;
  }

  toggle(/** @type {string} */ id) {
    const open = this.$(id).hidden;
    this.close();
    this.$(id).hidden = !open;
    if (open && id === 'model-menu') this.view = 'effort';
    if (open) this.render();
    // a harness still starting (or failing its check once) when the panel loaded may be ready now
    if (open && id === 'model-menu') this.o.onModelMenu?.();
  }

  /** The two buttons, and the menus' rows as they are now. */
  render() {
    const { document } = this.o;
    const $ = this.$;
    const now = this.now;
    const models = now?.models ?? [];
    const model = models.find((m) => m.id === now?.model) ?? null;
    const effort = model?.efforts.find((e) => e.id === now?.effort) ?? null;
    $('model').hidden = !this.target;
    $('model').textContent = model ? `${model.label}${effort ? ` ${effort.label}` : ''}` : (now?.harness ?? 'Choose model');
    const perm = now?.permission ?? null;
    $('perm').hidden = !now;
    $('perm').disabled = !perm;
    // a harness without modes decides by itself what it may do
    $('perm').textContent = perm
      ? (perm.rows.find((r) => r.id === perm.value)?.label ?? perm.title)
      : `Set by ${now?.harness ?? 'the harness'}`;

    const item = (
      /** @type {string} */ label,
      /** @type {string} */ detail,
      /** @type {boolean} */ on,
      /** @type {() => void} */ pick,
      disabled = '',
    ) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `menu-item${on ? ' on' : ''}`;
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(on));
      const name = document.createElement('span');
      name.textContent = label;
      b.append(name);
      if (detail || disabled) {
        const small = document.createElement('small');
        small.textContent = disabled || detail;
        b.append(small);
      }
      b.disabled = !!disabled;
      b.addEventListener('click', pick);
      return b;
    };
    const head = (/** @type {string} */ text) => {
      const h = document.createElement('h4');
      h.textContent = text;
      return h;
    };

    const main = models.filter((m) => !m.more);
    const more = models.filter((m) => m.more);
    const harness = now?.harnessId ?? this.target?.harness;
    const harnessLabel = this.harnesses.find((h) => h.id === harness)?.label ?? now?.harness ?? '';
    /** a row that moves between the menu's two levels */
    const nav = (/** @type {string} */ cls, /** @type {string} */ label, /** @type {() => void} */ go, text = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `menu-item ${cls}`;
      b.setAttribute('aria-label', label);
      if (text) b.textContent = text;
      b.addEventListener('click', () => {
        go();
        this.render();
      });
      return b;
    };
    const span = (/** @type {string} */ cls, /** @type {string} */ text) => {
      const x = document.createElement('span');
      x.className = cls;
      x.textContent = text;
      return x;
    };
    const rows = [];
    if (this.view === 'effort') {
      // the effort, under the harness and model it is for: that row leads to the list
      const title = nav('effort-title', 'Select harness and model', () => (this.view = 'list'));
      title.append(
        span('effort-name', effort?.label ?? 'Default'),
        span('effort-model', [harnessLabel, model?.label].filter(Boolean).join(' · ') || 'Choose model'),
      );
      rows.push(title);
      if (model?.efforts.length)
        rows.push(
          head('Effort'),
          ...model.efforts.map((e) =>
            item(e.label, '', e.id === now?.effort, () => void this.choose(now?.automatic ? '' : model.id, e.id, true)),
          ),
        );
      else rows.push(span('hp-note', model ? 'This model has no effort levels' : ''));
    } else {
      rows.push(nav('hp-back', 'Back to effort', () => (this.view = 'effort'), '‹ Harness'));
      // one harness is no choice; the one a waiting switch goes to says when it applies
      if (this.harnesses.length > 1)
        rows.push(
          ...this.harnesses.map((h) =>
            item(
              h.label,
              h.id === harness && now?.switching ? 'From your next message' : '',
              h.id === harness,
              () => void this.harness(h.id),
            ),
          ),
        );
      // a model's description is its tooltip, as in the app's list
      const modelRow = (/** @type {Model} */ m) => {
        const b = item(m.label, '', now?.automatic ? m.id === '' : m.id === now?.model, () => void this.choose(m.id));
        if (m.description) b.title = m.description;
        return b;
      };
      const recommended = models.find((m) => m.id === now?.recommendedModel);
      rows.push(
        head('Models'),
        ...(recommended ? [modelRow({ ...recommended, id: '', label: 'Default (recommended)', description: null })] : []),
        ...main.map(modelRow),
      );
      if (more.length) {
        const t = document.createElement('button');
        t.type = 'button';
        t.className = 'menu-item more';
        t.textContent = this.more ? 'Fewer models' : 'More models';
        t.setAttribute('aria-expanded', String(this.more));
        t.addEventListener('click', () => {
          this.more = !this.more;
          this.render();
        });
        rows.push(t);
        if (this.more) rows.push(...more.map(modelRow));
      }
    }
    $('model-rows').replaceChildren(...rows);
    $('perm-menu').replaceChildren(
      ...(perm
        ? [
            head(perm.title),
            ...perm.rows.map((r) => item(r.label, r.detail, r.id === perm.value, () => void this.permit(r.id), r.disabled)),
            ...(this.confirmFull
              ? [
                  head('Full access can edit files, run commands and act on websites without approval.'),
                  item('Enable Full access', 'Only continue if you trust this task.', false, () => void this.permit('full-access', true)),
                ]
              : []),
          ]
        : []),
    );
  }

  /** A model (and effort) picked: the effort stays when the new model has it, else the model's own default. */
  async choose(/** @type {string} */ modelId, effortId = '', effortOnly = false) {
    const now = this.now;
    // a menu that loaded has its target
    const target = /** @type {{ harness?: string, chatId?: string }} */ (this.target);
    if (!now) return;
    // only a model the menu lists
    const model = now.models.find((m) => m.id === (modelId || now.recommendedModel));
    if (!model) return;
    const keep = model.efforts.some((e) => e.id === now.effort) ? now.effort : model.defaultEffort;
    const effort = effortId || keep;
    this.close();
    try {
      // Native ACP owns an unselected model; changing its effort must not create a model default to replay later.
      const choice = effortOnly && now.nativeModel ? null : modelId || null;
      await this.o.request('choose', { ...target, model: choice, effort });
      // the menu shows the pick once MoPilot has it
      if (this.target === target && this.now === now) this.now = { ...now, model: model.id, automatic: !modelId, effort };
    } catch (e) {
      if (this.target === target && this.now === now) this.o.onError(String(/** @type {Error} */ (e).message));
    }
    this.render();
  }

  /** A harness picked: the next new chat's, or the one the open chat's next message moves it to (its own: no switch). */
  async harness(/** @type {string} */ id) {
    const target = this.target;
    this.close();
    if (!target?.chatId) {
      this.o.onHarness(id);
      return;
    }
    try {
      await this.o.request('switch', { chatId: target.chatId, harness: id });
    } catch (e) {
      if (this.target === target) this.o.onError(String(/** @type {Error} */ (e).message));
      return;
    }
    // the menus now follow the harness the next message goes to
    if (this.target === target) await this.load(target);
  }

  async permit(/** @type {string} */ value, confirmed = false) {
    const now = this.now;
    const target = /** @type {{ harness?: string, chatId?: string }} */ (this.target);
    if (!now?.permission) return;
    if (confirmed && !this.confirmFull) return;
    if (value === 'full-access' && now.permission.value !== value && !confirmed) {
      this.confirmFull = true;
      this.$('perm-menu').hidden = false;
      this.render();
      return;
    }
    this.confirmFull = false;
    this.close();
    try {
      await this.o.request('permit', { ...target, value });
      if (this.target === target && this.now === now && now.permission) this.now = { ...now, permission: { ...now.permission, value } };
    } catch (e) {
      if (this.target === target && this.now === now) this.o.onError(String(/** @type {Error} */ (e).message));
    }
    this.render();
  }
}
