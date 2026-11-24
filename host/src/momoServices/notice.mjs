// Plugs MoMo's "notices what matters" into the home (host/src/momoNotice.mjs): the collector on the scheduler's tick, the brief and catch-up the daily clock asks for, and the views the apps read. It does nothing until MOMO_NOTICE_MODE is `brief` (the brief only) or `tell_now` (pushes too), so a Host runs it only on purpose.
import { createMomoNotice, noticeModeOf } from '../momoNotice.mjs';
import { createNoticeIntents } from '../momoNoticeIntents.mjs';
import { createNoticeStore } from '../momoNoticeStore.mjs';

/** @param {{ home: ReturnType<typeof import('../momoHome.mjs').createMomoHome> & Record<string, any>, env?: Record<string, string | undefined>, report: (message: string) => void }} deps */
/** The ids of the signals the learning service shows now. @param {any} learning */
const signalsOf = (learning) => (learning?.view?.()?.signals ?? []).map((/** @type {any} */ s) => s.id);

export default ({ home, env = process.env, report }) => {
  /** @type {ReturnType<typeof createNoticeStore> | null} */
  let store = null;
  /** @type {import('../../../shared/momoNotice/types.d.ts').ReaderModel | null} */
  let model = null;
  const lazyStore = /** @type {ReturnType<typeof createNoticeStore>} */ (
    new Proxy({}, { get: (_target, key) => /** @type {any} */ ((store ??= createNoticeStore({ home })))[key] })
  );
  /** The offer with this id on a brief MoMo showed and the owner did not hide, or null. @param {string} id */
  const shownOffer = (id) => {
    for (const { view } of lazyStore.views()) {
      const found = (view.offers ?? []).find((/** @type {any} */ o) => o.id === id);
      if (found) return found;
    }
    return null;
  };
  const offerOf = (id) => {
    const found = lazyStore.hiddenOffers().includes(id) ? null : shownOffer(id);
    return found ? { title: found.title, why: found.why } : null;
  };
  const notice = createMomoNotice({
    home,
    // opened on first use: the home's storage exists only for a real home
    store: lazyStore,
    reader: () => /** @type {any} */ (home.service('google')).reader(),
    google: () => /** @type {any} */ (home.service('google')).status(),
    model: () => model,
    mode: () => noticeModeOf(env.MOMO_NOTICE_MODE),
    // the push is made after the services load, so it is read when needed
    push: () => /** @type {any} */ (home.push),
    machine: () => ({ machineId: String(home.record()?.homeId), name: 'MoMo' }),
    report,
    // the pass interval is an ops knob (tests set it to 0)
    ...(Number.isFinite(Number(env.MOMO_NOTICE_EVERY_MS)) && env.MOMO_NOTICE_EVERY_MS ? { everyMs: Number(env.MOMO_NOTICE_EVERY_MS) } : {}),
  });
  // the daily clock asks the notice lane to build, claim and deliver the day's brief and the catch-up
  home.daily?.setSeams(notice.seams);
  // the collector rides the scheduler's clock while the home is active
  home.scheduler?.addTickHook(async () => void (await notice.tick()));
  home.provide('notice', {
    ...notice.views,
    actions: notice.actions,
    /** What the owner did to notices, as the home derived it from its log: the input of learned rules. */
    reactions: () => lazyStore.reactions(),
    /** An offer on a brief, by id (what tasks reads when an offer is started). */
    offer: offerOf,
    /** What the home's intents for the notice lane run: registered with the intent registry by the wiring that has it. */
    intents: createNoticeIntents({
      store: lazyStore,
      home,
      signalIds: () => signalsOf(home.service('learning')),
      learning: () => /** @type {any} */ (home.service('learning')),
      remind: (key) => notice.remind(key),
      draft: (key) => notice.draft(key),
      offerShown: (id) => shownOffer(id) !== null,
    }),
    seams: notice.seams,
    /** The tool-less reading model: given by the entry that has the protocol (`momoRunsFor`). @param {import('../../../shared/momoNotice/types.d.ts').ReaderModel | null} next */
    setModel(next) {
      model = next;
    },
    tick: notice.tick,
  });
  home.use('notice', {
    // the offers on the brief are this lane's: tasks reads them by id when an offer is started
    start: async () =>
      void (/** @type {any} */ (home.service('tasks'))?.bind?.({ offers: { get: async (/** @type {string} */ id) => offerOf(id) } })),
    pause: async () => undefined,
    wipe: async () => undefined,
    // one non-empty record through the store's normal path, so a move test can prove notice.json opens on the target
    seed: async () => {
      await lazyStore.notice.putMatter({
        matterKey: 'gmail:seed',
        state: 'open',
        title: 'Seed',
        summary: 'Seeded for a move check.',
        sources: [],
        updatedAt: new Date().toISOString(),
      });
      await lazyStore.setLastRunAt(1);
    },
  });
};
