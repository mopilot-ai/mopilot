// Stateful side-panel approvals: entry fields survive transcript refreshes, live request versions fence answers, and irreversible actions require the app's one-second hold.
import { markdown } from './panelMarkdown.mjs';
import { parseAcpNumber } from './panelNumbers.mjs';

export const HOLD_MS = 1000;
/** A plan taller than this many lines folds under "Show more". */
export const PLAN_LINES = 12;
/** What a choice's `shortcut` shows on its button. */
const KEY_HINT = { enter: '↵', escape: 'Esc', 'mod-enter': '⌘↵' };
/** The shortcut a key press is: Enter, Cmd/Ctrl+Enter or Escape on their own, else none (an input method's keys are its own). */
const shortcutOf = (event) => {
  if (event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey) return null;
  if (event.key === 'Enter') return event.metaKey || event.ctrlKey ? 'mod-enter' : 'enter';
  return event.key === 'Escape' && !event.metaKey && !event.ctrlKey ? 'escape' : null;
};
const inputs = (el) =>
  [...el.children].flatMap((child) =>
    ['input', 'select', 'textarea'].includes(String(child.tagName).toLowerCase()) ? [child] : inputs(child),
  );
const record = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export class PanelCards {
  constructor(o) {
    this.o = o;
    this.doc = o.document;
    this.timers = o.timers ?? globalThis;
    this.entries = new Map();
    this.chat = null;
  }
  element(tag, text = '') {
    const e = this.doc.createElement(tag);
    e.textContent = text;
    return e;
  }
  render(chat, cards) {
    if (this.chat !== chat) {
      for (const e of this.entries.values()) e.dispose();
      this.entries.clear();
    }
    this.chat = chat;
    const next = new Map();
    const nodes = cards.map((c) => {
      const key = JSON.stringify([c.id, c.version, c]);
      let entry = this.entries.get(key);
      if (!entry) {
        const form = JSON.stringify([c.questions, c.schema, c.apps, c.levels, c.level]);
        const prior = [...this.entries.values()].find((e) => e.id === c.id && e.version === c.version && e.form === form);
        entry = this.build(chat, c, key, prior?.snapshot());
      }
      next.set(key, entry);
      return entry.el;
    });
    for (const [key, entry] of this.entries) if (!next.has(key)) entry.dispose();
    this.entries = next;
    nodes.forEach((node, i) => {
      if (this.o.container.children[i] !== node) this.o.container.insertBefore(node, this.o.container.children[i] ?? null);
    });
    while (this.o.container.children.length > nodes.length) this.o.container.removeChild(this.o.container.lastChild);
  }
  build(chat, c, key, saved = []) {
    const el = this.element('section');
    el.className = 'card';
    const stops = [];
    if (c.heading) {
      const heading = this.element('div', String(c.heading));
      heading.className = 'kicker';
      el.append(heading);
    }
    const q = this.element('div', String(c.title ?? ''));
    q.className = 'q';
    el.append(q);
    if (record(c.plan)) el.append(...this.plan(c.plan, stops));
    if (c.detail) el.append(this.element('pre', String(c.detail)));
    const fields = [];
    const values = () => Object.fromEntries(fields.map((f) => [f.key, f.read()]).filter(([, v]) => v !== undefined));
    const entry = {
      el,
      id: c.id,
      version: c.version,
      form: JSON.stringify([c.questions, c.schema, c.apps, c.levels, c.level]),
      snapshot: () => inputs(el).map((i) => ({ value: i.value, checked: i.checked })),
      pending: false,
      active: true,
      dispose: () => {
        entry.active = false;
        for (const stop of stops) stop();
      },
    };
    const current = () => !c.disabled && entry.active && this.chat === chat && this.entries.get(key) === entry;
    const offered = () => this.chat === chat && [...this.entries.values()].some((e) => e.id === c.id && e.version === c.version);
    if (c.questions)
      for (const question of c.questions) {
        const box = this.element('fieldset');
        box.append(this.element('legend', question.question || question.header || 'Answer'));
        const controls = (question.options ?? []).map((option) => {
          const label = this.element('label', option.label);
          const input = this.element('input');
          input.type = question.multiSelect ? 'checkbox' : 'radio';
          input.name = `question:${c.id}:${question.id}`;
          input.value = option.label;
          label.prepend(input);
          box.append(label);
          if (option.description) label.append(this.element('small', option.description));
          return input;
        });
        const other = this.element('input');
        other.type = question.isSecret ? 'password' : 'text';
        other.placeholder = controls.length ? 'Other answer' : 'Your answer';
        if (!controls.length || question.isOther) box.append(other);
        fields.push({
          key: question.id,
          read: () => {
            const selected = controls.filter((i) => i.checked).map((i) => i.value);
            return other.value ? (question.multiSelect ? [...selected, other.value] : [other.value]) : selected;
          },
        });
        el.append(box);
      }
    if (c.schema) {
      const props = record(c.schema.properties) ? c.schema.properties : {};
      for (const [name, schema] of Object.entries(props)) {
        const label = this.element('label', schema.title || name);
        const input = this.field(schema, Array.isArray(c.schema.required) && c.schema.required.includes(name));
        label.append(input.el);
        el.append(label);
        fields.push({ key: name, read: input.read });
      }
    }
    if (c.url) {
      const link = this.element('a', `Open ${c.url}`);
      if (/^https?:\/\//.test(c.url)) {
        link.href = c.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      el.append(link);
    }
    if (c.apps?.length) {
      const apps = c.apps.map((a) => {
        const label = this.element('label', a.name);
        const input = this.element('input');
        input.type = 'checkbox';
        input.checked = true;
        label.prepend(input);
        el.append(label);
        return { input, id: a.bundleId };
      });
      fields.push({ key: 'apps', read: () => apps.filter((a) => a.input.checked).map((a) => a.id) });
    }
    if (c.levels?.length) {
      const select = this.element('select');
      select.setAttribute('aria-label', 'Access level');
      for (const level of c.levels) {
        const option = this.element('option', level.label);
        option.value = level.id;
        select.append(option);
      }
      select.value = c.level;
      el.append(select);
      fields.push({ key: 'level', read: () => select.value });
    }
    const row = this.element('div');
    row.className = 'choices';
    el.append(row);
    const buttons = [];
    /** @type {Map<string, any>} the choices a key answers, by shortcut */
    const shortcuts = new Map();
    const answer = async (choice) => {
      if (!current() || entry.pending) return;
      let content;
      try {
        content = ['deny', 'decline', 'cancel', 'skip'].includes(choice.key) ? undefined : values();
      } catch (error) {
        this.o.onError(error.message);
        return;
      }
      this.o.onError('');
      entry.pending = true;
      for (const b of buttons) b.disabled = true;
      try {
        await this.o.request('answer', {
          chatId: chat,
          approvalId: c.id,
          choice: choice.key,
          ...(c.version ? { version: c.version } : {}),
          ...(content !== undefined && (fields.length || c.schema || c.questions) ? { values: content } : {}),
        });
        if (offered()) await this.o.onAnswered();
      } catch (error) {
        if (offered()) {
          entry.pending = false;
          for (const b of buttons) b.disabled = false;
          this.o.onError(error.message);
          await this.o.onAnswered();
        }
      }
    };
    if (c.inApp) {
      const b = this.element('button', 'Answer in MoPilot');
      b.type = 'button';
      b.addEventListener('click', () => current() && this.o.onOpen(chat));
      row.append(b);
    }
    for (const [i, choice] of (Array.isArray(c.choices) ? c.choices : []).entries()) {
      const b = this.element('button', choice.label);
      b.type = 'button';
      b.dataset.choice = choice.key;
      b.disabled = !!c.disabled;
      b.className = i === 0 && !choice.deny ? 'primary' : '';
      if (KEY_HINT[choice.shortcut]) {
        const hint = this.element('kbd', KEY_HINT[choice.shortcut]);
        hint.setAttribute('aria-hidden', 'true');
        b.append(hint);
        b.setAttribute('aria-keyshortcuts', choice.shortcut === 'escape' ? 'Escape' : choice.shortcut === 'enter' ? 'Enter' : 'Meta+Enter');
        shortcuts.set(choice.shortcut, choice);
      }
      buttons.push(b);
      row.append(b);
      let confirmed = !choice.confirm;
      if (choice.hold) {
        let timer = null;
        const cancel = () => {
          this.timers.clearTimeout(timer);
          timer = null;
          b.classList.remove('holding');
        };
        const start = (event) => {
          if (!event.isTrusted || !current() || entry.pending || timer !== null) return;
          if (
            event.type === 'keydown' &&
            (event.repeat || event.isComposing || event.keyCode === 229 || !(event.key === 'Enter' && event.metaKey))
          )
            return;
          if (event.type === 'pointerdown' && event.button !== 0) return;
          event.preventDefault();
          b.classList.add('holding');
          timer = this.timers.setTimeout(() => {
            cancel();
            void answer(choice);
          }, HOLD_MS);
        };
        b.title = 'Hold the button or ⌘↩ to allow';
        b.addEventListener('pointerdown', start);
        b.addEventListener('keydown', start);
        for (const event of ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur']) b.addEventListener(event, cancel);
        const view = this.doc.defaultView ?? this.timers;
        const chord = (event) => {
          if (this.o.container.firstElementChild !== el) return;
          const focused = this.doc.activeElement;
          if (focused !== b && focused?.closest?.('input, textarea, select, button')) return;
          start(event);
        };
        view.addEventListener?.('keydown', chord);
        const hide = () => {
          if (this.doc.hidden) cancel();
        };
        view.addEventListener?.('blur', cancel);
        this.doc.addEventListener?.('pointerup', cancel);
        this.doc.addEventListener?.('keyup', cancel);
        this.doc.addEventListener?.('visibilitychange', hide);
        stops.push(() => {
          cancel();
          view.removeEventListener?.('blur', cancel);
          view.removeEventListener?.('keydown', chord);
          this.doc.removeEventListener?.('pointerup', cancel);
          this.doc.removeEventListener?.('keyup', cancel);
          this.doc.removeEventListener?.('visibilitychange', hide);
        });
      } else
        b.addEventListener('click', (event) => {
          if (!event.isTrusted || !current()) return;
          if (!confirmed) {
            confirmed = true;
            q.textContent = choice.confirm;
            b.textContent = 'Confirm permission';
            return;
          }
          if (choice.confirm) {
            confirmed = false;
            b.textContent = choice.label;
            q.textContent = String(c.title ?? '');
          }
          void answer(choice);
        });
    }
    if (shortcuts.size) {
      const view = this.doc.defaultView ?? this.timers;
      const press = (event) => {
        const choice = shortcuts.get(shortcutOf(event) ?? '');
        if (!choice || !event.isTrusted || event.defaultPrevented || event.repeat) return;
        if (!current() || entry.pending || this.o.container.firstElementChild !== el || !this.keysFree(el)) return;
        event.preventDefault();
        event.stopPropagation();
        void answer(choice);
      };
      // capture: the message box would take Enter first, and an empty one has nothing to send
      view.addEventListener?.('keydown', press, true);
      stops.push(() => view.removeEventListener?.('keydown', press, true));
    }
    if (c.note) {
      const note = this.element('small', String(c.note));
      note.className = 'note';
      el.append(note);
    }
    inputs(el).forEach((input, i) => {
      if (saved[i]) {
        input.value = saved[i].value;
        input.checked = saved[i].checked;
      }
      input.disabled = !!c.disabled;
    });
    return entry;
  }
  /**
   * Whether the keys are the card's: no menu is open, and the focus is nowhere or in an empty message box, never on a
   * control of its own (a button takes Enter itself) or in text being typed.
   */
  keysFree(el) {
    if (this.doc.querySelector?.('.menu:not([hidden]), .header-menu:not([hidden])')) return false;
    const focused = this.doc.activeElement;
    if (!focused || focused === this.doc.body) return true;
    if (el.contains?.(focused)) return false;
    return ['textarea', 'input'].includes(String(focused.tagName).toLowerCase()) && !focused.value;
  }
  /**
   * An ExitPlanMode request's plan as nodes: its Markdown, folded under "Show more" past PLAN_LINES lines (the box is
   * measured as it is shown and as the panel resizes, since the lines wrap), its file's name, and a note when the text was clipped.
   */
  plan(plan, stops) {
    const text = typeof plan.text === 'string' ? plan.text : '';
    if (!text) return [];
    const box = this.element('div');
    box.className = 'plan-box';
    const body = this.element('div');
    body.className = 'plan';
    body.tabIndex = 0;
    body.setAttribute('role', 'region');
    body.setAttribute('aria-label', 'Plan');
    body.append(...markdown(this.doc, text));
    box.append(body);
    const more = this.element('button', 'Show more');
    more.type = 'button';
    more.className = 'plan-more';
    more.setAttribute('aria-expanded', 'false');
    // a long text folds from the start; once shown, the lines that fit decide
    more.hidden = text.split('\n').length <= PLAN_LINES;
    let open = false;
    more.addEventListener('click', () => {
      open = !open;
      body.classList.toggle('open', open);
      more.textContent = open ? 'Show less' : 'Show more';
      more.setAttribute('aria-expanded', String(open));
      if (!open) measure();
    });
    const measure = () => {
      if (!open) more.hidden = !(body.scrollHeight > body.clientHeight + 1);
    };
    const Observer = (this.doc.defaultView ?? globalThis).ResizeObserver;
    if (Observer) {
      const observer = new Observer(measure);
      observer.observe(body);
      stops.push(() => observer.disconnect());
    }
    box.append(more);
    const notes = [];
    if (plan.file) notes.push(`Saved as ${plan.file}`);
    if (plan.clipped) notes.push('Only the start of the plan is shown here.');
    if (notes.length) {
      const small = this.element('small', notes.join('. '));
      small.className = 'plan-file';
      box.append(small);
    }
    return [box];
  }
  field(schema, required = true) {
    if (schema.type === 'array' && Array.isArray(schema.items?.enum)) {
      const box = this.element('div');
      const checks = schema.items.enum.map((value, i) => {
        const label = this.element('label', String(schema.items.enumLabels?.[i] ?? value));
        const input = this.element('input');
        input.type = 'checkbox';
        input.checked = Array.isArray(schema.default) && schema.default.includes(value);
        label.prepend(input);
        box.append(label);
        return { input, value };
      });
      return {
        el: box,
        read: () => {
          const selected = checks.filter((c) => c.input.checked).map((c) => c.value);
          return required || selected.length || Object.hasOwn(schema, 'default') ? selected : undefined;
        },
      };
    }
    const enumeration = Array.isArray(schema.enum) ? schema.enum : null;
    const complex = schema.type === 'object' || schema.type === 'array';
    const input = this.element(enumeration ? 'select' : complex ? 'textarea' : 'input');
    if (enumeration) {
      input.append(this.element('option', 'Choose…'));
      enumeration.forEach((v, i) => {
        const option = this.element('option', String(schema.enumLabels?.[i] ?? v));
        option.value = String(i);
        input.append(option);
      });
      input.value = '';
    } else
      input.type =
        schema.type === 'boolean'
          ? 'checkbox'
          : ['number', 'integer'].includes(schema.type)
            ? 'number'
            : schema.writeOnly || schema.format === 'password'
              ? 'password'
              : 'text';
    if (Object.hasOwn(schema, 'default')) {
      if (schema.type === 'boolean') input.checked = schema.default;
      else
        input.value = enumeration
          ? String(enumeration.findIndex((v) => JSON.stringify(v) === JSON.stringify(schema.default)))
          : complex
            ? JSON.stringify(schema.default)
            : String(schema.default);
    }
    return {
      el: input,
      read: () => {
        if (enumeration) return input.value === '' ? undefined : enumeration[Number(input.value)];
        if (schema.type === 'boolean') return !!input.checked;
        if (input.value === '') return undefined;
        if (complex) {
          try {
            return JSON.parse(input.value);
          } catch {
            throw new Error('Enter valid JSON for this field.');
          }
        }
        return ['number', 'integer'].includes(schema.type) ? parseAcpNumber(input.value) : input.value;
      },
    };
  }
}
