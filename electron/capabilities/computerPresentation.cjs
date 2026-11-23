// Window restoration and agent-facing labels while computer-use tools control the desktop.
const { dock, undock } = require('./hostDock.cjs');

const area = (w) => {
  const b = w.getBounds();
  return b.width * b.height;
};

/**
 * MoPilot's own windows while a chat controls the desktop (the control overlay stays): the largest docks as a
 * corner panel showing the chat in control (hostDock.cjs), so approval cards stay answerable; the others hide. show()
 * puts them all back; `focus` also brings the app forward; attend() brings the panel forward for a card. Null without
 * Electron's BrowserWindow.
 */
function hostWindows(electron, keep) {
  const BW = electron?.BrowserWindow;
  if (!BW?.getAllWindows) return null;
  let hidden = [];
  /** @type {ReturnType<typeof dock> | null} */
  let docked = null;
  return {
    hide(chatId = null) {
      const shown = BW.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && !keep().includes(w));
      if (!docked && shown.length) {
        const main = shown.reduce((a, b) => (area(b) > area(a) ? b : a));
        docked = dock(electron, main, chatId);
      }
      const rest = shown.filter((w) => w !== docked?.w);
      for (const w of rest) w.hide();
      hidden = [...hidden, ...rest];
      return !!docked || hidden.length > 0;
    },
    show(focus) {
      if (docked) undock(docked);
      docked = null;
      const back = hidden;
      hidden = [];
      for (const w of back) if (!w.isDestroyed()) focus ? w.show() : w.showInactive();
      if (focus) electron.app?.focus?.({ steal: true });
    },
    /** A card for the person: the docked panel comes forward with the keyboard; false when nothing is docked. */
    attend() {
      if (!docked || docked.w.isDestroyed()) return false;
      docked.w.show();
      docked.w.focus();
      return true;
    },
  };
}

/** Who a computer-use surface names when the chat's agent is unknown. */
const AGENT_FALLBACK = 'The agent';

/**
 * The one way every desktop-level computer-use surface says who is in control (the badge, the pill, the tray and the
 * notifications), as Claude Desktop says it: "Claude is using your computer", then "Claude is done using your computer".
 */
const usingText = (agent) => `${agent || AGENT_FALLBACK} is using your computer`;
const doneText = (agent) => `${agent || AGENT_FALLBACK} is done using your computer`;

/** The tray tooltip while a chat controls the computer: names the chat that holds the desktop lock. */
function trayTooltip(chatName) {
  return `Using your computer${chatName ? ` · ${chatName}` : ''}`;
}

/**
 * The agent of a chat as notifications name it: "Claude", "Codex", or an ACP harness's own label
 * (`acpLabel(id)`); null when unknown.
 */
function agentLabel(kind, acpLabel) {
  const k = String(kind ?? '');
  if (k.startsWith('acp:')) return acpLabel(k.slice(4)) || null;
  return { claude: 'Claude', codex: 'Codex' }[k] ?? null;
}

module.exports = { hostWindows, trayTooltip, agentLabel, usingText, doneText, AGENT_FALLBACK };
