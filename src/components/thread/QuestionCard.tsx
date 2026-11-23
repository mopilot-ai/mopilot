// The card for an agent's question request, as Claude Code's own question card: one question at a time, its options and an Other answer, sent back as answers.

import { offersOther } from '../../../shared/questionOptions.mjs';
import { useEffect, useId, useRef, useState } from 'react';
import { useWindowListener } from '../../lib/effects';
import { Check, ChevronRight, X } from '../ui/icons';
import { busyField, imeComposing } from '../../lib/focus';
import { modKey, shortcutLabel } from '../../lib/platform';
import { DISMISSED_ANSWER, NO_PREFERENCE, OTHER_UNTYPED } from '../../lib/answeredQuestions';
import { withKeys } from '../../lib/listKeys';
import { cardOwnsKey, isTypingTarget } from './approvalLogic';

type QuestionOption = { label: string; description?: string };
export type Question = {
  id: string;
  question: string;
  header?: string | null;
  options?: QuestionOption[] | null;
  multiSelect?: boolean;
  isSecret?: boolean;
  /** an answer of the user's own is taken (Codex says per question; Claude Code's always are) */
  isOther?: boolean;
};
type Result = { answers: Record<string, { answers: string[] }> };

/** The Other answer's place among a question's choices. */
const OTHER = -1;
/** What one question has picked so far: option indexes (OTHER for the user's own answer) and the text typed. */
type Draft = { picked: number[]; text: string };
const EMPTY: Draft = { picked: [], text: '' };

/** A question with no options takes only the user's own answer. */
const freeText = (q: Question) => !q.options?.length;
/** The Other answer is offered beside the options: Claude Code always offers it, Codex says per question. */

/** What a question's draft answers with: its options in their order, then the user's own text (or Something else). */
export function draftAnswers(q: Question, d: Draft): string[] {
  if (freeText(q)) return d.text.trim() ? [d.text.trim()] : [];
  const labels = [...d.picked]
    .sort((a, b) => (a === OTHER ? 1 : b === OTHER ? -1 : a - b))
    .flatMap((i) => (i === OTHER ? [d.text.trim() || OTHER_UNTYPED] : q.options?.[i] ? [q.options[i].label] : []));
  return q.multiSelect ? labels : labels.slice(0, 1);
}

export function QuestionCard({
  req,
  agent,
  onAnswer,
  disabled = false,
  sendLabel,
  ownKeysOnly = false,
}: {
  req: { id: number | string; params: { questions?: Question[] } };
  agent: string;
  onAnswer: (id: number | string, result: Result) => void;
  disabled?: boolean;
  /** the last question's send button, in place of Submit (Sending… while an answer is on its way) */
  sendLabel?: string;
  /** take only keys pressed inside the card: one left in the transcript, so the waiting card keeps the window's keys */
  ownKeysOnly?: boolean;
}) {
  const qs: Question[] = req.params.questions ?? [];
  // a card that asks nothing has nothing to wait for, as Claude Code answers it at once
  const answeredEmpty = useRef(false);
  const asksNothing = !qs.length;
  useEffect(() => {
    if (asksNothing && !disabled && !answeredEmpty.current) {
      answeredEmpty.current = true;
      onAnswer(req.id, { answers: {} });
    }
  }, [asksNothing, disabled, onAnswer, req.id]);
  if (asksNothing) return null;
  return (
    <QuestionSteps
      req={req}
      qs={qs}
      agent={agent}
      onAnswer={onAnswer}
      disabled={disabled}
      sendLabel={sendLabel}
      ownKeysOnly={ownKeysOnly}
    />
  );
}

/** The card itself, one question at a time: it always has a question to show. */
function QuestionSteps({
  req,
  qs,
  agent,
  onAnswer,
  disabled,
  sendLabel,
  ownKeysOnly,
}: {
  req: { id: number | string };
  qs: Question[];
  agent: string;
  onAnswer: (id: number | string, result: Result) => void;
  disabled: boolean;
  sendLabel?: string;
  ownKeysOnly: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const titleId = useId();
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.create(null));
  // what each question was answered with as the card moved past it (Back keeps it)
  const given = useRef<Record<string, string[]>>(Object.create(null));
  const [highlight, setHighlight] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // a list the request shortened since keeps the card on its last question
  const q = qs[Math.min(index, qs.length - 1)];
  const draft = drafts[q.id] ?? EMPTY;
  const options = q.options ?? [];
  const multi = !!q.multiSelect;
  const last = index >= qs.length - 1;
  const ready = draftAnswers(q, draft).length > 0;

  const send = (result: Result) => onAnswer(req.id, result);
  const setDraft = (d: Draft) => setDrafts((all) => Object.assign(Object.create(null), all, { [q.id]: d }));
  const answer = (answers: string[]) => {
    given.current[q.id] = answers;
    if (last) {
      // every question before the last was answered on the way here
      send({ answers: Object.fromEntries(qs.map((x) => [x.id, { answers: given.current[x.id] }])) });
      return;
    }
    setIndex(index + 1);
    setHighlight(null);
  };
  const submit = () => {
    if (ready) answer(draftAnswers(q, draft));
  };
  const skip = () => answer([NO_PREFERENCE]);
  const dismiss = () => send({ answers: Object.fromEntries(qs.map((x) => [x.id, { answers: [DISMISSED_ANSWER] }])) });
  const back = () => {
    setIndex(index - 1);
    setHighlight(null);
  };
  /** A click or a number key on a choice: one choice answers at once, several toggle, Other opens its field. */
  const pick = (i: number) => {
    setHighlight(i);
    if (multi) {
      const on = draft.picked.includes(i);
      setDraft({ ...draft, picked: on ? draft.picked.filter((x) => x !== i) : [...draft.picked, i] });
      if (i === OTHER && !on) field.current?.focus();
    } else if (i === OTHER) {
      setDraft({ ...draft, picked: [OTHER] });
      field.current?.focus();
    } else {
      // kept, so Back shows the choice that answered it
      setDraft({ ...draft, picked: [i] });
      answer([options[i].label]);
    }
  };
  const type = (text: string) => {
    // typing an answer of your own picks Other (alone, when one choice is taken)
    if (freeText(q)) setDraft({ picked: [], text });
    else if (multi) setDraft({ text, picked: draft.picked.includes(OTHER) ? draft.picked : [...draft.picked, OTHER] });
    else setDraft({ text, picked: [OTHER] });
  };
  // ↑↓ walk the choices (Other last); a single-choice question takes the one walked to
  const walk = (step: 1 | -1) => {
    if (freeText(q)) return;
    const order = [...options.map((_, i) => i), ...(offersOther(q) ? [OTHER] : [])];
    const at = highlight === null ? -1 : order.indexOf(highlight);
    const next = order[at === -1 ? (step === 1 ? 0 : order.length - 1) : (at + step + order.length) % order.length];
    setHighlight(next);
    if (!multi) setDraft({ ...draft, picked: [next] });
    if (next === OTHER) field.current?.focus();
    else if (document.activeElement === field.current) field.current?.blur();
  };

  // keys act on the question shown now, from anywhere the card owns them
  useWindowListener('keydown', (e) => {
    if (disabled || collapsed || imeComposing(e) || e.repeat || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current))
      return;
    const target = e.target as HTMLElement | null;
    if (ownKeysOnly && !root.current?.contains(target)) return;
    const inField = !!field.current && target === field.current;
    const typing = isTypingTarget(target);
    if (typing && !inField) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
      return;
    }
    if (e.key === 'Enter' && modKey(e)) {
      e.preventDefault();
      submit();
      return;
    }
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      // a button takes its own Enter; a multiple-choice question toggles the choice walked to, and sends with ⌘↵ alone
      if ((target?.tagName === 'BUTTON' && !inField) || (multi && inField)) return;
      e.preventDefault();
      if (multi && !inField && highlight !== null) pick(highlight);
      else submit();
      return;
    }
    if (inField) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      walk(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (!/^[1-9]$/.test(e.key) || freeText(q)) return;
    const n = Number(e.key) - 1;
    if (n < options.length) {
      e.preventDefault();
      pick(n);
    } else if (n === options.length && offersOther(q)) {
      e.preventDefault();
      pick(OTHER);
    }
  });

  const otherOn = draft.picked.includes(OTHER);
  const fieldProps = {
    ref: field,
    className: 'question-other-input',
    ...busyField(disabled),
    'aria-label': freeText(q) ? q.question : 'Other option',
    placeholder: 'Type your own answer here',
    value: draft.text,
    tabIndex: freeText(q) || otherOn ? 0 : -1,
    onChange: (e: { target: { value: string } }) => type(e.target.value),
  };
  const box = (on: boolean, walked: boolean) => (on ? 'question-option sel' : walked ? 'question-option hl' : 'question-option');
  return (
    <div ref={root} className="approval-card question-card" role="group" aria-label={`${agent} question`} aria-labelledby={titleId}>
      <div className="question-head">
        {qs.length > 1 && (
          <span className="question-count">
            {index + 1}/{qs.length}
          </span>
        )}
        <span className="question-title" id={titleId}>
          {q.question}
        </span>
        <span className="question-head-actions">
          <button
            type="button"
            className="icon-btn"
            aria-expanded={!collapsed}
            aria-label="View question options"
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronRight size={16} className={`question-caret ${collapsed ? '' : 'open'}`} />
          </button>
          <button type="button" className="icon-btn" aria-label="Dismiss question" disabled={disabled} onClick={dismiss}>
            <X size={16} />
          </button>
        </span>
      </div>
      {!collapsed && (
        <>
          <div className="question-body">
            <div className="question-options">
              {withKeys(options, (o) => o.label).map(({ key, item: o, index: i }) => {
                const on = draft.picked.includes(i);
                return (
                  <button
                    key={key}
                    type="button"
                    className={box(on, multi && highlight === i)}
                    aria-pressed={multi ? on : undefined}
                    disabled={disabled}
                    onClick={() => pick(i)}
                  >
                    <span className="question-option-copy">
                      <span className="question-option-label">{o.label}</span>
                      {o.description && <span className="question-option-desc">{o.description}</span>}
                    </span>
                    {multi ? <CheckBox on={on} /> : i < 9 && <kbd className="question-option-key">{i + 1}</kbd>}
                  </button>
                );
              })}
              {(freeText(q) || offersOther(q)) && (
                <div className={`question-other ${freeText(q) ? 'alone' : box(otherOn, multi && highlight === OTHER)}`}>
                  {!freeText(q) && (
                    <button
                      type="button"
                      className="question-other-pick"
                      aria-pressed={multi ? otherOn : undefined}
                      disabled={disabled}
                      onClick={() => pick(OTHER)}
                    >
                      <span className="question-option-label">Other</span>
                      {multi ? (
                        <CheckBox on={otherOn} />
                      ) : (
                        options.length < 9 && <kbd className="question-option-key">{options.length + 1}</kbd>
                      )}
                    </button>
                  )}
                  {q.isSecret ? <input type="password" {...fieldProps} /> : <textarea rows={1} {...fieldProps} />}
                </div>
              )}
            </div>
          </div>
          <div className="question-foot">
            {index > 0 && (
              <button type="button" className="ap-btn deny question-back" disabled={disabled} onClick={back}>
                Back
              </button>
            )}
            <button type="button" className="ap-btn deny" disabled={disabled} onClick={skip}>
              Skip
            </button>
            <button type="button" className="ap-btn allow solo" disabled={disabled || !ready} onClick={submit}>
              {last ? (sendLabel ?? 'Submit') : 'Next'} <kbd>{shortcutLabel('⌘↵')}</kbd>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CheckBox({ on }: { on: boolean }) {
  return <span className={`question-check ${on ? 'on' : ''}`}>{on && <Check size={12} strokeWidth={2.5} />}</span>;
}
