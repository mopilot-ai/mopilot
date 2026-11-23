// Settings → Quick Chat.

import { Group, Row, Toggle } from './Controls';
import { shortcutLabel } from '../../../lib/platform';
import { useStore, setPrefs, toast } from '../../../store/core';
import { native } from '../../../lib/native';

/* ------------------------------------------------------------------ */
/* Mini                                                                */
/* ------------------------------------------------------------------ */
export function MiniSettings() {
  const prefs = useStore((s) => s.prefs);
  return (
    <Group>
      <Row title="Quick Chat shortcut" desc={shortcutLabel('⌥Space')}>
        <Toggle
          on={prefs.miniShortcut}
          onChange={async (v) => {
            const registered = await native.win.miniShortcut(v);
            if (registered === false && v) return toast(`${shortcutLabel('⌥Space')} is already in use`, 'error');
            setPrefs({ miniShortcut: v });
          }}
        />
      </Row>
      <Row title="Quick Chat">
        <button className="btn-pill soft" onClick={() => native.win.mini()}>
          Open Quick Chat
        </button>
      </Row>
    </Group>
  );
}
