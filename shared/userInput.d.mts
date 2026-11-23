/** One input item (Codex's UserInput shape): a text, an image, an audio file, a skill or a mention. */
export type UserInputItem = { type: string; [key: string]: unknown };

export function userInput(
  text: string,
  attachments?: ReadonlyArray<object>,
  o?: { tabsFor?: 'codex-browser-plugin' | 'text' },
): UserInputItem[];
export declare const hasSkill: (attachments: unknown) => boolean;
