// The real work behind setup's "Setting up" screen (#2607), in order: MoMo's brain applied, its memory read (which makes its files), the starter routines proposed (not the Morning briefing: the Morning brief replaces it; they wait in Settings › MoMo › Routines), setup marked done, and, the first time, MoMo's hello in its main chat. A step that fails stops the run with its message, and the screen offers a retry that goes on from the top; only the hello is best effort.
import { MOMO_SETUP_STARTERS, type MomoRoleBrain } from '../../../../shared/momoPrefs.mjs';
import { momoChatBridge, momoMemoryBridge } from '../../../lib/momoBridges';
import { saveMomoPref } from '../../../session/momoPrefs';
import { native } from '../../../lib/native';
import { brainChangeNote } from '../settings/brainNotes';
import { toast, toastFailure } from '../../../store/core';

/** The progress screen's lines, one per step runSetup reports. */
export const SETUP_STEPS = ['Picked a brain with room to think', 'Getting its memory ready', 'Almost done'] as const;

/** A save that was refused: main's own message already reached the user in a toast. */
const SAVE_FAILED = "Couldn't save MoMo's settings.";

export interface SetupRun {
  /** the brain chosen for the user (null: nothing signed in can run MoMo, or none to apply) */
  brain: MomoRoleBrain | null;
  /** the first time through: MoMo says hello (setup run again from Settings doesn't) */
  first: boolean;
  /** the step now running, 0-based */
  onStep: (index: number) => void;
}

export async function runSetup({ brain, first, onStep }: SetupRun): Promise<void> {
  onStep(0);
  const chat = momoChatBridge();
  if (brain && chat) {
    const note = brainChangeNote(await chat.setBrain(brain));
    if (note) toast(note.text, note.kind);
  }
  onStep(1);
  const memory = await momoMemoryBridge()?.files();
  if (memory && !memory.ok) throw new Error(memory.error);
  onStep(2);
  if (!(await saveMomoPref('routines.starter', [...MOMO_SETUP_STARTERS]))) throw new Error(SAVE_FAILED);
  if (!(await saveMomoPref('onboarding', { done: true, step: 0 }))) throw new Error(SAVE_FAILED);
  // MoMo's Chat is now the page; its first words are best effort
  if (first)
    await Promise.resolve()
      .then(() => native.momoChat.greet())
      .catch(toastFailure("MoMo couldn't say hello"));
}
