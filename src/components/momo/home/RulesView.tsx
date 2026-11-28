// MoMo's Rules and the brief's settings as the design draws them (MacRules, W5.5–W5.7, W3.1): learned, yours and built-in rules with their effect, a detail with the reactions that made it, edit, add, and empty.
import { useState } from 'react';
import type { MomoRuleEffect, MomoRuleSignalView, MomoRuleView, MomoSettingsView } from '../../../../shared/momoView';
import { shortDay } from './homeCopy';
import { Refusal } from './Refusal';
import { SettingsRows } from './SettingsRows';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

const EFFECT: Record<MomoRuleEffect, string> = {
  tell_now: 'Tell now',
  stay_quiet: 'Stay quiet',
  ask_first: 'Ask first',
  dont_ask: 'Don’t ask',
};
const EFFECTS = Object.keys(EFFECT) as MomoRuleEffect[];
/** What a rule that is not on says of itself; a state this version does not know says nothing rather than guessing. `saved` is the owner's own words, kept and not read yet. */
const STATE_CHIP: Record<string, string> = { suggested: 'Suggested', off: 'Off', undone: 'Undone', saved: 'Saved. Not applied yet' };

function sourceLine(r: MomoRuleView): string {
  if (r.origin === 'built-in') return 'Built in · cannot be turned off';
  const e = r.evidence[0];
  if (r.origin === 'yours') return 'You added this';
  return e
    ? `${shortDay(e.at)} · ${e.reaction === 'You said' ? `you said “${e.item}”` : `you answered “${e.reaction}” ${r.evidence.length === 1 ? 'once' : 'twice'}`}`
    : 'Learned from you';
}

function Form({ initial, onDone, label }: { initial: MomoRuleView | null; onDone: () => void; label: string }) {
  const { act, busy, failed } = useMomoAct();
  const [text, setText] = useState(initial?.text ?? '');
  const [effect, setEffect] = useState<MomoRuleEffect>(initial?.effect ?? 'tell_now');
  const [inBrief, setInBrief] = useState(initial?.inBrief ?? false);
  const save = () =>
    act(
      initial ? { type: 'rule.edit', id: initial.id, text: text.trim(), effect, inBrief } : { type: 'rule.add', text: text.trim(), effect },
    ).then((r) => r.ok && onDone());
  return (
    <form
      className={styles.card}
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3 className={styles.h1}>{label}</h3>
      <Refusal failed={failed} />
      <label>
        <span className={styles.meta}>When</span>
        <input ref={(el) => el?.focus()} className={styles.field} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        <span className={styles.meta}>Then</span>
        <select className={styles.field} value={effect} onChange={(e) => setEffect(e.target.value as MomoRuleEffect)}>
          {EFFECTS.map((x) => (
            <option key={x} value={x}>
              {EFFECT[x]}
            </option>
          ))}
        </select>
      </label>
      {initial ? (
        <label>
          <input type="checkbox" checked={inBrief} onChange={(e) => setInBrief(e.target.checked)} /> Still show in the morning brief
        </label>
      ) : null}
      <p className={styles.meta}>A rule that tells you more, or skips a question, needs your tap.</p>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy || !text.trim()}>
          Save
        </button>
        <button type="button" className={styles.btn} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function Detail({ r, onEdit }: { r: MomoRuleView; onEdit: () => void }) {
  const { act, busy, failed } = useMomoAct();
  const builtIn = r.origin === 'built-in';
  return (
    <section className={styles.card} aria-label={r.text}>
      <h3 className={styles.h1}>{r.text}</h3>
      <Refusal failed={failed} />
      <span className={styles.meta}>
        {r.origin === 'learned' ? 'Learned' : r.origin === 'yours' ? 'Yours' : 'Built in'} · {EFFECT[r.effect]}
      </span>
      <dl style={{ margin: 0 }}>
        <dt className={styles.meta}>Applies to</dt>
        <dd style={{ margin: 0 }}>{r.appliesTo}</dd>
      </dl>
      {r.evidence.length ? (
        <>
          <span className={styles.meta}>Why it exists</span>
          <ul className={styles.list} data-testid="momo-rule-evidence">
            {r.evidence.map((e) => (
              <li key={`${e.at}-${e.item}`}>
                {shortDay(e.at)} · {e.reaction}: {e.item}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {r.useCount ? <span className={styles.meta}>Used {r.useCount} times since</span> : null}
      {builtIn ? (
        <p className={styles.meta}>Built in. Cannot be turned off.</p>
      ) : (
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={onEdit}>
            Edit
          </button>
          {r.state === 'suggested' || r.state === 'off' || r.state === 'undone' ? (
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              // a suggestion is accepted; a rule turned off or undone is turned back on (the home's accept takes only a suggestion)
              onClick={() => void act({ type: r.state === 'suggested' ? 'rule.accept' : 'rule.turnOn', id: r.id })}
            >
              Turn on
            </button>
          ) : (
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'rule.turnOff', id: r.id })}>
              Turn off
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Section({
  title,
  rules,
  onOpen,
  openId,
  onEdit,
}: {
  title: string;
  rules: MomoRuleView[];
  onOpen: (id: string) => void;
  openId: string | null;
  onEdit: (id: string) => void;
}) {
  if (!rules.length) return null;
  return (
    <section aria-label={title}>
      <h2 className={styles.h2}>{title}</h2>
      <ul className={styles.list}>
        {rules.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={styles.row}
              data-rule={r.id}
              data-testid={`momo-rule-${r.id}`}
              aria-expanded={openId === r.id}
              onClick={() => onOpen(r.id)}
            >
              <span className={styles.rowMain}>
                <span>{r.text}</span>
                <span className={styles.meta}>{sourceLine(r)}</span>
              </span>
              <span className={styles.chip}>{r.state === 'on' ? EFFECT[r.effect] : (STATE_CHIP[r.state] ?? '')}</span>
            </button>
            {openId === r.id ? <Detail r={r} onEdit={() => onEdit(r.id)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RulesView({
  rules,
  signals,
  settings,
}: {
  rules: MomoRuleView[];
  signals: MomoRuleSignalView[];
  settings: MomoSettingsView;
}) {
  const { act, busy, failed } = useMomoAct();
  const [openId, setOpenId] = useState<string | null>(null);
  const [form, setForm] = useState<'add' | string | null>(null);
  const edited = rules.find((r) => r.id === form) ?? null;
  const by = (o: MomoRuleView['origin']) => rules.filter((r) => r.origin === o);
  return (
    <div className={styles.body}>
      <div className={styles.column}>
        <h1 className={styles.h1}>Rules</h1>
        <p className={styles.meta}>What MoMo brings you, what it leaves, and what it may do without asking.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.btn} onClick={() => setForm('add')}>
            Add a rule
          </button>
        </div>
        {form === 'add' ? <Form initial={null} label="Add a rule" onDone={() => setForm(null)} /> : null}
        {edited ? <Form key={edited.id} initial={edited} label="Edit rule" onDone={() => setForm(null)} /> : null}
        {rules.length === 0 ? (
          <>
            <h2 className={styles.h1}>No rules yet.</h2>
            <p className={styles.text}>When you answer the same way twice, MoMo suggests a rule here. You can also add your own.</p>
          </>
        ) : null}
        <Refusal failed={failed} />
        {signals.map((s) => (
          <div key={s.id} className={styles.card}>
            <span>Watching: {s.text}</span>
            <div className={styles.actions}>
              <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'signal.make', id: s.id })}>
                Make it a rule
              </button>
              <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'signal.ignore', id: s.id })}>
                Ignore
              </button>
            </div>
          </div>
        ))}
        {(['learned', 'yours', 'built-in'] as const).map((o) => (
          <Section
            key={o}
            title={{ learned: 'Learned from you', yours: 'Yours', 'built-in': 'Built in' }[o]}
            rules={by(o)}
            openId={openId}
            onOpen={(id) => setOpenId(openId === id ? null : id)}
            onEdit={setForm}
          />
        ))}
        <p className={styles.meta}>MoMo can make itself quieter on its own. A rule that lets it do more always needs your yes.</p>
        <SettingsRows settings={settings} />
      </div>
    </div>
  );
}
