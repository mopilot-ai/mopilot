// Peer messages in a chat: the messages sent and received with their delivery state, and the dialog that sends one to another chat
// (opened from the composer's + menu or a chat mention's "Send message").

import { createContext, useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, ArrowUpRight, Send, X } from '../ui/icons';
import { native } from '../../lib/native';
import { noteIgnored, errorText, userError } from '../../lib/ignored';
import { PEER_REASONS, peerReasonText } from '../../../shared/peerReasons.mjs';
import { toast, useStore, threadTitle } from '../../store/core';
import type { PeerCapabilities, PeerChat, PeerMessage } from '../../../shared/peerMessages';
import { peerDraft, patchPeerDraft, clearPeerDraft } from '../../lib/peerDrafts';
import { busyField, imeComposing } from '../../lib/focus';
import { windowReady } from '../../lib/windowReady';
import { visibleChats } from '../../store/split';
import { openChatFrom } from '../../session/openChat';
import { useMomoChat } from '../momo/useMomoChat';

const labels = {
  accepted: 'Accepted',
  queued: 'Queued',
  submitting: 'Submitting',
  delivered: 'Delivered',
  blocked: 'Blocked',
  failed: 'Failed',
  cancelled: 'Cancelled',
  uncertain: 'Delivery unknown',
  held: 'Waiting for approval',
  declined: 'Declined',
  expired: 'Expired',
};
/** A refusal main gives by its reason code reads as that reason's line; any other failure as userError says it. */
function peerErrorMessage(error: unknown): string {
  const code = errorText(error ?? '');
  // an unknown code (from a newer main) gets the generic line, never the code
  return Object.hasOwn(PEER_REASONS, code) || /^[a-z]+(?:_[a-z]+)+$/.test(code) ? peerReasonText(code) : userError(error);
}

export const PeerContext = createContext<PeerMessage[]>([]);

export function PeerMessages({
  chatId,
  readOnly = false,
  inPane = false,
  entry = false,
  onMessages,
}: {
  chatId: string;
  readOnly?: boolean;
  /** shown in a side pane: when the main view shows the same chat, that view owns the compose dialog */
  inPane?: boolean;
  /** a view without the composer (Quick Chat) offers its own way to start a message */
  entry?: boolean;
  onMessages?: (messages: PeerMessage[]) => void;
}) {
  const [messages, setMessages] = useState<PeerMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<PeerChat[]>([]);
  const [target, setTarget] = useState('');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<PeerCapabilities | null>(null);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const currentChat = useRef(chatId);
  const operation = useRef(0);
  const composeRequest = useRef(0);
  const submitPending = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  currentChat.current = chatId;
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  // MoMo's chats take no part in messages between chats (they are in no list): nothing to read or show (#2288)
  const momo = useMomoChat(chatId);
  // one dialog per chat: a side pane showing a chat a pane of the window shows leaves it to that pane
  const deferred = useStore((s) => inPane && visibleChats(s).includes(chatId));
  const composing = !readOnly && !deferred;
  // the title kept with the message names a chat no window lists (an archived one); never a raw id
  const title = (id: string, kept?: string | null) => (threads[id] ? threadTitle(threads[id], initialTitles) : (kept ?? 'another chat'));
  useEffect(() => {
    onMessages?.(messages);
  }, [messages, onMessages]);
  useEffect(() => {
    operation.current++;
    setMessages([]);
    setCapabilities(null);
    setError(null);
    if (momo) return;
    let alive = true;
    let version = 0;
    // every failure ends in setError, so a load is started and left to run
    const load = (retry = true): void => {
      const request = ++version;
      // before boot tells main this window is ready, main refuses it as the source (and following the chat does nothing)
      windowReady()
        .then(() => Promise.all([native.peer.snapshot(chatId), native.peer.capabilities(chatId)]))
        .then(([m, caps]) => {
          if (alive && request === version) {
            setMessages(m);
            setCapabilities(caps);
            setError(null);
          }
        })
        .catch(async (e) => {
          if (!alive || request !== version) return;
          // main lets a window speak only for chats it shows or follows; a chat in a side pane can ask before this
          // window follows it (this effect runs before the thread's session one): follow it, then ask once more
          if (retry && errorText(e ?? '').includes('invalid_source_window')) {
            // not followed: asking again below fails the same way and shows that error
            await native.session.snapshot(chatId).catch((e) => noteIgnored('follow a chat to read its peer messages', e));
            if (alive && request === version) load(false);
            return;
          }
          setError(peerErrorMessage(e));
        });
    };
    load();
    const off = native.peer.onChanged(() => load());
    return () => {
      alive = false;
      operation.current++;
      off();
    };
  }, [chatId, momo]);
  const perform = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      toast(peerErrorMessage(error), 'error');
    }
  };
  const compose = async (selected?: string, restoring = false) => {
    const activeOperation = operation.current;
    const version = ++composeRequest.current;
    const current = () => currentChat.current === chatId && operation.current === activeOperation && composeRequest.current === version;
    try {
      const all: PeerChat[] = [];
      let cursor: string | null = null;
      do {
        const page = await native.peer.directory(chatId, { cursor, limit: 50 });
        if (!current()) return;
        all.push(...page.chats);
        cursor = page.nextCursor;
      } while (cursor);
      setTargets(all);
      setTarget(selected ?? '');
      setReplyTo(null);
      setOpen(true);
      if (!restoring) patchPeerDraft(chatId, { target: selected ?? '', replyTo: null, open: true });
    } catch (error) {
      if (current()) toast(peerErrorMessage(error), 'error');
    }
  };
  // effects open the form with the chat they run for
  const composeFor = useEffectEvent(compose);
  useEffect(() => {
    const draft = peerDraft(chatId);
    setOpen(draft.open);
    setBody(draft.body);
    setReplyTo(draft.replyTo);
    setTarget(draft.target);
    setSending(false);
    submitPending.current = false;
    request.current = draft.request;
    // cannot reject: compose says why the directory didn't load
    if (draft.open && !draft.replyTo) void composeFor(draft.target, true);
  }, [chatId]);
  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // cannot reject: compose says why the directory didn't load
      if (composing && detail?.sourceChatId === chatId && typeof detail.targetChatId === 'string') void composeFor(detail.targetChatId);
    };
    window.addEventListener('mopilot:peer-compose', listener);
    return () => {
      composeRequest.current++;
      window.removeEventListener('mopilot:peer-compose', listener);
    };
  }, [chatId, composing]);
  const submit = async () => {
    if (submitPending.current) return;
    submitPending.current = true;
    const activeOperation = ++operation.current;
    setSending(true);
    try {
      const signature = JSON.stringify([chatId, target, replyTo, body]);
      if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
      const requestId = request.current.id;
      patchPeerDraft(chatId, { request: request.current });
      if (replyTo) await native.peer.reply(chatId, { messageId: replyTo, requestId, body });
      else await native.peer.send(chatId, { targetChatId: target, requestId, body, requestReply: true });
      const latest = peerDraft(chatId);
      const unchanged = JSON.stringify([chatId, latest.target, latest.replyTo, latest.body]) === signature;
      if (unchanged) clearPeerDraft(chatId);
      if (unchanged && currentChat.current === chatId && operation.current === activeOperation) {
        request.current = null;
        setBody('');
        setOpen(false);
        setReplyTo(null);
      }
    } catch (error) {
      if (currentChat.current === chatId && operation.current === activeOperation) toast(peerErrorMessage(error), 'error');
    } finally {
      if (currentChat.current === chatId && operation.current === activeOperation) {
        submitPending.current = false;
        setSending(false);
      }
    }
  };
  const close = () => {
    composeRequest.current++;
    setOpen(false);
    patchPeerDraft(chatId, { open: false });
  };
  const chosen = replyTo ? undefined : targets.find((t) => t.id === target);
  const asking = replyTo ? messages.find((m) => m.id === replyTo) : undefined;
  const canSend = !sending && !!body.trim() && (!!target || !!replyTo);
  const showList = !momo && (!!error || messages.length > 0 || (entry && !readOnly));
  const dialog = open && composing;
  // Escape closes the dialog wherever focus is, and closing gives focus back to where it was (the composer)
  const onEscape = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || imeComposing(e)) return;
    e.stopPropagation();
    if (!sending) close();
  });
  useEffect(() => {
    if (!dialog) return;
    // read before focusing the message field (an autoFocus would run before this effect)
    const before = document.activeElement as HTMLElement | null;
    field.current?.focus();
    window.addEventListener('keydown', onEscape, true);
    return () => {
      window.removeEventListener('keydown', onEscape, true);
      if (before?.isConnected) before.focus();
    };
  }, [dialog]);
  return (
    <>
      {showList && (
        <section aria-label="Messages between chats" className="peer-messages">
          {error && (
            <p role="status" className="peer-note">
              Chat messaging unavailable: {error}
            </p>
          )}
          {entry && !readOnly && (
            <button type="button" className="btn-pill peer-entry" onClick={() => void compose()}>
              <Send size={13} aria-hidden />
              Message another chat
            </button>
          )}
          {messages.map((m) => {
            const outgoing = m.sourceChatId === chatId;
            const other = outgoing ? m.targetChatId : m.sourceChatId;
            return (
              <article key={m.id} className={`peer-message ${outgoing ? 'out' : 'in'}`}>
                <div className="peer-message-head">
                  {outgoing ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownLeft size={14} aria-hidden />}
                  <span>{outgoing ? 'To' : 'From'}</span>
                  <button type="button" className="peer-chat-link" onClick={(e) => openChatFrom(e, other, { newWindow: false })}>
                    {title(other, outgoing ? m.targetTitle : m.sourceTitle)}
                  </button>
                  <span className={`peer-badge ${m.delivery}`}>{labels[m.delivery]}</span>
                  {m.reply === 'awaiting' && <span className="peer-badge">Awaiting reply</span>}
                  {m.reply === 'received' && <span className="peer-badge done">Replied</span>}
                </div>
                <p className="peer-message-body">{m.body}</p>
                {m.errorCode && (
                  <p role="status" className="peer-note">
                    {peerReasonText(m.errorCode)}
                  </p>
                )}
                {!readOnly && (
                  <div className="peer-message-actions">
                    {m.delivery === 'uncertain' && (
                      <button className="btn-pill" onClick={() => perform(() => native.peer.reconcile(chatId, m.id))}>
                        Check delivery
                      </button>
                    )}
                    {outgoing && m.delivery === 'queued' && (
                      <button className="btn-pill" onClick={() => perform(() => native.peer.sendNow(chatId, m.id))}>
                        Deliver now if supported
                      </button>
                    )}
                    {outgoing && ['blocked', 'failed'].includes(m.delivery) && (
                      <button className="btn-pill" onClick={() => perform(() => native.peer.resume(chatId, m.id))}>
                        Retry delivery
                      </button>
                    )}
                    {!outgoing && m.delivery === 'held' && (
                      <>
                        <button className="btn-pill" onClick={() => perform(() => native.peer.approve(chatId, m.id))}>
                          Allow
                        </button>
                        <button className="btn-pill ghost" onClick={() => perform(() => native.peer.decline(chatId, m.id))}>
                          Decline
                        </button>
                      </>
                    )}
                    {outgoing && ['queued', 'blocked', 'failed', 'held'].includes(m.delivery) && (
                      <button className="btn-pill ghost" onClick={() => perform(() => native.peer.cancel(chatId, m.id))}>
                        Cancel message
                      </button>
                    )}
                    {!outgoing && m.delivery === 'delivered' && m.reply === 'awaiting' && (
                      <button
                        className="btn-pill"
                        onClick={() => {
                          composeRequest.current++;
                          setReplyTo(m.id);
                          setBody('');
                          setOpen(true);
                          patchPeerDraft(chatId, { replyTo: m.id, body: '', open: true });
                        }}
                      >
                        Reply
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
      {dialog &&
        createPortal(
          <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !sending && close()}>
            <div className="dialog peer-compose" role="dialog" aria-modal="true" aria-labelledby="peer-compose-title">
              <div className="dialog-head">
                <span id="peer-compose-title">
                  {replyTo
                    ? `Reply to ${asking ? title(asking.sourceChatId, asking.sourceTitle) : 'the requesting chat'}`
                    : 'Message another chat'}
                </span>
                <button className="icon-btn sm" aria-label="Close" disabled={sending} onClick={close}>
                  <X size={14} />
                </button>
              </div>
              <p className="acct-dialog-hint">
                {replyTo
                  ? 'Your reply goes back to the chat that asked.'
                  : 'The chat you choose gets this as a request. Its answer comes back here.'}
              </p>
              {!replyTo && (
                <label className="peer-field">
                  <span>To</span>
                  <select
                    className="text-input"
                    aria-label="Recipient chat"
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      patchPeerDraft(chatId, { target: e.target.value });
                    }}
                  >
                    <option value="">Choose a chat</option>
                    {targets.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.title}
                        {t.archived ? ' · Archived' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {chosen?.project && <p className="peer-note">Project: {chosen.project}</p>}
              {chosen?.capabilities?.peerMessaging.reason && (
                <p role="status" className="peer-note warn">
                  Can’t deliver now. {peerReasonText(chosen.capabilities.peerMessaging.reason)} Your message is kept.
                </p>
              )}
              {chosen?.capabilities?.peerTools?.available === false && (
                <p role="status" className="peer-note warn">
                  Its chat tools are off. {peerReasonText(chosen.capabilities.peerTools.reason)} It replies by final answer.
                </p>
              )}
              <textarea
                className="text-area peer-compose-body"
                aria-label="Message to another chat"
                ref={field}
                rows={5}
                placeholder={replyTo ? 'Write your reply' : 'What should the other chat do?'}
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  patchPeerDraft(chatId, { body: e.target.value });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing && canSend) {
                    e.preventDefault();
                    // cannot reject: submit reports its failure in a toast and keeps the draft
                    void submit();
                  }
                }}
                {...busyField(sending)}
              />
              {capabilities?.peerTools.available === false && (
                <p role="status" className="peer-note">
                  Chat tools are off here. {peerReasonText(capabilities.peerTools.reason)} You can still send.
                </p>
              )}
              <div className="sketch-foot">
                <button className="btn-pill" disabled={sending} onClick={close}>
                  Cancel
                </button>
                <button className="btn-white" disabled={!canSend} onClick={submit}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
