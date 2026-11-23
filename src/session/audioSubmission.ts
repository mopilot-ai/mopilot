// Audio submissions retire when their account, model, recipient or material configuration changes before admission.
import type { AppState } from '../store/state';
export function audioSubmissionOwner(s: AppState) {
  return JSON.stringify([
    s.accounts?.active,
    s.claudeAccounts?.active,
    s.prefs.model,
    s.prefs.effort,
    s.prefs.serviceTier,
    s.prefs.permission,
    s.prefs.claudeSelection,
  ]);
}

import { native } from '../lib/native';
import { get as getState } from '../store/core';
import { withTimeout, timedOut } from '../lib/localSpeech';
import { ignoring } from '../lib/ignored';
import type { Attachment } from '../store/types';
import type { CapsHint } from '../store/session/capsTypes';

export async function prepareAudioSubmission(
  key: string,
  text: string,
  attachments: Attachment[],
  chatId: string | null,
  hint: CapsHint | undefined,
  current: () => boolean,
) {
  const owner = audioSubmissionOwner(getState());
  let retired = false;
  const holding = native.speech.hold(key, { text, attachments }, chatId, hint).then((id) => {
    if (retired) void native.speech.finishTransfer(id).catch(ignoring('retire a timed-out audio transfer'));
    return id;
  });
  const id = await withTimeout(holding, 10_000);
  if (timedOut(id)) {
    retired = true;
    throw new Error('Audio storage did not respond. Your draft is kept.');
  }
  if (!current() || owner !== audioSubmissionOwner(getState())) {
    void native.speech.finishTransfer(id).catch(ignoring('retire an obsolete audio transfer'));
    return null;
  }
  return id;
}
