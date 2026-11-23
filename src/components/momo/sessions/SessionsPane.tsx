// MoMo's Sessions pane (M6, the design's third panel button): the user's other chats in three groups (Needs input, Working, Can wait), each with its harness and where it runs, and the design's two controls above them: show the other chats, and let MoMo answer their requests. A click opens the chat. Nothing is listed or read while the first control is off; the second is saved for MoMo's answering and changes nothing in the list. Opens in one frame; only hover eases, on the shell's motion tokens.
import { saveMomoPref, useMomoPrefs } from '../../../session/momoPrefs';
import { openChatFrom } from '../../../session/openChat';
import { Toggle } from '../../pages/settings/Controls';
import { SHELL_COPY } from '../shell/shellCopy';
import { byGroup, GROUP_TITLE } from './sessionRows';
import { useSessionRows } from './useSessionRows';
import styles from './sessions.module.css';

export function SessionsPane() {
  const prefs = useMomoPrefs();
  const rows = useSessionRows(prefs.sessionsShow);
  return (
    <div data-sessions-pane>
      <div className={styles.controls}>
        <div className={styles.control}>
          <span className={styles.controlText}>
            {SHELL_COPY.sessionsShow}
            <span className={styles.hint}>{SHELL_COPY.sessionsShowDesc}</span>
          </span>
          <Toggle on={prefs.sessionsShow} label={SHELL_COPY.sessionsShow} onChange={(on) => saveMomoPref('sessionsShow', on)} />
        </div>
        <div className={styles.control}>
          <span className={styles.controlText}>
            {SHELL_COPY.sessionsAct}
            <span className={styles.hint}>{SHELL_COPY.sessionsActDesc}</span>
          </span>
          <Toggle on={prefs.sessionsAct} label={SHELL_COPY.sessionsAct} onChange={(on) => saveMomoPref('sessionsAct', on)} />
        </div>
      </div>
      {!prefs.sessionsShow ? (
        <p className={styles.empty}>{SHELL_COPY.sessionsOff}</p>
      ) : rows.length === 0 ? (
        <p className={styles.empty}>{SHELL_COPY.sessionsEmpty}</p>
      ) : (
        byGroup(rows).map(({ group, rows: inGroup }) => (
          <section key={group} className={styles.group} aria-label={GROUP_TITLE[group]}>
            <h3 className={styles.groupTitle}>{GROUP_TITLE[group]}</h3>
            {inGroup.map((row) => (
              <button key={row.id} type="button" className={styles.row} data-session-row={row.id} onClick={(e) => openChatFrom(e, row.id)}>
                <span className={styles.title}>{row.title}</span>
                <span className={styles.meta}>
                  {row.harness} · {row.where}
                </span>
              </button>
            ))}
          </section>
        ))
      )}
    </div>
  );
}
