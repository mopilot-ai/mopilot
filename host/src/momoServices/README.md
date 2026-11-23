# MoMo services on a Host

One file per service. A file default-exports `(deps) => void`, `deps = { home, sessions, epochs, env, paths, report, harnesses, check, chat }`
(host/src/momoWiring.mjs). Nothing else is edited to add one.

```js
export default ({ home, report }) => {
  home.use('notice', {
    start: () => {/* the home runs here: begin ticking, reading */},
    pause: () => {/* stop acting now (a move begins, Reset); never write after this */},
    wipe: () => {/* your data is about to be deleted: close handles */},
  });
  home.provide('notice', api); // optional: what host/src/methods/<feature>.mjs reads with momo.service('notice')
};
```

Rules (the home lane's contract, #5474):

- **Fence.** Every outbound action and push carries `home.stamp()` (null unless this Host is the running, granted home: then do nothing).
  Check `home.current(stamp)` before a write or send that was prepared earlier.
- **Data.** Keep state with `home.data.sealed(name, shape)` (a file in MoMo's folder sealed with MoMo's data key). `home.storage` is the folder only and seals nothing; `home.hostOnlyStorage` is the Host's OWN key, for the files in `HOST_OWN` and nothing else: a file sealed with it cannot be opened on the target after a move. Everything there moves with a move
  and is deleted by Reset with no code from you. State kept anywhere else does not move.
- **Work folders.** What an agent makes for the user lives outside MoMo's data, so a move does not carry it and a Reset does not delete it: `home.workDir(name)` is that folder's path (nothing is created; `mkdir` it yourself). Never build a path from `paths.dataDir` or `configDir`: the travel test fails a service file that names them.
- **Seed.** Register `seed` in `home.use(...)`: it writes one non-empty record of everything the service keeps, through its normal path, so the travel test can check it.
- **Lifecycle.** `start` can run more than once (a repeated start, a Cancel, a Reset): make it idempotent. A service registered into a home that
  already runs here starts at once. Hooks that throw are reported; the others still run.
- **Wire methods.** `host/src/methods/<feature>.mjs` with `shared/host/methods/<feature>.mjs`; give them a veil (`seen`) like `methods/momo.mjs`.
