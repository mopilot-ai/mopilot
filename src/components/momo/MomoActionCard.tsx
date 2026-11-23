// MoMo's approval card (#2139): what MoMo's trust layer asks before one of its actions (a momoAction card from main's broker, electron/momo/actionAsk.cjs), the same on every harness. After Muse's card: an icon and the question, one line on why, a gray box with the exact detail, then Muse's four: Allow once, Allow for this chat, Always allow (the widest scope the rule allows) and Deny, with any other scope and Always deny under More options. Enter allows once, 1–3 pick the allow buttons in order, Esc denies; only a person's input counts. Its own component, for the MoMo chat to place.
import { useRef } from 'react';
import { useWindowListener } from '../../lib/effects';
import type { MomoActionParams, MomoActionScope, SageApprovalAnswer } from '../../lib/native';
import { momoActionChoices, momoActionTitle, momoActionWhy, reachCount, reachText } from '../../lib/momoActionCopy';
import { approvalKey, approvesOnEnter, cardOwnsKey, isTypingTarget } from '../thread/approvalLogic';
import { answerSageCard, humanClick } from '../thread/approvals/shared';
import { Eye, Pencil, Send } from '../ui/icons';
import styles from './momoActionCard.module.css';

export function MomoActionCard({ id, params }: { id: string; params: MomoActionParams }) {
  const root = useRef<HTMLDivElement>(null);
  const answer = (r: SageApprovalAnswer) => answerSageCard(id, r);
  const { shown, more } = momoActionChoices(params.scopes, params.hosts[0], !!params.blocked);
  const allow = (scope: MomoActionScope) => answer({ decision: 'allow', scope });
  const deny = (always = false) => answer(always ? { decision: 'deny', always: true } : { decision: 'deny' });
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    const k = approvalKey(e, { choices: shown.length, destructive: false });
    if (k?.type === 'deny') {
      e.preventDefault();
      deny();
    } else if (k?.type === 'choose') {
      e.preventDefault();
      allow(shown[k.index].scope);
    } else if (!params.blocked && approvesOnEnter(e)) {
      e.preventDefault();
      allow('once');
    }
  });
  const sends = !!params.blocked || params.unknown || params.hosts.length > 0 || params.recipients.length > 0;
  const Icon = sends ? Send : params.action === 'read' ? Eye : Pencil;
  const title = momoActionTitle(params);
  const to = reachText(params);
  const total = reachCount(params);
  return (
    <div ref={root} className={`approval-card ${styles.card}`} data-kind="momoAction" role="group" aria-label={title}>
      <div className={styles.head}>
        <span className={styles.icon} aria-hidden="true">
          <Icon size={18} strokeWidth={1.7} />
        </span>
        <h3 className={styles.title}>{title}</h3>
      </div>
      <p className={styles.why}>{momoActionWhy(params)}</p>
      <dl className={styles.detail}>
        <dt>{params.account ? `${params.source} · ${params.account}` : params.source}</dt>
        <dd>{params.summary || params.tool}</dd>
        {to ? (
          <>
            <dt>{params.opens ? 'Site' : total > 1 ? `To · ${total}` : 'To'}</dt>
            <dd>{to}</dd>
          </>
        ) : null}
      </dl>
      <div className={styles.choices}>
        {shown.map((c, i) => (
          <button
            key={c.scope}
            type="button"
            className={i === 0 ? styles.primary : styles.choice}
            title={c.hint}
            onClick={humanClick(() => allow(c.scope))}
          >
            {c.label}
          </button>
        ))}
        <button type="button" className={styles.choice} onClick={humanClick(() => deny())}>
          {params.blocked ? 'Dismiss' : 'Deny'}
        </button>
        {more.length || params.denyAlways ? (
          <details className={styles.more}>
            <summary>More options</summary>
            <div className={styles.row}>
              {more.map((c) => (
                <button key={c.scope} type="button" className={styles.choice} onClick={humanClick(() => allow(c.scope))}>
                  {c.label}
                </button>
              ))}
              {params.denyAlways ? (
                <button type="button" className={styles.choice} onClick={humanClick(() => deny(true))}>
                  Always deny
                </button>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
