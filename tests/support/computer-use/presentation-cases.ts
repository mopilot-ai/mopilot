// Computer-use presentation cases registered by the original unit-test entrypoint.
import { require, test, assert, fs, elementList, toPoints } from './fixture.ts';

export function registerPresentationCases() {
  test('element list: interactive or labelled elements, centers in the screenshot pixels', () => {
    const snap = {
      app: { name: 'Notes' },
      root: {
        id: '0',
        role: 'AXApplication',
        title: 'Notes',
        frame: { x: 0, y: 0, w: 10, h: 10 },
        children: [
          { id: '0.0', role: 'AXGroup', frame: { x: 0, y: 0, w: 10, h: 10 } },
          { id: '0.1', role: 'AXButton', description: 'New Note', frame: { x: 10, y: 20, w: 10, h: 10 }, focused: true },
        ],
      },
    };
    const { text, byId } = elementList(snap, { x: 0, y: 0, ppp: 2 });
    assert.deepEqual([...byId.keys()], ['0.1']);
    assert.match(text, /^Notes: 1 elements/);
    assert.match(text, /\[0\.1\] Button "New Note" at \(30, 50\) \(focused\)/);
    assert.deepEqual(toPoints({ x: 100, y: 0, ppp: 2 }, { x: 30, y: 50 }), { x: 115, y: 25 });
  });

  test("Settings' read-only deny list is the helper's built-in floor", () => {
    const { BUILT_IN_DENY } = require('../../../electron/capabilities/computer.cjs');
    const swift = fs.readFileSync(new URL('../../../native/helper/Sources/HelperCore/DenyList.swift', import.meta.url), 'utf8');
    const rules = [...swift.matchAll(/DenyRule\("([^"]+)", "([^"]+)", hide: (?:true|false)\)/g)].map((m) => ({
      pattern: m[1],
      reason: m[2],
    }));
    assert.ok(rules.length > 5);
    assert.deepEqual(BUILT_IN_DENY, rules);
  });
}
