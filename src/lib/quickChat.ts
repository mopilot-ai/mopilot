// Quick Chat sends from the renderer: one acknowledged send at a time, retried with the same request id.

/** One acknowledged send at a time. A failure retains both the thread and draft for retry. */
export class QuickChatSender {
  private busy = false;
  private retry: { text: string; threadId: string | null; requestId: string } | null = null;
  async submit(
    text: string,
    threadId: string | null,
    create: (text: string) => Promise<string>,
    send: (id: string, text: string, requestId: string) => Promise<unknown>,
  ) {
    if (this.busy || !text.trim()) return null;
    this.busy = true;
    try {
      const value = text.trim();
      if (!this.retry || this.retry.text !== value || this.retry.threadId !== threadId) {
        this.retry = { text: value, threadId, requestId: crypto.randomUUID() };
      }
      const id = threadId ?? (await create(value));
      this.retry.threadId = id;
      await send(id, value, this.retry.requestId);
      this.retry = null;
      return id;
    } finally {
      this.busy = false;
    }
  }
}

export function quickChatSends(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean },
  sendWith: string,
  mac: boolean,
) {
  return (
    e.key === 'Enter' &&
    !e.shiftKey &&
    !e.isComposing &&
    (sendWith === 'cmdEnter' ? (mac ? e.metaKey : e.ctrlKey) : !e.metaKey && !e.ctrlKey)
  );
}
