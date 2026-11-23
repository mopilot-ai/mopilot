// Whether the thread around it shows MoMo's replies as whole bubbles (M0b, the shell on): a reply that is still arriving is not drawn until it is complete, and the chat's header says "Thinking it through" meanwhile. Off everywhere else, so coding chats keep their streaming; MoMo's Chat provides it only with `momo.shell` on.
import { createContext, useContext } from 'react';

export const WholeReplies = createContext(false);

/** Whether a reply that is still arriving waits for its end before it is drawn. */
export const useWholeReplies = () => useContext(WholeReplies);
