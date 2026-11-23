// Settings → Browser → Storage (IAB-08): where the built-in browser keeps cookies, storage and cache for
// a chat's tabs, for every harness (shared/browserStorage.mjs, electron/capabilities/browser/storage.cjs).
// "Shared" is one persistent profile for every chat; "This chat only" gives each chat its own in-memory
// storage, cleared when the chat ends. A tab keeps the storage it opened with.
import { setPrefs, toast, useStore } from '../../../store/core';
import { storageMode } from '../../../../shared/browserStorage.mjs';
import { Row, Select } from '../Settings';

const OPTIONS: { value: 'shared' | 'session'; label: string }[] = [
  { value: 'shared', label: 'Shared by all chats' },
  { value: 'session', label: 'This chat only' },
];

export function BrowserStorageRow() {
  const mode = storageMode(useStore((s) => s.prefs.browserStorage));
  return (
    <Row
      title="Storage"
      desc={
        mode === 'session'
          ? "Each chat's tabs get their own cookies and site data, cleared when the chat ends."
          : 'Every chat shares one profile, so sign-ins carry over between chats.'
      }
    >
      <Select
        value={mode}
        options={OPTIONS}
        onChange={(v: 'shared' | 'session') => {
          setPrefs({ browserStorage: v });
          toast('Applies to browser tabs opened from now on');
        }}
      />
    </Row>
  );
}
