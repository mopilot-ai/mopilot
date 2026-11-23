// MCP form and URL elicitations and native desktop grant cards.
import { useState } from 'react';
import { resolveRequest } from '../../../store/notifications';
import { openLink } from '../../../session/open';
import { MessageCircleQuestion, ExternalLink, MousePointerClick, AlertTriangle } from '../../ui/icons';
import { elicitationAnswer, nativeAppAnswer, type NativeAppApproval as NativeAppGrant } from '../../../harness/elicitation';
import { withKeys } from '../../../lib/listKeys';
import type { ElicitationRequest, ElicitationView } from './shared';
/** A form field of an MCP elicitation's requested schema, as the card reads it (Codex and Claude alike). */
type ElicitationField = { title?: string; type?: string; enum?: string[] };
type ElicitationValue = string | number | boolean;

export function Elicitation({ req }: { req: ElicitationRequest }) {
  const p: ElicitationView = req.params;
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() => Object.create(null));
  // Codex's form schema is typed; its OpenAI forms and Claude's are free JSON. Each keeps its fields in `properties`.
  const props = (p.requestedSchema as { properties?: Record<string, ElicitationField> } | null | undefined)?.properties ?? {};
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-icon">
          <MessageCircleQuestion size={16} />
        </span>
        <div className="approval-titles">
          <div className="approval-title">{p.serverName} needs input</div>
          <div className="approval-subtitle">{p.message}</div>
        </div>
      </div>
      {p.mode === 'url' ? (
        <div className="approval-body">
          <button className="btn ghost sm" onClick={() => openLink(p.url ?? '')}>
            Open {p.url} <ExternalLink size={12} />
          </button>
        </div>
      ) : (
        <div className="approval-body">
          {Object.entries(props).map(([k, s]) => (
            <label key={k} className="form-field">
              <span>{s.title ?? k}</span>
              {s.type === 'boolean' ? (
                <input
                  type="checkbox"
                  checked={!!values[k]}
                  onChange={(e) => setValues((v) => Object.assign(Object.create(null), v, { [k]: e.target.checked }))}
                />
              ) : s.enum ? (
                <select
                  className="text-input"
                  value={(values[k] as string | number | undefined) ?? ''}
                  onChange={(e) => setValues((v) => Object.assign(Object.create(null), v, { [k]: e.target.value }))}
                >
                  <option value="" />
                  {s.enum.map((o: string) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="text-input"
                  type={s.type === 'number' || s.type === 'integer' ? 'number' : 'text'}
                  value={(values[k] as string | number | undefined) ?? ''}
                  onChange={(e) => {
                    const input = e.target.value;
                    const numeric = s.type === 'number' || s.type === 'integer';
                    setValues((v) => {
                      const next = Object.assign(Object.create(null), v);
                      if (numeric && input === '') delete next[k];
                      else next[k] = numeric ? Number(input) : input;
                      return next;
                    });
                  }}
                />
              )}
            </label>
          ))}
        </div>
      )}
      <div className="approval-footer">
        <button className="btn ghost sm" onClick={() => resolveRequest(req.id, elicitationAnswer('decline', null, p.mode))}>
          Decline
        </button>
        <button className="btn primary sm" onClick={() => resolveRequest(req.id, elicitationAnswer('accept', { ...values }, p.mode))}>
          {p.mode === 'url' ? 'Done' : 'Submit'}
        </button>
      </div>
    </div>
  );
}

/**
 * Codex's own computer use (unified-computer-use plugin, on OpenAI's Sky service) asking to control an
 * app or record audio: the request's own message, warning and risk level as sent (as Codex App shows
 * them), and the grants as buttons: an app's as Codex App's card offers them (Always allow when offered,
 * Allow this conversation first), any other request's once, this session and always; the choice goes back
 * in `_meta.persist`. A grant this version can't give is named rather than dropped.
 */
export function NativeAppApproval({ req, approval }: { req: ElicitationRequest; approval: NativeAppGrant }) {
  const p: ElicitationView = req.params;
  const answer = (choice: string) => resolveRequest(req.id, nativeAppAnswer(p, choice));
  // an app approval leads with "Allow this conversation", as Codex App's card does (elevated risk too);
  // any other request leads with the narrowest grant
  const lead = approval.scopes.findIndex((s) => s.value === approval.lead);
  return (
    <div className="approval-card" data-risk={approval.risk ?? undefined}>
      <div className="approval-head">
        <span className="approval-icon">
          <MousePointerClick size={18} strokeWidth={1.6} />
        </span>
        <div className="approval-titles">
          <div className="approval-title">{approval.title}</div>
          <div className="approval-subtitle">{approval.connector ?? p.serverName}</div>
        </div>
      </div>
      <div className="approval-body">
        {approval.details.length ? (
          withKeys(approval.details, (d) => d.label).map(({ key, item: d }) => (
            <div key={key}>
              {d.label}: {d.value}
            </div>
          ))
        ) : (
          <div>{approval.app ?? approval.tool}</div>
        )}
        {approval.risk && (
          <div className="approval-risk" role="note" data-level={approval.risk}>
            <AlertTriangle size={13} strokeWidth={1.6} />{' '}
            <strong>{approval.risk.toLowerCase() === 'high' ? 'High risk' : `Risk: ${approval.risk}`}</strong>
          </div>
        )}
        {approval.warning && (
          <div className="approval-subtitle" role="alert">
            {approval.warning}
          </div>
        )}
        {approval.unsupported.length > 0 && (
          <div className="approval-subtitle" role="note" data-unsupported="">
            Can't grant here: {approval.unsupported.join(', ')}.
          </div>
        )}
      </div>
      <div className="approval-footer">
        <button className="btn ghost sm" onClick={() => answer('decline')}>
          Decline
        </button>
        {approval.scopes.map((s, i) => (
          <button
            key={s.value}
            className={`btn ${i === lead ? 'primary' : 'ghost'} sm`}
            autoFocus={i === lead}
            onClick={() => answer(s.value)}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
