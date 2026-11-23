// MoMo's chat as the home contract draws it (Main, W1.6–W1.7, W3.6): assistant and user rows, the morning brief and catch-up cards, the approval card, and a composer that says when it sends. Rows are memoized by the row object (the store keeps an unchanged row's identity), and the composer is its own component so a keystroke redraws nothing else.
import { memo, useState } from 'react';
import { navigate } from '../../../store/panes';
import { momoDeliveryNeedsCheck, type MomoBriefView, type MomoCatchUpView, type MomoChatRow } from '../../../../shared/momoView';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard, ResultCard, WatchChangedCard } from './RowCards';
import { clock } from './homeCopy';
import { Refusal } from './Refusal';
import { probe } from './renderProbe';
import { useMomoAct } from './useMomoHome';
import styles from './home.module.css';

function Brief({ b, at, home }: { b: MomoBriefView; at: number; home: string }) {
  const { act, busy, failed } = useMomoAct();
  const [showLeft, setShowLeft] = useState(false);
  const day = new Date(at).toLocaleDateString('en-US', { weekday: 'long' });
  return (
    <section className={styles.card} aria-label="Morning brief" aria-busy={busy}>
      <span className={styles.meta}>
        {day} {clock(at)}
      </span>
      <p className={styles.text}>
        {b.greeting} {b.attention ? `One thing needs you today: ${b.attention.text}` : 'Nothing needs you today.'}
      </p>
      {b.attention ? <span className={styles.meta}>From {b.attention.source}</span> : null}
      {b.offers.length ? <p className={styles.text}>I can move this forward:</p> : null}
      {b.offers.map((o) => (
        <div key={o.id} className={styles.card}>
          <strong>{o.title}</strong>
          <span className={styles.meta}>{o.why}</span>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'brief.hide', offerId: o.id })}>
              Hide
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={busy}
              onClick={() => void act({ type: 'brief.start', offerId: o.id })}
            >
              Start
            </button>
          </div>
        </div>
      ))}
      <Refusal failed={failed} />
      <p className={styles.meta}>
        Overnight on {home}: read {b.overnight.read} messages, updated {b.overnight.notesUpdated} notes, learned {b.overnight.rulesLearned}{' '}
        rule.
      </p>
      {b.leftOut.length ? (
        <>
          <button type="button" className={styles.btn} aria-expanded={showLeft} onClick={() => setShowLeft((s) => !s)}>
            Left out: {b.leftOut.length}. See
          </button>
          {showLeft ? (
            <ul className={styles.list}>
              {b.leftOut.map((l) => (
                <li key={l.id} className={styles.meta}>
                  {l.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function CatchUp({ c }: { c: MomoCatchUpView }) {
  const rest = c.read - c.needsYou.length;
  return (
    <section className={styles.card} aria-label="Catch-up" data-testid="momo-catchup">
      <h3 className={styles.h1}>
        While {c.machine.name} was asleep, {clock(c.from)} to {clock(c.to)}
      </h3>
      <p className={styles.text}>
        Read {c.read} messages. {c.needsYou.length} needs you{c.needsYou[0] ? `: ${c.needsYou[0].text}` : ''}. {rest} can wait.
      </p>
      <p className={styles.meta}>Nothing was sent while {c.machine.name} slept.</p>
    </section>
  );
}

const DELIVERY: Record<string, readonly [string, string]> = {
  'never-got-it': ['Studio never got it', 'Not sent. Send now?'],
  'not-sure': ['Not sure', 'Studio may have started. Check before sending again.'],
};

function UserRow({ row, name }: { row: Extract<MomoChatRow, { kind: 'user' }>; name: string }) {
  const { act, busy, failed } = useMomoAct();
  const d = momoDeliveryNeedsCheck(row.delivery) ? (DELIVERY[row.delivery] ?? DELIVERY['not-sure']) : null;
  return (
    <>
      <p className={styles.bubble}>{row.text}</p>
      {row.delivery === 'queued' ? (
        <p className={styles.meta} role="status" style={{ alignSelf: 'flex-end' }}>
          Waiting for {name}
        </p>
      ) : null}
      {d ? (
        <div className={styles.card} role="status">
          <strong>{d[0].replace('Studio', name)}</strong>
          <span className={styles.meta}>{d[1].replace('Studio', name)}</span>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'chat.check', rowId: row.id })}>
              Check again
            </button>
            {row.delivery === 'never-got-it' ? (
              // the home said it never saw this turn: sent again under the same id, so the home runs one copy even if both arrive
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                onClick={() => void act({ type: 'chat.send', turnId: row.id, text: row.text })}
              >
                Send now
              </button>
            ) : null}
            <button type="button" className={styles.btn} onClick={() => void navigator.clipboard?.writeText(row.text)}>
              Copy text
            </button>
          </div>
          <Refusal failed={failed} />
          <span className={styles.meta}>MoMo never sends the same message twice on its own.</span>
        </div>
      ) : null}
    </>
  );
}

function AssistantRow({ row }: { row: Extract<MomoChatRow, { kind: 'assistant' }> }) {
  const { act, busy, failed } = useMomoAct();
  const s = row.notNeeded?.suggestion;
  return (
    <div>
      <p className={styles.text}>{row.text}</p>
      {row.source || row.whyTold ? <span className={styles.meta}>{[row.source, row.whyTold].filter(Boolean).join(' · ')}</span> : null}
      {row.notNeeded && !s ? (
        <div className={styles.actions}>
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'row.notNeeded', rowId: row.id })}>
            Not needed
          </button>
        </div>
      ) : null}
      {s ? (
        <p className={styles.meta} role="status">
          {s.text}{' '}
          <button type="button" className={styles.btn} disabled={busy} onClick={() => void act({ type: 'rule.undo', id: s.ruleId })}>
            Undo
          </button>{' '}
          <button type="button" className={styles.btn} onClick={() => navigate({ name: 'momo', tab: 'rules' })}>
            See rule
          </button>
        </p>
      ) : null}
      <Refusal failed={failed} />
    </div>
  );
}

const Row = memo(function Row({ row, name, now }: { row: MomoChatRow; name: string; now?: number }) {
  probe(`row:${row.id}`);
  const inner = (() => {
    switch (row.kind) {
      case 'brief':
        return <Brief b={row.brief} at={row.at} home={name} />;
      case 'catch-up':
        return <CatchUp c={row.catchUp} />;
      case 'approval':
        return <ApprovalCard a={row.approval} now={now} />;
      case 'question':
        return <QuestionCard q={row.question} now={now} />;
      case 'result':
        return <ResultCard r={row.result} />;
      case 'watch-changed':
        return <WatchChangedCard w={row.watch} />;
      case 'waiting':
        return (
          <p className={styles.meta} role="status">
            Waiting for {row.machine.name}
          </p>
        );
      case 'user':
        return <UserRow row={row} name={name} />;
      case 'assistant':
        return <AssistantRow row={row} />;
      default:
        // a row kind a newer MoPilot draws: said so, never blank and never a guess
        return (
          <p className={styles.meta} data-unknown-row>
            MoMo shows something here that this version of MoPilot can’t draw.
          </p>
        );
    }
  })();
  return <div data-testid={`momo-row-${row.id}`}>{inner}</div>;
});

/** The composer: its text is its own state, kept until the home accepts the message and put back when it does not. */
function Composer({ name, asleep }: { name: string; asleep: boolean }) {
  const { act, busy, failed } = useMomoAct();
  const [text, setText] = useState('');
  const [turn, setTurn] = useState(() => crypto.randomUUID());
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    const r = await act({ type: 'chat.send', turnId: turn, text: t });
    if (r.ok) {
      // accepted: this text is sent; the next message is a new turn
      setText((now) => (now.trim() === t ? '' : now));
      setTurn(crypto.randomUUID());
    }
  };
  return (
    <>
      <form
        className={styles.actions}
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className={styles.field}
          style={{ flex: 1 }}
          aria-label="Message MoMo"
          placeholder={asleep ? `Message MoMo · sends when ${name} is back` : 'Message MoMo'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className={styles.primary} disabled={busy || !text.trim()}>
          Send
        </button>
      </form>
      <Refusal failed={failed} />
    </>
  );
}

export function ChatView({ chat, name, asleep, now }: { chat: MomoChatRow[]; name: string | null; asleep: boolean; now?: number }) {
  probe('chat-view');
  const home = name ?? 'MoMo’s machine';
  return (
    <div className={styles.body}>
      <div className={styles.column} role="region" aria-label="Chat">
        {chat.map((r) => (
          <Row key={r.id} row={r} name={home} now={now} />
        ))}
        <Composer name={home} asleep={asleep} />
      </div>
    </div>
  );
}
