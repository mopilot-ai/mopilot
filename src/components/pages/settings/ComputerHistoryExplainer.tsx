// Computer History's first-run explainer (#1363): shown before it is turned on for the first time, it says exactly what is recorded, what never is, where it stays and how to stop it; Turn on is the only way past it.
import { Modal } from '../../ui/Modal';

export const CAPTURED = [
  'Which allowed app you are using, and the title of its front window',
  'In an allowed browser, the site and page you are on (no search terms or anything after a "?"), and its title',
  'When and for how long, summarized into memories by day',
];

export const NEVER = [
  'Keystrokes, screenshots or what is in a field',
  'Anything while a password field has focus',
  "Apps and sites you didn't add",
  'MoPilot, password managers, sign-in prompts, banking, payment and health sites',
];

export const WHERE = [
  'Encrypted on this Mac. Nothing is synced or uploaded.',
  'A chat gets memories only when you share them with it.',
  'Pause any time from the menu bar. It stops while the Mac is locked or asleep, and when MoPilot quits.',
];

/** The explainer; `retentionDays` says how long memories are kept. */
export function ComputerHistoryExplainer({
  retentionDays,
  onTurnOn,
  onClose,
}: {
  retentionDays: number;
  onTurnOn: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Turn on Computer History?" onClose={onClose}>
      <div className="ch-explainer">
        <p className="ch-explainer-lead">
          Computer History turns what you do in the apps and sites you allow into memories, so a chat you share them with knows what you
          were working on.
        </p>
        <h3>What it records</h3>
        <ul data-list="captured">
          {CAPTURED.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <h3>What it never records</h3>
        <ul data-list="never">
          {NEVER.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <h3>Where it stays</h3>
        <ul data-list="where">
          {WHERE.map((t) => (
            <li key={t}>{t}</li>
          ))}
          <li>Memories are deleted after {retentionDays} days, or whenever you delete them.</li>
        </ul>
        <div className="sketch-foot">
          <button className="btn-pill" onClick={onClose}>
            Not now
          </button>
          <button className="btn-white" onClick={onTurnOn}>
            Turn on
          </button>
        </div>
      </div>
    </Modal>
  );
}
