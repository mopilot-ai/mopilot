// Tells main whether a composer in this window holds a draft not yet sent, so the app never restarts into an update by itself under it (electron/app/stealthUpdate.cjs).
import { useStore } from './core';
import { hasUnsentDraft } from './unsentDraft';
import { native } from '../lib/native';
import { noteIgnored } from '../lib/ignored';

let reported = false;
useStore.subscribe((s, prev) => {
  if (s.drafts === prev.drafts) return;
  const has = hasUnsentDraft(s);
  if (has === reported) return;
  reported = has;
  native.app.unsent(has).catch((error) => noteIgnored('tell main whether this window holds an unsent draft', error));
});
