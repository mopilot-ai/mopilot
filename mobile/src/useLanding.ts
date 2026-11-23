// Where the phone lands once it has paired a computer: the new-chat page for that computer with the keyboard up, so the first message is type and Send (#5320), not a list to find a chat in.
import { useEffect, useState } from 'react';

/** `creating`: the new-chat page is open. `open` opens it. `arrive` opens it for a computer this phone just paired, and `focus` says the field takes the keyboard until the page is left. */
export function useLanding(creating: boolean, open: () => void) {
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (!creating) setLanded(false);
  }, [creating]);
  return {
    focus: landed && creating,
    arrive: () => {
      setLanded(true);
      open();
    },
  };
}
