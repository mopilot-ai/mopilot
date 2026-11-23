// Windows' caption buttons, drawn by the system over the title bar, in the colors of the chat under them.
import { isWin } from './platform';
import { native } from './native';
import { ignoring } from './ignored';
import { defaultPalette } from '../../shared/defaultPalette.mjs';

/** Windows draws its caption buttons over the title bar: give them the chat's background and text. */
export function syncTitleBarOverlay(dark: boolean, win = isWin) {
  if (!win) return;
  const app = document.querySelector('.app');
  if (!app) return;
  const css = getComputedStyle(app);
  // the caption buttons sit at the top right, over the chat or a side pane, both on the chat's background
  const frame = css.getPropertyValue('--main').trim() || defaultPalette(dark).bg;
  const ink = css.getPropertyValue('--text').trim() || defaultPalette(dark).fg;
  // cosmetic: the caption buttons keep their last colors until the next theme change
  native.win.setTitleBarOverlay(frame, ink).catch(ignoring('color the Windows caption buttons'));
}
