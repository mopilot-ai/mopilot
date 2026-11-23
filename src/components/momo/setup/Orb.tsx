// MoMo's big dot on setup's screens (#2607): a filled circle in its color, the color the user picked (prefs.momo.persona.color) or, on the Meet screen, the swatch they are trying; `spin` rings it while MoMo is being set up.
import type { MomoColor } from '../../../../shared/momoPrefs.mjs';
import { useMomoPrefs } from '../../../session/momoPrefs';
import { momoColorCss } from '../momoColors';

export function Orb({ size, color, spin = false }: { size: number; color?: MomoColor; spin?: boolean }) {
  const saved = useMomoPrefs().persona.color;
  const css = momoColorCss(color ?? saved);
  return (
    <span className="momo-orb-wrap" style={{ width: size, height: size, ['--orb' as string]: css }} aria-hidden="true">
      {spin && <span className="momo-orb-ring" />}
      <span className="momo-orb" />
    </span>
  );
}
