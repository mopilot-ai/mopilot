// DEV ONLY: the `long-history` and `links` scenarios: a chat with a very long saved history (plain, rich, or a long finished Claude Code style chat with and without code blocks and tables), and one reply with every kind of link.
import { EDGE_USER, LINKS_REPLY, edgeReply, insightReply, richReply } from './fakeData.mjs';

/**
 * @param {ReturnType<typeof import('./fakeApp.mjs').createFakeApp>} app
 * @param {(name: string, prompt: string, harness?: string) => any} chatFor a chat of its own for a scenario, with the message that "started" it
 * @param {(text: string | undefined, fallback: number, max: number) => number} toNumber
 */
export function historyScenarios(app, chatFor, toNumber) {
  return {
    'long-history': {
      usage: 'long-history [rows=500] [rich|insight|plain|edges]',
      about:
        'a chat with a very long saved history; `rich` makes the replies code blocks, tables and lists in turn; `edges` is a Claude Code chat of odd shapes for a native text view (empty headings, list items, links and table cells, a URL straight against CJK text, breaks, a code-only line; #5368); `insight` is a long finished Claude Code style chat (insight lines, headings, bullets, a rule, a link, a code block and a table in every reply) and `plain` the same with no code block or table (#5351)',
      run(/** @type {string[]} */ args) {
        const [rows, mode] = args;
        const count = toNumber(rows, 500, 20_000);
        const claude = mode === 'insight' || mode === 'plain' || mode === 'edges';
        const chat = claude
          ? chatFor(`long ${mode}`, 'Start of a long conversation.', 'claude')
          : chatFor('long history', 'Start of a long conversation.');
        for (let i = 1; i < count; i++) {
          const kind = i % 3;
          const reply =
            mode === 'rich'
              ? richReply(i + 1, count)
              : mode === 'edges'
                ? edgeReply(Math.floor(i / 3))
                : claude
                  ? insightReply(i + 1, count, mode === 'insight')
                  : null;
          app.row(
            chat,
            kind === 0 ? 'user' : kind === 1 ? 'assistant' : 'step',
            kind === 1 && reply
              ? reply
              : kind === 0 && mode === 'edges'
                ? EDGE_USER
                : `${kind === 2 ? 'Ran step' : 'Message'} ${i + 1} of ${count}`,
          );
        }
        return `chat ${chat.id}: ${count} saved rows; open it and scroll to the top`;
      },
    },
    links: {
      usage: 'links',
      about:
        'a chat with one reply holding a bare URL, a Markdown link, a link that wraps over two lines and links in a list, to tap and long-press (#5358)',
      run() {
        const chat = chatFor('links', 'Show me every kind of link.', 'claude');
        app.row(chat, 'assistant', LINKS_REPLY);
        return `chat ${chat.id}: one reply with five links; tap and long-press each on the phone`;
      },
    },
  };
}
