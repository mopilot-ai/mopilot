// Settings → General → Language: which language the interface shows; main renames the menus (electron/app/language.cjs).
import { useState } from 'react';
import { Row, Select } from './Controls';
import { useStore, setPrefs } from '../../../store/core';
import { hasUnsentDraft } from '../../../store/unsentDraft';
import { LANGUAGES, SYSTEM_LANGUAGE } from '../../../../shared/i18n/languages.mjs';

/** A window changes language only when it opens, so reloading this one is the person's to ask: it ends its terminals' commands. */
export function LanguageRow() {
  const language = useStore((s) => s.prefs.interfaceLanguage);
  const [picked, setPicked] = useState(false);
  const held = useStore((s) => picked && hasUnsentDraft(s));
  return (
    <Row
      title="Language"
      desc="The language of menus, buttons and messages; your chats aren't translated. Menus change now, and a window changes when it next opens."
    >
      {picked && (
        <button
          className="btn-pill soft"
          disabled={held}
          title={held ? 'Send or clear your draft first' : "Stops commands running in this window's terminal"}
          onClick={() => location.reload()}
        >
          Reload window
        </button>
      )}
      <Select
        value={language}
        options={[{ value: SYSTEM_LANGUAGE, label: 'Automatic' }, ...LANGUAGES.map((l) => ({ value: l.tag, label: l.name }))]}
        onChange={(v) => {
          setPrefs({ interfaceLanguage: v });
          setPicked(true);
        }}
      />
    </Row>
  );
}
