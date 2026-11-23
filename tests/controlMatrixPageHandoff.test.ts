// Control matrix group M (docs/control-plane/matrix/M.md): the in-app browser's certificate notice handing the site to
// the user's own browser, on the browser-panel UI's recording fixture (no Electron, no browser).
import { registerCertificateHandoffCase } from './support/browser-panel-ui/page-edges';

export const GUARDS = ['shared/', 'src/'];

registerCertificateHandoffCase();
