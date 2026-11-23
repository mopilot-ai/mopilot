// The first renderer frame: show startup status while main initializes, before importing the full app.
// first, so the bridge is behind the native port before any other module runs
import './lib/nativeInstall';
import { native } from './lib/native';
import { installLanguage } from './lib/i18n';
import './styles/tokens.css';
import './styles/app/base.css';
import './styles/app/main.css';

/**
 * The interface's language, before any module that may read it evaluates. A window that can't get it stays in English
 * rather than not opening. It stays this language until it next opens: a reload would end its terminals' commands.
 */
async function loadLanguage() {
  try {
    installLanguage(await native.app.language());
  } catch (error) {
    console.error('[startup] showing the interface in English', error);
  }
}

/** Wait for main without running any app-module side effects against unready IPC. */
export async function launch(
  ready: () => Promise<void> = () => native.app.ready(),
  load: () => Promise<unknown> = () => import('./main').then(({ start }) => start()),
  language: () => Promise<void> = loadLanguage,
) {
  try {
    await ready();
    await language();
    await load();
  } catch (error) {
    console.error('[startup] could not open the app', error);
    const root = document.getElementById('root')!;
    root.textContent = 'MoPilot could not finish starting. Quit and reopen it to try again.';
    root.setAttribute('role', 'alert');
  }
}

void launch();
