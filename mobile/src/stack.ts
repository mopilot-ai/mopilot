// The open screens as a native stack: which screen sits on which, derived from the app's navigation state.

export type RouteKind =
  | 'home'
  | 'pairing'
  | 'settings'
  | 'momo'
  | 'scheduled'
  | 'newChat'
  | 'starting'
  | 'answer'
  | 'chat'
  | 'review'
  | 'terminal';
/** A chat's own screens, pushed over the chat. */
export type ChatTop = 'review' | 'terminal';
/** A chat and its screens carry the chat they belong to. */
type PlainKind = Exclude<RouteKind, 'chat' | ChatTop>;
/** One member per kind, so checking the kinds one by one narrows to the routes that remain. */
export type Route =
  | { [K in PlainKind]: { kind: K; key: string; sheet?: true } }[PlainKind]
  | {
      [K in 'chat' | ChatTop]: {
        kind: K;
        key: string;
        chatId: string;
        sheet?: undefined;
      };
    }['chat' | ChatTop];

/** What is open; each flag already accounts for the connection phase (a closed one is false). */
export type NavState = {
  momo: boolean;
  settings: boolean;
  newChat: boolean;
  /** Start was tapped and the computer has not said which chat it is: the chat's page, over New chat */
  starting?: string;
  scheduled: boolean;
  /** the waiting chat whose requests are being answered in the quick review sheet */
  answer: string | null;
  /** the open chat, shown live or as its offline page */
  chat: string | null;
  /** the chats under the open one, oldest first, when it was opened from its parent's sub-session card */
  trail?: string[];
  /** the chat's screen over it, only while the computer is connected */
  top: ChatTop | null;
  pairing: boolean;
};

const home: Route = { kind: 'home', key: 'home' };

/**
 * The stack, bottom first. The home list is always at the bottom, so going back from anything lands there, and a
 * swipe back reveals it. One flow is open at a time, in the order the app always gave them precedence.
 */
export function stackOf(nav: NavState): Route[] {
  if (nav.momo) return [home, { kind: 'momo', key: 'momo' }];
  if (nav.settings) return [home, { kind: 'settings', key: 'settings', sheet: true }];
  if (nav.newChat) {
    const sheet: Route = { kind: 'newChat', key: 'newChat', sheet: true };
    // New chat stays under the starting page, so a refusal lands on it with its text, files and picks
    return nav.starting ? [home, sheet, { kind: 'starting', key: `starting:${nav.starting}` }] : [home, sheet];
  }
  if (nav.scheduled) return [home, { kind: 'scheduled', key: 'scheduled' }];
  // one sheet for the whole review: moving on to the next waiting chat changes what it shows, not the sheet
  if (nav.answer) return [home, { kind: 'answer', key: 'answer', sheet: true }];
  if (nav.chat) {
    const chatId = nav.chat;
    const chat: Route = { kind: 'chat', key: `chat:${chatId}`, chatId };
    const parents: Route[] = (nav.trail ?? []).map((id) => ({ kind: 'chat', key: `chat:${id}`, chatId: id }));
    return nav.top ? [home, ...parents, chat, { kind: nav.top, key: `${nav.top}:${chatId}`, chatId }] : [home, ...parents, chat];
  }
  if (nav.pairing) return [home, { kind: 'pairing', key: 'pairing', sheet: true }];
  return [home];
}
