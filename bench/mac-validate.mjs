// Checks MacArena graders inside the benchmark VM: each must score 0 after its reset and 100 after the task's known
// shortest solution (bench/lib/macarena.mjs). Usage: node bench/mac-validate.mjs <id> [<id>...] (default: SMOKE).
import { BENCH_DIR } from './lib/config.mjs';
import { externalPaths } from './lib/external.mjs';
import { requireVm } from './lib/guard.mjs';
import { SOLUTIONS } from './lib/macarena.mjs';
import { loadCatalog, SMOKE, selectTasks } from './lib/tasks.mjs';
import { bashAsUser } from './drivers/gui.mjs';
import { grade, reset } from './drivers/macarena.mjs';

requireVm('bench/mac-validate.mjs');
const external = process.env.BENCH_EXTERNAL ?? `${BENCH_DIR}external`;
const ids = process.argv.slice(2);
const tasks = selectTasks({ bench: 'mac', tier: 'smoke', tasks: ids.length ? ids : SMOKE.mac }, loadCatalog('mac', external));
for (const t of tasks) {
  reset(t, externalPaths(external).macarena);
  const before = grade(t).score;
  const solved = bashAsUser(SOLUTIONS[t.id] ?? 'false');
  const after = grade(t);
  console.log(
    JSON.stringify({ id: t.id, before, after: after.score, ok: before === 0 && after.score === 100, solved: solved.slice(0, 200) }),
  );
}
