// Quick Chat (the floating #mini window): a second view of saved chats with its own composer and draft.

import { useEffect, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { appearanceVars } from '../../lib/appearance';
import { isMac, platform } from '../../lib/platform';
import { QuickChatSender, quickChatSends } from '../../lib/quickChat';
import { boot } from '../../store/boot';
import { useStore, get as getState } from '../../store/core';
import { createChatThread, interrupt } from '../../store/send';
import { resetNewChatDefaults, clearNewChatProject, anyHarnessUsable, harnessesChecking, chatKind } from '../../store/chats';
import { applyNewChatDefault, rememberUsedChat } from '../../session/newChatStart';
import { navigate } from '../../store/panes';
import { chatProxy } from '../../harness/adapters/proxy';
import { usedReceipt } from '../../../shared/sendReceipt.mjs';
import { useResolvedDark } from '../markdown/Markdown';
import { ModelPicker } from '../harnessPicker/HarnessPicker';
import { ThreadView } from '../thread/ThreadView';
import { QueuedList } from '../composer/QueuedList';
import { Toasts } from '../ui/Toasts';
import { AccountSignInDialog } from '../accounts/Accounts';
import { ArrowUp, ArrowUpRight, Plus, Square, X } from '../ui/icons';
import { busyField } from '../../lib/focus';
import { liveAction } from '../../store/liveAction';
import { AskMomoBrain, AskMomoPane, AskMomoToggle, useAskMomo } from '../momo/AskMomo';

let initialized: Promise<void> | null = null;

/** A second view of ordinary saved chats. Main remains the only execution owner. */
export function Mini() {
  const route = useStore((s) => s.route);
  const threadId = route.name === 'thread' ? route.id : null;
  // the turn the Stop button shows (stops only that one: liveAction says when it already ended)
  const running = useStore((s) => (threadId ? (s.runtime[threadId]?.activeTurnId ?? null) : null));
  const prefs = useStore((s) => s.prefs);
  // Ask MoMo: Quick Chat's other target, only while MoMo is allowed (components/momo/AskMomo.tsx)
  const ask = useAskMomo();
  const usable = useStore(anyHarnessUsable);
  const checking = useStore(harnessesChecking);
  const dark = useResolvedDark();
  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const sender = useRef(new QuickChatSender());
  const submitting = useRef(false);
  const hydrated = useRef(false);
  const current = useRef({ threadId, text });
  current.current = { threadId, text };

  useEffect(() => {
    document.documentElement.classList.add('mini-root');
    // macOS frames the window itself; elsewhere the panel draws its own edge (styles: html.mini-root[data-platform])
    document.documentElement.dataset.platform = platform;
    let alive = true;
    initialized ??= boot({ quickChat: true });
    Promise.all([initialized, native.win.quickChatRead()]).then(
      ([, saved]) => {
        if (!alive) return;
        resetNewChatDefaults();
        applyNewChatDefault();
        clearNewChatProject();
        setText(saved.text);
        if (saved.threadId) navigate({ name: 'thread', id: saved.threadId });
        hydrated.current = true;
        setReady(true);
        input.current?.focus();
      },
      (e) => alive && setError(errorText(e)),
    );
    const off = native.win.onMiniShown(() => input.current?.focus());
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const style = document.documentElement.style;
    for (const key of Array.from({ length: style.length }, (_, i) => style.item(i))) if (key.startsWith('--')) style.removeProperty(key);
    for (const [key, value] of Object.entries(appearanceVars(prefs, prefs.fontSize, dark))) style.setProperty(key, value);
  }, [prefs, dark]);

  // the box grows with its text, and is measured again once the window is ready
  useEffectOn([text, ready], () => {
    // none while Ask MoMo's pane stands in for the chat and its composer
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight))}px`;
  });

  const save = async (state = current.current) => {
    try {
      await native.win.quickChatSave(state);
    } catch (e) {
      setError(errorText(e));
      throw e;
    }
  };
  /** Saves the draft; false, with the error shown, when it couldn't be. */
  const saved = (state = current.current) =>
    save(state).then(
      () => true,
      () => false,
    );
  const hide = () => {
    if (!hydrated.current) return void native.win.miniHide();
    // an unsaved draft keeps the window open, its error shown
    void saved().then((ok) => (ok ? native.win.miniHide() : undefined));
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      // Popovers and approval dialogs get their own Escape first.
      if (document.querySelector('.popover, .menu, .dialog')) return;
      e.preventDefault();
      if (!hydrated.current) return void native.win.miniHide();
      void native.win.quickChatSave(current.current).then(
        () => native.win.miniHide(),
        () => native.win.miniHide(),
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = async () => {
    if (!ready || submitting.current || !usable || !text.trim()) return;
    submitting.current = true;
    setSending(true);
    setError(null);
    try {
      const id = await sender.current.submit(
        text,
        threadId,
        async (seed) => {
          resetNewChatDefaults();
          clearNewChatProject();
          const id = await createChatThread(seed);
          if (!id) throw new Error('Could not start chat. Check your harness and sign-in.');
          current.current = { threadId: id, text };
          await save();
          return id;
        },
        // a message main used makes its chat the last used, as one sent from the main window does
        (id, value, requestId) =>
          chatProxy.send(id, value, [], { human: true }, getState().prefs.followUp, requestId).then((receipt) => {
            if (usedReceipt(receipt)) rememberUsedChat(id, chatKind(id));
            return receipt;
          }),
      );
      // never null here: submit already checked the text, and `submitting` keeps the sender free
      setText('');
      current.current = { threadId: id, text: '' };
      await save();
    } catch (e) {
      setError(errorText(e));
    } finally {
      submitting.current = false;
      setSending(false);
      input.current?.focus();
    }
  };

  // New chat is disabled while sending and with nothing to clear (no chat, draft or error); Open in app while sending and without a chat
  const fresh = async () => {
    setError(null);
    if (!(await saved({ threadId: null, text: '' }))) return;
    resetNewChatDefaults();
    applyNewChatDefault();
    clearNewChatProject();
    navigate({ name: 'home' });
    setText('');
    input.current?.focus();
  };
  const open = async () => {
    setError(null);
    if (!(await saved())) return;
    const result = await native.win.quickChatOpen(threadId!).catch((e: unknown) => ({ ok: false as const, error: errorText(e) }));
    if (!result.ok) setError(result.error ?? 'Could not open chat');
  };

  return (
    <div className="quick-chat">
      {/* Only the title and the empty space drag the window: a drag region over a button can swallow its clicks. */}
      <header className="quick-chat-header">
        <span className="quick-chat-title quick-chat-drag">Quick Chat</span>
        {/* asking MoMo: its brain, never the coding Quick Chat's model (#2288) */}
        {ask.on ? <AskMomoBrain /> : ready && <ModelPicker threadId={threadId} />}
        <div className="quick-chat-spacer quick-chat-drag" />
        <div className="quick-chat-actions">
          <AskMomoToggle ask={ask} />
          <button
            className="icon-btn"
            aria-label="New chat"
            title="New chat"
            disabled={!ready || sending || (!threadId && !text && !error)}
            onClick={fresh}
          >
            <Plus size={16} />
          </button>
          <button className="icon-btn" aria-label="Open in app" title="Open in app" disabled={!threadId || sending} onClick={open}>
            <ArrowUpRight size={16} />
          </button>
          <button className="icon-btn" aria-label="Hide Quick Chat" title="Hide" onClick={hide}>
            <X size={16} />
          </button>
        </div>
      </header>
      {ask.on ? (
        <AskMomoPane />
      ) : (
        <>
          {threadId ? (
            <ThreadView threadId={threadId} inPane composer={false} />
          ) : (
            <div className="quick-chat-empty">
              {!ready
                ? 'Starting…'
                : checking && !usable
                  ? 'Checking harnesses…'
                  : !usable
                    ? 'Sign in to a harness to start chatting.'
                    : 'What can I help with?'}
            </div>
          )}
          <div className="quick-chat-compose" data-composer-chat={threadId ?? ''}>
            {error && (
              <div className="quick-chat-error" role="alert">
                {error}
              </div>
            )}
            {threadId && <QueuedList threadId={threadId} />}
            <div className="quick-chat-input-row">
              <textarea
                ref={input}
                className="quick-chat-input"
                aria-label="Message"
                placeholder="Ask anything"
                value={text}
                {...busyField(!ready || sending || !usable)}
                onChange={(e) => {
                  const value = e.target.value;
                  setText(value);
                  current.current = { threadId, text: value };
                  void saved();
                }}
                onKeyDown={(e) => {
                  if (
                    quickChatSends(
                      { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing },
                      prefs.sendWith,
                      isMac,
                    )
                  ) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
              {running && !text.trim() ? (
                <button
                  className="quick-chat-send"
                  aria-label="Stop"
                  title="Stop"
                  onClick={() => void liveAction(interrupt(threadId!, running), setError).catch((e) => setError(errorText(e)))}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="quick-chat-send"
                  aria-label="Send"
                  disabled={!ready || sending || !usable || !text.trim()}
                  onClick={submit}
                >
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </>
      )}
      <AccountSignInDialog />
      <Toasts />
    </div>
  );
}
