// DEV ONLY: the `side-chat` scenario: finished replies to select words in, on a Claude Code chat (a side chat can be started from it) and on a basic (ACP) agent's chat (no temporary fork: the entry is greyed with the reason).

const REPLY =
  'The total multiplies before it rounds, so a 10% discount on three items drifts by a cent.\n\nRound once, at the end, to two decimals.';

/** @param {{ add: (chat: any) => any, row: (chat: any, role: string, text: string) => void, counter: () => number }} app @param {() => number} now */
export function sideChatScenario(app, now) {
  return {
    usage: 'side-chat',
    about:
      'two finished replies to select words in: one on Claude Code (Start a side chat works; asking again from the same chat reopens the same side chat) and one on a basic agent (the entry is greyed, "Not for this agent")',
    run() {
      const make = (/** @type {string} */ title, /** @type {string} */ harness, /** @type {number} */ ago) => {
        const chat = app.add({ id: `dev-bench-${app.counter()}`, title: `[bench] ${title}`, harness, at: now() - ago });
        app.row(chat, 'user', 'Why does the total drift?');
        app.row(chat, 'assistant', REPLY);
        return chat;
      };
      const claude = make('side chat: Claude Code', 'claude', 10);
      const basic = make('side chat: basic agent', 'acp:gemini', 20);
      return `chats ${claude.id} (Claude Code) and ${basic.id} (basic agent): select words in the reply; a machine chat needs the host started with --fake-hosts`;
    },
  };
}
