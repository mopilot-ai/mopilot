// A local Host over a controller that tests built, which owns every chat, so IPC tests can run a `live` with a `host` in it.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalHost } = require('../../../electron/host/local.cjs');
const { PatchLog } = require('../../../electron/host/patchLog.cjs');

export function hostOver(controller: any, extra: { claudeTurns?: any; family?: (id: string) => string } = {}) {
  return createLocalHost({
    controller: () => controller,
    state: () => controller.state,
    claudeTurns: () => extra.claudeTurns ?? controller.claudeTurns,
    family: extra.family ?? ((id: string) => controller.ref(id).kind.split(':')[0]),
    log: new PatchLog(),
    owns: () => true,
    list: () => [],
    permit: () => undefined,
  });
}
