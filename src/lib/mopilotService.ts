// Whether this build has the MoPilot service (the preload's window.native.mopilotService): the open-source edition has none,
// so nothing offers the MoPilot account, credits or sending bug reports.
import { native } from './native';

/** False only in a build without the service; a test's stand-in for window.native that leaves it out has it. */
export const hasMoPilotService = () => native.mopilotService !== false;
