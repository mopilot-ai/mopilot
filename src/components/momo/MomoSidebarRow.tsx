// MoMo's sidebar row between New chat and Search, as ChatGPT's dot sits: its donut and name, opening MoMo; ⌘. itself is bound by MomoRoute so it works with the sidebar closed. Renders nothing unless the account was invited (src/lib/momo.ts).
import { useMomoAllowed } from '../../lib/momo';
import { shortcutLabel } from '../../lib/platform';
import { useMomoPrefs } from '../../session/momoPrefs';
import { navigate } from '../../store/panes';
import { useStore } from '../../store/core';
import type { MomoColor } from '../../../shared/momoPrefs.mjs';
import { momoColorCss } from './momoColors';

/** MoMo's donut in the color the user picked (prefs.momo.persona.color), or `color` while setup previews one. */
export function MomoDot({ size = 16, color }: { size?: number; color?: MomoColor }) {
  const saved = useMomoPrefs().persona.color;
  return (
    <span
      className="momo-dot"
      style={{ width: size, height: size, borderWidth: Math.round(size * 0.3), borderColor: momoColorCss(color ?? saved) }}
      aria-hidden="true"
    />
  );
}

export function MomoSidebarRow() {
  const allowed = useMomoAllowed();
  const here = useStore((s) => s.route.name === 'momo');
  const name = useMomoPrefs().persona.name;
  if (!allowed) return null;
  return (
    <button
      type="button"
      className={`side-row momo-row ${here ? 'selected' : ''}`}
      aria-current={here ? 'page' : undefined}
      onClick={() => {
        if (!here) navigate({ name: 'momo' });
      }}
    >
      <span className="side-row-icon">
        <MomoDot />
      </span>
      <span className="side-row-label">{name}</span>
      <span className="side-row-kbd">{shortcutLabel('⌘.')}</span>
    </button>
  );
}
