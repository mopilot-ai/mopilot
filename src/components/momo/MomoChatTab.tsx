// MoMo's Chat (#2139), laid out as Muse's chat: a full-height chat whose transcript scrolls under MoMo's small floating identity (its dot, name and what it is doing, or Paused with Resume), with its brain chip in the composer's model picker slot (the composer itself leaves the coding chrome out of a MoMo chat) and the composer drawn as Muse's one-row pill; an earlier main chat (MomoNav's Earlier) shows read-only. It shows MoMo's main chat (made on the first visit, on the default brain until one is picked, and read again when its brain changes, which may start a new one), or another MoMo chat (an earlier one, a routine's run), with a way back; MoMo's chats are in no list, so this view loads the shown one's history itself.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { useEffectOn } from '../../lib/effects';
import { useChatRowState } from '../../session/useChatRowState';
import { saveMomoPref, useMomoPrefs } from '../../session/momoPrefs';
import { navigate } from '../../store/panes';
import { openThread } from '../../store/threads';
import { useStore } from '../../store/core';
import { ThreadView } from '../thread/ThreadView';
import { MomoModelSlot, MomoPlaceholder } from './useMomoChat';
import { ArrowLeft } from '../ui/icons';
import { BrainChip } from './BrainChip';
import { MomoDot } from './MomoSidebarRow';
import { MomoPanel } from './MomoPanel';
import { momoLine } from './momoStatus';
import { useWideFrame } from './useWideFrame';
import { usePanelOpen } from './usePanelOpen';
import { PanelRight } from '../ui/icons';
import { WholeReplies } from './shell/wholeReplies';
import { SHELL_COPY } from './shell/shellCopy';
import styles from './momoChat.module.css';

/** MoMo's brain chip in its composer's model picker slot (useMomoChat's MomoModelSlot; the composer leaves the coding side's chrome out of a MoMo chat itself). */
const CHIP = <BrainChip />;

const EARLIER_NOTE = 'An earlier conversation · Read only';

/** MoMo's dot and name at the top center, over the transcript, with the shown chat's status under them (and, in the shell, a pill while a reply is on its way). */
function Identity({ chatId, shell }: { chatId: string | null; shell: boolean }) {
  const name = useMomoPrefs().persona.name;
  const state = useChatRowState(chatId ?? '')?.state;
  const working = state === 'working' || state === 'elsewhereRunning';
  return (
    <div className={styles.identity}>
      <span className={styles.avatar}>
        <MomoDot size={20} />
      </span>
      <span className={styles.name}>{name}</span>
      {/* one status under the name: the shell's pill while a reply is on its way, else the status line */}
      {chatId ? shell && working ? <Thinking chatId={chatId} /> : <Status chatId={chatId} /> : null}
    </div>
  );
}

/** The shell's "Thinking it through" under the avatar, from the turn starting to its reply being whole (replies arrive whole there, never token by token). */
function Thinking({ chatId }: { chatId: string }) {
  const state = useChatRowState(chatId)?.state ?? 'idle';
  if (state !== 'working' && state !== 'elsewhereRunning') return null;
  return (
    <span className={styles.thinking} role="status">
      {SHELL_COPY.thinking}
    </span>
  );
}

/** MoMo paused (Settings › MoMo): said first, with the way to resume it here; else the shown chat's status line. */
function Status({ chatId }: { chatId: string }) {
  const paused = useMomoPrefs().paused;
  const [resuming, setResuming] = useState(false);
  const status = momoLine(useChatRowState(chatId)?.state ?? 'idle', false);
  if (paused)
    return (
      <span className={styles.status} data-tone="paused" role="status">
        Paused ·{' '}
        <button
          type="button"
          className={styles.resume}
          disabled={resuming}
          onClick={() => {
            setResuming(true);
            // never rejects (the user is told when it wasn't saved); the line goes once the window has it
            void saveMomoPref('paused', false).then(() => setResuming(false));
          }}
        >
          Resume
        </button>
      </span>
    );
  return (
    <span className={styles.status} data-tone={status.tone} role="status">
      {status.text}
    </span>
  );
}

export function MomoChatTab({
  chatId: shown,
  shell = false,
  placeholder,
  extra,
}: {
  chatId?: string;
  shell?: boolean;
  /** a channel's composer line ("Message #name", A2); MoMo's own otherwise */
  placeholder?: string;
  /** a channel's header and first row (A2), over the chat */
  extra?: React.ReactNode;
}) {
  const [main, setMain] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // the newest read wins: a brain change (in any window) may have made a new main chat meanwhile
    let latest = 0;
    const read = () => {
      const seq = ++latest;
      native.momoChat.mainChat().then(
        (r) => {
          if (seq !== latest) return;
          setMain(r.chatId);
          setWarning(r.warning);
          setError(null);
        },
        (e: unknown) => seq === latest && setError(errorText(e)),
      );
    };
    read();
    const off = native.momoChat.onBrainChanged(read);
    return () => {
      latest = -1;
      off();
    };
  }, []);
  const id = shown ?? main;
  // an earlier main chat (a brain change replaced it) is read, never continued: MoMo goes on in its main chat
  const earlier = useStore((s) => !!id && s.momoChats[id] === 'previous');
  useEffectOn([id], () => {
    if (id) openThread(id).catch((e: unknown) => setError(errorText(e)));
  });
  const { ref, wide } = useWideFrame();
  const [open, setOpen] = usePanelOpen();
  // the shell has its own panels (one at a time, beside the chat): the details panel and its toggle are not drawn there
  const panel = wide && open && !shell;
  return (
    <div className={styles.frame} ref={ref}>
      <section className={styles.chat} aria-label="Chat" data-shell={shell ? '' : undefined}>
        {id ? (
          <MomoModelSlot.Provider value={CHIP}>
            <WholeReplies.Provider value={shell}>
              <MomoPlaceholder.Provider value={placeholder ?? 'Message MoMo'}>
                <ThreadView threadId={id} inPane readOnly={earlier} readOnlyNote={earlier ? EARLIER_NOTE : undefined} />
              </MomoPlaceholder.Provider>
            </WholeReplies.Provider>
          </MomoModelSlot.Provider>
        ) : error ? null : (
          <div className={styles.empty}>MoMo is getting ready.</div>
        )}
        {extra ? <div className={styles.extra}>{extra}</div> : null}
        {shell && id ? <p className={styles.footnote}>{SHELL_COPY.mistakes}</p> : null}
        <header className={styles.head}>
          {/* the shell's rail is the way back (Main, its header's arrow): one back arrow, never two */}
          {shown && shown !== main && !shell ? (
            <button
              type="button"
              className={styles.back}
              aria-label="Back to MoMo"
              title="Back to MoMo"
              onClick={() => navigate({ name: 'momo', tab: 'chat' })}
            >
              <ArrowLeft size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          {panel ? null : <Identity chatId={id} shell={shell} />}
          {wide && !shell ? (
            <button
              type="button"
              className={styles.toggle}
              aria-label={open ? 'Hide details' : 'Show details'}
              aria-pressed={open}
              title={open ? 'Hide details' : 'Show details'}
              onClick={() => setOpen(!open)}
            >
              <PanelRight size={16} strokeWidth={1.8} />
            </button>
          ) : null}
          {error ? (
            <p className={styles.note} role="alert">
              {error}
            </p>
          ) : warning ? (
            <p className={styles.note}>{warning}</p>
          ) : null}
        </header>
      </section>
      {panel ? <MomoPanel chatId={id} /> : null}
    </div>
  );
}
