// Native ACP forms stay beside the composer; drafts are private to this window and survive card remounts.
import { useRef, useState } from 'react';
import { useSession } from '../../store/session/useSession';
import { native } from '../../lib/native';
import {
  acpFormDefaults,
  validateAcpAnswer,
  type AcpAnswer,
  type AcpDelivery,
  type AcpField,
  type AcpQuestion,
  type AcpValue,
} from '../../../shared/acpForm.mjs';
import { parseAcpNumber } from '../../../shared/acpNumber.mjs';
import { busyField } from '../../lib/focus';
import { HostAskedCard } from './HostAskedCard';

const drafts = new Map<string, Record<string, AcpValue>>();

export function AcpQuestions({ threadId, readOnly }: { threadId: string; readOnly: boolean }) {
  const questions = useSession(threadId).questions;
  return (
    <>
      {questions.map((q) =>
        q.asked?.length ? (
          <HostAskedCard key={q.id} question={q} asked={q.asked} threadId={threadId} readOnly={readOnly} />
        ) : (
          <AcpFormCard key={q.id} question={q} threadId={threadId} readOnly={readOnly} />
        ),
      )}
    </>
  );
}

export function AcpFormCard({ question: q, threadId, readOnly }: { question: AcpQuestion; threadId: string; readOnly: boolean }) {
  const [values, setValues] = useState(() => drafts.get(q.id) ?? acpFormDefaults(q.form));
  const [result, setResult] = useState<AcpDelivery | null>(null);
  const busy = useRef(false);
  const status = q.status === 'pending' ? (result?.status ?? 'pending') : q.status;
  const locked = readOnly || status !== 'pending';
  const change = (field: AcpField, value: AcpValue | undefined) => {
    const next = Object.assign(Object.create(null), values);
    if (value === undefined) delete next[field.key];
    else next[field.key] = value;
    drafts.delete(q.id);
    drafts.set(q.id, next);
    // No disk persistence or cross-window draft sharing; bound this window's retained drafts.
    if (drafts.size > 128) drafts.delete(drafts.keys().next().value!);
    setValues(next);
    setResult(null);
  };
  const answer = async (action: AcpAnswer['action']) => {
    if (locked || busy.current) return;
    let payload: AcpAnswer;
    try {
      const content = Object.assign(Object.create(null), values);
      for (const f of q.form.fields)
        if (action === 'accept' && (f.type === 'number' || f.type === 'integer') && Object.hasOwn(content, f.key)) {
          if (content[f.key] === '') delete content[f.key];
          else content[f.key] = parseAcpNumber(content[f.key]);
        }
      payload = validateAcpAnswer(q.form, action === 'accept' ? { action, content } : { action });
    } catch {
      setResult({ status: 'pending', error: 'Check the required fields and allowed values.' });
      return;
    }
    busy.current = true;
    setResult({ status: 'sending' });
    try {
      setResult(await native.session.answerQuestion(threadId, q.id, payload));
    } catch {
      // A rejected IPC may have delivered the answer. Main must confirm pending before another attempt.
      try {
        const snapshot = await native.session.snapshot(threadId);
        const current = snapshot?.questions.find((question) => question.id === q.id);
        setResult(current ?? { status: 'retired', error: 'This question is no longer available.' });
      } catch {
        setResult({ status: 'failed', error: 'Delivery could not be confirmed. Your draft is kept in this window.' });
      }
    } finally {
      busy.current = false;
    }
  };
  return (
    <section className="approval-card" aria-label={`${q.harness} question`}>
      <div className="approval-head">
        <div className="approval-titles">
          <div className="approval-title">{q.harness} needs input</div>
          <div className="approval-subtitle">{q.message}</div>
          {q.toolCallId && <div className="approval-subtitle">Tool: {q.toolCallId}</div>}
        </div>
      </div>
      <div className="approval-body">
        {q.form.fields.map((f) => (
          <FormField key={f.key} field={f} value={values[f.key]} disabled={locked} change={(value) => change(f, value)} />
        ))}
        {(result?.error || q.error) && <p role="alert">{result?.error || q.error}</p>}
        <p>Drafts stay in this window; up to 128 recently edited forms are kept.</p>
        {readOnly && <p>Answer from the main chat. Drafts stay in the window where you type them.</p>}
        {status === 'written' && <p role="status">Response written to the agent. Receipt is not confirmed.</p>}
        {status === 'answered' && <p role="status">Answered.</p>}
        {(status === 'cancelled' || status === 'retired') && <p role="status">This question is no longer available.</p>}
      </div>
      <div className="approval-footer">
        <button type="button" className="btn ghost sm" disabled={locked} onClick={() => void answer('cancel')}>
          Cancel
        </button>
        <button type="button" className="btn ghost sm" disabled={locked} onClick={() => void answer('decline')}>
          Decline
        </button>
        <button type="button" className="btn primary sm" disabled={locked} onClick={() => void answer('accept')}>
          {status === 'sending' ? 'Sending…' : 'Submit'}
        </button>
      </div>
    </section>
  );
}

function FormField({
  field: f,
  value,
  disabled,
  change,
}: {
  field: AcpField;
  value: AcpValue | undefined;
  disabled: boolean;
  change: (value: AcpValue | undefined) => void;
}) {
  const label = (
    <span>
      {f.title}
      {f.required ? ' *' : ''}
    </span>
  );
  if (f.type === 'array')
    return (
      <fieldset disabled={disabled} className="form-field">
        <legend>{label}</legend>
        {f.description && <p>{f.description}</p>}
        {f.options!.map((o) => (
          <label key={o.value}>
            <input
              type="checkbox"
              checked={Array.isArray(value) && value.includes(o.value)}
              onChange={(event) => {
                const selected = Array.isArray(value) ? value : [];
                change(event.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value));
              }}
            />
            {o.label}
            {o.description && <small>{o.description}</small>}
          </label>
        ))}
      </fieldset>
    );
  return (
    <label className="form-field">
      {label}
      {f.description && <small>{f.description}</small>}
      {f.type === 'boolean' ? (
        <select
          disabled={disabled}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => change(e.target.value === '' ? undefined : e.target.value === 'true')}
        >
          <option value="">Choose…</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : f.options ? (
        <select
          disabled={disabled}
          value={value === undefined ? '' : `v:${String(value)}`}
          onChange={(e) => change(e.target.value === '' ? undefined : e.target.value.slice(2))}
        >
          <option value="">Choose…</option>
          {f.options.map((o) => (
            <option key={o.value} value={`v:${o.value}`}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="text-input"
          type="text"
          maxLength={4096}
          inputMode={f.type === 'string' ? 'text' : 'decimal'}
          {...busyField(disabled)}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => change(e.target.value)}
        />
      )}
    </label>
  );
}
