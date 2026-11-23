// Forward native embedded-page shortcut input once, before Chromium or the app menu consumes it.
const { comboFromEvent, nativeShortcutAccelerator } = require('../../../shared/shortcutKeys.mjs');
const { resolveShortcut } = require('../../../shared/shortcuts.mjs');
/** @param {(combo: string) => void} [modifiers] */
function browserShortcuts(wc, bindings, deliver, platform = process.platform, modifiers = (_combo) => undefined) {
  let held = '';
  const updateModifiers = (combo) => {
    if (combo === held) return;
    held = combo;
    modifiers(combo);
  };
  const clear = () => updateModifiers('');
  const onInput = (event, input) => {
    if (!['keyDown', 'keyUp'].includes(input.type) || wc.isDestroyed() || wc.isFocused?.() === false) return;
    const combo = comboFromEvent(
      { key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta },
      platform === 'darwin',
    );
    updateModifiers(
      input.isComposing || combo
        ? ''
        : comboFromEvent(
            { key: '', code: '', ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta },
            platform === 'darwin',
          ),
    );
    if (input.type !== 'keyDown') return;
    const action = combo && nativeShortcutAccelerator(combo, platform) && resolveShortcut(combo, bindings(), 'browser', platform);
    if (!action) return;
    event.preventDefault();
    if (!input.isComposing && (!input.isAutoRepeat || action.repeat)) deliver(combo);
  };
  wc.on('before-input-event', onInput);
  wc.on('blur', clear);
  wc.once('destroyed', () => {
    clear();
    wc.removeListener('before-input-event', onInput);
    wc.removeListener('blur', clear);
  });
}

/** The main window still lets native menus handle keys, but repeated one-shot keys and IME never reach them. */
function blockAppShortcutInput(wc, bindings, platform = process.platform) {
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || (!input.isAutoRepeat && !input.isComposing)) return;
    const combo = comboFromEvent(
      { key: input.key, code: input.code, ctrlKey: input.control, altKey: input.alt, shiftKey: input.shift, metaKey: input.meta },
      platform === 'darwin',
    );
    const action = combo && nativeShortcutAccelerator(combo, platform) && resolveShortcut(combo, bindings(), 'app', platform);
    if (action && (input.isComposing || !action.repeat)) event.preventDefault();
  });
}
module.exports = { browserShortcuts, blockAppShortcutInput };
