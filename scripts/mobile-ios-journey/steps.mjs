// DEV ONLY: the steps of the iOS journey, in order: what a person does with the phone app against the dev host, and what must be on screen after each.
// Each step is a name and a function of { wda, host, relaunch }; the labels are the app's accessibility labels.

/** The digits of a safety number, whatever the grouping or the words around them. */
export const digits = (/** @type {string} */ text) => text.replace(/\D/g, '');

/** The safety number the phone shows, from the labels on screen: its card is labelled "Safety number" and the digits spoken one by one ("" when it is not there). */
export const safetyNumberOf = (/** @type {string[]} */ labels) =>
  digits(labels.find((label) => /^Safety number [\d ]+$/.test(label)) ?? '');

/** @typedef {{ wda: import('./wda.mjs').Wda, host: import('./host.mjs').JourneyHost, relaunch: () => Promise<void> }} Ctx */

/** The name this run gives its phone when it pairs, so the Mac can be told to revoke that phone and no other (the host replaces an earlier pairing of the same name in place, so the newest is not always last). */
export const phoneName = `Journey ${Date.now() % 100_000}`;
const HOME = 'Open chat Clean up the generated files';
const CONNECTED = ', Connected';

/** Pairs with the dev host: pastes a fresh code, compares the safety number on both screens, then lets the Mac allow it. */
async function pair(/** @type {Ctx} */ { wda, host }) {
  const code = await host.newPairingCode();
  const since = host.mark();
  // 1.0.1 opens the camera at sign-in: its permission prompt can already be up, and nothing else may be touched behind it
  await wda.acceptAlert();
  // on first run the sheet is already open; later it opens from the empty state
  await wda.whenPresent('Add a computer', async () => wda.tap('Add a computer'), { exact: true });
  // build 19 opens on the steps, where Look for my computer goes on to the camera; 1.0.1 opens on the camera at once. The first time the system asks for it either way
  await wda.waitForAny(['Look for my computer', 'Paste code instead']);
  await wda.whenPresent('Look for my computer', async () => {
    await wda.tapUntil('Look for my computer', 'Paste code instead');
  });
  await wda.acceptAlert();
  await wda.waitFor('Paste code instead');
  await wda.tapUntil('Paste code instead', 'Paste pairing code');
  await wda.fill('Paste pairing code', code);
  // 1.0.1 keeps the phone's name behind Advanced; build 19 shows the field under the code. With the keyboard up the name field is under it as well
  await wda.whenPresent(
    'Advanced',
    async () => {
      await wda.scrollTo('Advanced');
      await wda.tap('Advanced');
    },
    { exact: true },
  );
  await wda.scrollTo('Phone name');
  await wda.fill('Phone name', phoneName);
  // with the keyboard up Connect is under its edge: scroll the form to it rather than tapping around to put the keyboard away
  await wda.scrollTo('Connect');
  await wda.tap('Connect');
  await wda.waitFor('Confirm on your computer');
  // 1.0.1 keeps the number behind Check the number; build 19 shows it
  await wda.whenPresent('Check the number', async () => wda.tap('Check the number'), { exact: true });
  await wda.waitFor('Safety number');
  const phone = safetyNumberOf(await wda.labels());
  const mac = digits((await host.waitLog(/the phone shows safety number ([\d -]+)\./, { since }))[1]);
  if (phone !== mac || phone === '') throw new Error(`the safety numbers differ: the phone shows ${phone || 'none'}, the Mac ${mac}`);
  host.send('y');
  // a fresh pairing connects by itself
  await wda.waitFor(HOME, { timeoutMs: 30_000 });
}

/** Opens a chat from the list and goes back to the list at the end of the step that uses it. */
const back = async (/** @type {Ctx} */ { wda }) => wda.tap('Back to chats');

/** @type {{ name: string, run: (ctx: Ctx) => Promise<void> }[]} */
export const steps = [
  {
    name: 'launch',
    run: async ({ wda, relaunch }) => {
      await relaunch();
      // by id: "Settings" is also a word in the welcome text
      await wda.waitForAny(['Sign in', 'Add a computer', 'Look for my computer', 'Settings', 'Remove unfinished pairing'], {
        timeoutMs: 60_000,
        exact: true,
      });
      // a run that stopped in the middle of pairing leaves its card behind
      await wda.whenPresent('Remove unfinished pairing', async () => wda.tap('Remove unfinished pairing'));
    },
  },
  {
    name: 'sign-out',
    run: async ({ wda }) => {
      await wda.whenPresent(
        'Settings',
        async () => {
          await wda.tap('Settings');
          await wda.tap('Sign out');
        },
        { exact: true },
      );
      await wda.waitFor('Sign in');
    },
  },
  {
    name: 'sign-in',
    run: async ({ wda }) => {
      await wda.tap('Sign in');
      await wda.sleep(3000);
      await wda.acceptAlert();
      await wda.waitForAny(['Add a computer', 'Look for my computer'], { timeoutMs: 30_000 });
      // the sign-in sheet is still closing; a tap during that is lost
      await wda.sleep(2500);
    },
  },
  { name: 'pair-with-safety-number', run: pair },
  {
    name: 'connect-and-list',
    run: async ({ wda }) => {
      await wda.waitFor(HOME, { timeoutMs: 30_000 });
      await wda.waitFor('NEEDS YOU');
      await wda.waitFor('PROJECTS');
    },
  },
  {
    name: 'search',
    run: async ({ wda }) => {
      // the search field waits behind its icon beside the title
      await wda.tapUntil('Search chats', 'Close search');
      await wda.fill('Search chats', 'discount');
      await wda.waitFor('Open chat Fix the discount rounding in checkout');
      await wda.waitGone('Open chat Summarize the README');
      await wda.fill('Search chats', '');
      await wda.waitFor('Open chat Summarize the README');
      // closing the search puts the keyboard away with it
      await wda.tap('Close search');
    },
  },
  {
    name: 'open-chat-with-approval-card',
    run: async ({ wda }) => {
      // a chat that waits for the user opens a sheet first (its question and answers, Open chat, Close); the chat is entered from there
      await wda.tap(HOME);
      await wda.waitFor('Run this command?');
      await wda.waitFor('Allow once');
      await wda.waitFor('Deny');
      await wda.tap('Open chat');
      await wda.waitFor('Back to chats');
      await wda.waitFor('Run this command?');
    },
  },
  {
    name: 'changes-and-diff',
    run: async ({ wda }) => {
      // the chat's other screens are in its ⋯ menu (an action sheet)
      await wda.tapUntil('Chat menu', 'Changes');
      await wda.tap('Changes');
      await wda.tap('View diff src/price.ts');
      await wda.waitFor('Removed, line 3');
      await wda.tap('Back to changes');
      await wda.waitFor('View diff src/price.ts');
      await wda.tap('Back to chat');
    },
  },
  {
    name: 'terminal',
    run: async ({ wda }) => {
      await wda.tapUntil('Chat menu', 'Terminal');
      await wda.tap('Terminal');
      await wda.tap('Type a command');
      // the command shows its own text, so only the shell's answer can contain "journey-42"
      await wda.type('echo journey-$((6*7))');
      await wda.tap('Run');
      await wda.waitFor('journey-42');
      await wda.tap('Back to chat');
    },
  },
  { name: 'back-to-list', run: back },
  {
    name: 'send-a-message',
    run: async ({ wda }) => {
      await wda.tap('Open chat Fix the discount rounding in checkout');
      await wda.tap('Message this chat');
      await wda.type('journey ping');
      await wda.tap('Send message');
      // the message is listed once the Mac has taken it; its scripted turn then asks for an approval, unless it has already run
      await wda.waitFor('journey ping', { timeoutMs: 30_000 });
      await wda.sleep(3000);
      // left unanswered, the chat would be a Needs-you row for the next run
      await wda.whenPresent('Allow once', async () => {
        // the keyboard is still up after a send: the card has to be above it to be tapped
        await wda.scrollTo('Allow once');
        await wda.tap('Allow once');
        await wda.waitFor('answered on this iPhone');
      });
      await wda.tap('Back to chats');
    },
  },
  {
    name: 'plan-sheet',
    run: async ({ wda, host }) => {
      host.send('run plan');
      await wda.sleep(1000);
      await wda.pullDown();
      await wda.tap('Open chat [bench] plan', { timeoutMs: 30_000 });
      // the plan is answered in the sheet a waiting chat opens, which then says so; the chat is entered from it and left again
      await wda.waitFor('Approve plan');
      await wda.tap('Approve plan');
      await wda.waitFor('answered on this iPhone');
      await wda.tap('Open chat');
      await wda.tap('Back to chats');
    },
  },
  {
    name: 'new-chat-with-approval',
    run: async ({ wda }) => {
      await wda.tap('New chat');
      await wda.fill('What should it do?', 'journey new chat');
      await wda.tap('Start chat');
      await wda.waitFor('Run this command?', { timeoutMs: 30_000 });
      await wda.scrollTo('Allow once');
      await wda.tap('Allow once');
      await wda.waitFor('answered on this iPhone');
      await wda.tap('Back to chats');
    },
  },
  {
    name: 'settings-and-notifications',
    run: async ({ wda }) => {
      await wda.tap('Settings');
      await wda.waitFor('Notifications');
      await wda.whenPresent('Turn on notifications', async () => {
        await wda.tap('Turn on notifications');
        await wda.sleep(2000);
        await wda.acceptAlert();
      });
      await wda.tap('Chats');
      await wda.waitFor(CONNECTED);
    },
  },
  {
    name: 'background-and-foreground',
    run: async ({ wda }) => {
      await wda.background();
      await wda.sleep(4000);
      await wda.foreground();
      await wda.waitFor(CONNECTED, { timeoutMs: 40_000 });
    },
  },
  {
    name: 'kill-and-relaunch-auto-connects',
    run: async ({ wda, relaunch }) => {
      await relaunch();
      await wda.waitFor(CONNECTED, { timeoutMs: 60_000 });
    },
  },
  {
    name: 'mac-drops-and-recovers',
    run: async ({ wda, host }) => {
      // long enough for the phone to notice (it shows the computer away only after a few seconds), and for the Mac's backoff to bring it back
      // the phone has only just reconnected: let it settle first (a Mac that drops within a second of the phone's hello is a different, rarer case)
      await wda.sleep(6000);
      host.send('run unplug 25');
      await wda.waitGone(CONNECTED, { timeoutMs: 40_000 });
      await wda.waitFor(CONNECTED, { timeoutMs: 90_000 });
    },
  },
  {
    name: 'load-more-chats',
    run: async ({ wda, host }) => {
      const added = host.mark();
      host.send('run chats 120');
      await host.waitLog(/chats added/, { since: added });
      await wda.pullDown();
      await wda.scrollTo('Load more chats');
      const asked = host.mark();
      await wda.tap('Load more chats');
      await host.waitLog(/"offset":50/, { since: asked });
      await wda.scrollTo('Open chat Bulk chat 60');
    },
  },
  {
    name: 'revoke-and-re-pair',
    run: async ({ wda, host, relaunch }) => {
      // the Mac numbers its phones in its own order: find this run's by the name it paired under
      const listed = host.mark();
      host.send('s');
      const entries = (await host.waitLog(/paired: (.+)/, { since: listed }))[1].split('), ');
      const index = entries.findIndex((entry) => entry.startsWith(`${phoneName} (`)) + 1;
      if (index === 0) throw new Error(`the Mac does not list a phone named ${phoneName}: ${entries.join('), ')}`);
      host.send(`run revoke ${index}`);
      await wda.waitFor('Add a computer', { timeoutMs: 40_000 });
      await pair({ wda, host, relaunch });
    },
  },
];
