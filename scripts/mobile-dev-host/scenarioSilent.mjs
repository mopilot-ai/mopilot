// DEV ONLY: the `silent-row` scenario: the Mac's chat gains a message and its answer with no live event sent, as when the live feed to a phone drops, so the phone's net under the live events (re-reading an open chat) can be seen doing its work.

/** @param {{ chats: Map<string, any>, row: (chat: any, role: string, text: string) => void }} app @param {() => number} now */
export function silentScenario(app, now) {
  return {
    usage: 'silent-row [chat] [text]',
    about:
      'the chat (the newest when none is named) gains a message and its answer WITHOUT a live event: an open chat on the phone does not show them until its own re-read (a few seconds while a turn runs, 8 s when idle) or until it is left and opened again',
    run: (/** @type {string[]} */ args) => {
      const [id, ...words] = args;
      const chat = id ? app.chats.get(id) : [...app.chats.values()].sort((a, b) => b.at - a.at)[0];
      if (!chat) throw new Error(id ? `No chat ${id}. Say run chats to see them.` : 'There is no chat.');
      const text = words.join(' ') || 'Sent from the Mac';
      app.row(chat, 'user', text);
      app.row(chat, 'assistant', `Got it: ${text}`);
      chat.at = now();
      return `chat ${chat.id}: two rows stored, no live event sent; an open chat on the phone shows them after its re-read`;
    },
  };
}
