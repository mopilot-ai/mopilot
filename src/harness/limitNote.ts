// What a chat that ran out of quota says (src/store/chats.ts): the switch to the other first-tier harness only where it
// can run, else what can be done instead, so the note never promises a way on the user doesn't have.
export function limitNoteText(from: string, other: string, canSwitch: boolean): string {
  return canSwitch
    ? `${from} limit reached. You can switch to ${other} and continue in this chat.`
    : `${from} limit reached. Set up ${other} in Settings to continue in this chat, or try again when the limit resets.`;
}
