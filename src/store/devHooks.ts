// Dev-only window hooks: automation drives the live store through window.__codex, and a hot update reloads the window,
// since a re-run store module would start a store that never reconnects. src/main.tsx imports this before the app.
import { selectionAttachment } from '../lib/annotations';
import { codexApi } from '../harness/adapters/codexApi';
import { set, get, setPrefs, toast } from './core';
import { nativeOf, chatOf } from './chats';
import { loadArchived } from './connection';
import { sendMessage, interrupt } from './send';
import { navigate } from './panes';
import { openSideChat, archiveThread, unarchiveThread, renameThread, forkThread, deleteThread } from './actions';
import { resolveRequest } from './notifications';

/** The dev-only globals below. */
type DevWindow = Window & { __codex?: unknown; __sageStoreLoaded?: boolean };
// Dev/test hook: lets automation drive the live store instance. Read when asked for, not when this loads: the store's
// modules import each other, so a binding may not be initialized yet while this module runs.
if (import.meta.env.DEV)
  Object.defineProperty(window, '__codex', {
    configurable: true,
    get: () => ({
      navigate,
      setState: set,
      getState: get,
      setPrefs,
      sendMessage,
      resolveRequest,
      interrupt,
      toast,
      nativeOf,
      chatOf,
      openSideChat,
      selectionAttachment,
      archiveThread,
      unarchiveThread,
      renameThread,
      forkThread,
      deleteThread,
      loadArchived,
      codexApi,
    }),
  });

// Dev only: the store owns the app-server connection, so a hot update must reload the window
// (a re-executed module would start a fresh store that never reconnects).
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
// A hot update can also re-import this module under a new URL from another boundary (e.g. App.tsx),
// without calling the accept callback above. A second instance in the same page never boots,
// so reload instead of letting the UI bind to it.
if (import.meta.env.DEV) {
  if ((window as DevWindow).__sageStoreLoaded) location.reload();
  (window as DevWindow).__sageStoreLoaded = true;
}
