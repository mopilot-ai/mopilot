// Ask MoMo in Quick Chat (#2139): the floating window's MoMo target, only while MoMo is allowed (a revoke turns it off at once). It sends to MoMo's main chat through main (window.native.momoAsk), shows that chat read-only (questions and approvals are answered in MoMo), takes dictation on this Mac, and keeps its draft in this window only: Quick Chat's saved chat and draft never hold MoMo's. Escape and the hide button return to the previous app as Quick Chat does.
import { useEffect, useRef, useState } from 'react';
import { useMomoAllowed } from '../../lib/momo';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { quickChatSends } from '../../lib/quickChat';
import { isMac } from '../../lib/platform';
import { busyField } from '../../lib/focus';
import { openThread } from '../../store/threads';
import { useStore } from '../../store/core';
import { useEffectOn } from '../../lib/effects';
import { ThreadView } from '../thread/ThreadView';
import { ArrowUp, ArrowUpRight } from '../ui/icons';
import { MomoDictation } from './MomoDictation';
import { MomoDot } from './MomoSidebarRow';
import { BrainLabel } from './settings/BrainPicker';
import { dropAsked, heldAsked, showAsked } from './askedQuestion';
import type { MomoBrain } from '../../lib/native/contracts/momoChat';

/** Quick Chat's target: MoMo or its own chats. MoMo exists only while allowed, and a revoke leaves it off. */
export function useAskMomo() {
  const allowed = useMomoAllowed();
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!allowed) setOn(false);
  }, [allowed]);
  return { available: allowed, on: allowed && on, setOn };
}

/** The header button that switches Quick Chat to MoMo and back; nothing for an account MoMo is off for. */
export function AskMomoToggle({ ask }: { ask: ReturnType<typeof useAskMomo> }) {
  if (!ask.available) return null;
  return (
    <button
      type="button"
      className={`icon-btn ${ask.on ? 'on' : ''}`}
      aria-label="Ask MoMo"
      aria-pressed={ask.on}
      title={ask.on ? 'Back to Quick Chat' : 'Ask MoMo'}
      onClick={() => ask.setOn(!ask.on)}
    >
      <MomoDot size={16} />
    </button>
  );
}

/**
 * Quick Chat's header while it asks MoMo (#2288): MoMo's brain, read-only (it changes in MoMo's brain chip), never the
 * coding Quick Chat's model; read again when it changes in any window. Nothing until main says what it is.
 */
export function AskMomoBrain() {
  const [brain, setBrain] = useState<MomoBrain | null>(null);
  useEffect(() => {
    let alive = true;
    native.momoChat.getBrain().then(
      (b) => alive && setBrain(b),
      () => alive && setBrain(null),
    );
    const off = native.momoChat.onBrainChanged((b) => alive && setBrain(b));
    return () => {
      alive = false;
      off();
    };
  }, []);
  if (!brain) return null;
  return (
    <span className="model-btn ask-momo-brain" role="img" aria-label={`MoMo's brain`} title="MoMo's brain">
      <BrainLabel brain={brain} />
    </span>
  );
}

/** MoMo's main chat in Quick Chat: its replies and a composer that sends only there. */
export function AskMomoPane() {
  const prefs = useStore((s) => s.prefs);
  const [chatId, setChatId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  // a retry of the same text keeps its request id, so main never sends it twice
  const retry = useRef<{ text: string; id: string } | null>(null);
  // questions this window shows its own copy of, by request id, until the chat holds them (askedQuestion.ts)
  const asked = useRef(new Map<string, string>());
  const turns = useStore((s) => (chatId ? s.runtime[chatId]?.turns : undefined));
  useEffect(() => {
    if (!chatId) return;
    for (const id of heldAsked(turns, asked.current)) {
      asked.current.delete(id);
      dropAsked(chatId, id);
    }
  }, [chatId, turns]);

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    native.momoAsk.chat().then(
      (r) => alive.current && setChatId(r.chatId),
      (e) => alive.current && setError(errorText(e)),
    );
    return () => {
      alive.current = false;
    };
  }, []);
  // MoMo's chats are in no list, so nothing else loads this one's history into the window
  useEffectOn([chatId], () => {
    if (chatId) openThread(chatId).catch((e: unknown) => alive.current && setError(errorText(e)));
  });

  const submit = async () => {
    const value = text.trim();
    if (sending || !value) return;
    if (retry.current?.text !== value) retry.current = { text: value, id: crypto.randomUUID() };
    setSending(true);
    setError(null);
    const { id } = retry.current;
    // shown at once: main shows a turn's message to an app window only, never to Quick Chat
    if (chatId) showAsked(chatId, id, value);
    try {
      const r = await native.momoAsk.send({ id, text: value, followUp: prefs.followUp });
      if (!alive.current) return;
      retry.current = null;
      asked.current.set(id, value);
      // a brain change moved MoMo to a new chat meanwhile: the question shows there
      if (r.chatId !== chatId) {
        if (chatId) dropAsked(chatId, id);
        showAsked(r.chatId, id, value);
      }
      setChatId(r.chatId);
      // the box is read-only while sending, so only dictation added to its end since, and that stays
      setText((now) => now.slice(text.length).trim());
      if (r.note) setError(r.note);
    } catch (e) {
      // not sent: the question goes back to the box alone
      if (chatId) dropAsked(chatId, id);
      if (alive.current) setError(errorText(e));
    } finally {
      if (alive.current) {
        setSending(false);
        input.current?.focus();
      }
    }
  };
  const open = () => native.momoAsk.open().catch((e: unknown) => alive.current && setError(errorText(e)));

  return (
    <>
      {chatId ? (
        // read-only: its questions and approvals are answered in MoMo (Quick Chat can only send through momoAsk)
        <ThreadView
          threadId={chatId}
          inPane
          readOnly
          composer={false}
          readOnlyNote={
            <>
              Answer MoMo's questions in MoMo.{' '}
              <button type="button" className="link-btn" onClick={open}>
                Open MoMo
              </button>
            </>
          }
        />
      ) : (
        <div className="quick-chat-empty">{error ? '' : 'Ask MoMo anything'}</div>
      )}
      <div className="quick-chat-compose">
        {error && (
          <div className="quick-chat-error" role="alert">
            {error}
          </div>
        )}
        <div className="quick-chat-input-row">
          <textarea
            ref={input}
            className="quick-chat-input"
            aria-label="Message MoMo"
            placeholder="Ask MoMo"
            value={text}
            {...busyField(sending)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              const keys = {
                key: e.key,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                isComposing: e.nativeEvent.isComposing,
              };
              if (quickChatSends(keys, prefs.sendWith, isMac)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <MomoDictation onText={(t) => setText((x) => (x ? `${x} ${t}` : t))} />
          <button className="icon-btn" aria-label="Open MoMo" title="Open MoMo" onClick={open}>
            <ArrowUpRight size={16} />
          </button>
          <button className="quick-chat-send" aria-label="Send to MoMo" disabled={sending || !text.trim()} onClick={submit}>
            <ArrowUp size={17} />
          </button>
        </div>
      </div>
    </>
  );
}
