// The switch sheet's control lines (docs/control-plane/design.md, ControllerPlan): what a switch would change about who controls the in-app browser, the computer and the user's Chrome, as main decides it.
import { useEffect, useState } from 'react';
import { native } from '../lib/native';
import { ignoring } from '../lib/ignored';

/** One line per surface whose controller a switch of the chat to `target` changes; none until main answers, and none if it can't. */
export function useControllerChanges(chatId: string, target: string): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    // another chat or target: the previous one's lines go until main answers for this one
    setLines([]);
    native.session.controllerChanges(chatId, target).then(
      (l) => live && setLines(l),
      // the sheet still switches; it just doesn't list the changes
      ignoring('read what a harness switch changes about who controls each surface'),
    );
    return () => {
      live = false;
    };
  }, [chatId, target]);
  return lines;
}
