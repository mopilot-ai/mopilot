// start_session's harness "auto": main, not the agent (#2084), picks where a linked session runs from what its brief
// needs and what each harness has left, the parent's own first (the only one that can fork its conversation), and a
// session whose harness ran out of usage mid-run is offered as a restart on another one, carrying its conversation.
const crypto = require('node:crypto');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { addNote } = require('./journal.cjs');
const { liveSelfOrAbove } = require('./family.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** What a brief may need of a harness beyond running at all, as start_session's `needs` names it. */
const NEEDS = ['computer_use'];
const NEED_WORDS = { computer_use: 'computer use' };
/** How long a restart offer can be started, as a suggestion can (proposals.cjs PROPOSAL_DAYS). */
const RESTART_DAYS = 7;

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

/**
 * Whether harness `kind` is at its usage limit, from the identity registry's instances (identity/contract/registry.cjs) of its
 * family: every signed-in plan login it could run on is out until a reset. Pay per use it runs on now (a key, credits)
 * is never out; one it isn't set to doesn't carry a new session. Null when nothing is known: no signed-in login
 * (whether it can run at all is `usable`'s question), or a kind of no family.
 * @param {{ account: string, status: string, limited: boolean, active?: boolean, billing?: string }[] | null | undefined} instances
 * @param {string} kind
 * @returns {{ limited: boolean } | null}
 */
function quotaOf(instances, kind) {
  const parsed = parseKind(kind);
  if (!parsed || !Array.isArray(instances)) return null;
  const ok = instances.filter((i) => i?.status === 'ok' && (!parsed.basic || i.account === parsed.basic));
  if (ok.some((i) => i.active && i.billing !== 'subscription' && i.billing !== 'harness')) return { limited: false };
  const plans = ok.filter((i) => i.billing === 'subscription' || i.billing === 'harness');
  return plans.length ? { limited: plans.every((i) => i.limited === true) } : null;
}

/**
 * When harness `kind`'s usage is back, as the registry's instances name it: the earliest reset of the plan logins it
 * could run on, while every one of them is out. Null when it is not out, or a login's reset time is not known.
 * @param {Parameters<typeof quotaOf>[0]} instances
 * @param {string} kind
 * @returns {number | null} ms since the epoch
 */
function quotaResetOf(instances, kind) {
  if (quotaOf(instances, kind)?.limited !== true) return null;
  const basic = parseKind(kind)?.basic;
  const plans = /** @type {NonNullable<typeof instances>} */ (instances).filter(
    (i) => i?.status === 'ok' && (!basic || i.account === basic) && (i.billing === 'subscription' || i.billing === 'harness'),
  );
  const times = plans.map((i) => /** @type {{ limitedUntil?: unknown }} */ (i).limitedUntil);
  return times.every((t) => typeof t === 'number') ? Math.min(.../** @type {number[]} */ (times)) : null;
}

/**
 * Why harness `kind` can't take the piece now, or null when it can.
 * @param {any} o the Orchestrator's dependencies
 * @param {string} kind
 * @param {string[]} needs
 */
async function unfit(o, kind, needs) {
  if (!(await o.usable(kind))) return 'not available now (not installed, not signed in, or switched off)';
  const lacking = needs.filter((n) => o.lacks?.(kind, n) === true);
  if (lacking.length) return `can't use ${lacking.map((n) => NEED_WORDS[n]).join(' or ')} now`;
  if (o.quota?.(kind)?.limited === true) return 'at its usage limit';
  return null;
}

/**
 * The harness a linked session of `parentId` runs on: the parent's when it can do the piece and has usage left, else
 * the first of the others (o.kinds: Codex, Claude Code, then admitted ACP harnesses) that can. Refused when none can.
 * @param {{ o: any }} orch
 * @param {string} parentId
 * @param {{ needs?: string[], exclude?: string[] }} [want] exclude: harnesses not to consider (a restart's own)
 * @returns {Promise<{ harness: string, reason: string, considered: { harness: string, why?: string }[] }>}
 */
async function chooseHarness(orch, parentId, { needs = [], exclude = [] } = {}) {
  const { o } = orch;
  const own = o.controller.ref(parentId).kind;
  const kinds = [...new Set([own, ...(o.kinds?.() ?? [])])].filter((k) => parseKind(k) && !exclude.includes(k));
  /** @type {{ harness: string, why?: string }[]} */
  const considered = [];
  for (const kind of kinds) {
    const why = await unfit(o, kind, needs);
    if (why) {
      considered.push({ harness: kind, why });
      continue;
    }
    considered.push({ harness: kind });
    const passed = considered.filter((c) => c.why).map((c) => `${c.harness === own ? `this chat's harness, ${own}` : c.harness}: ${c.why}`);
    const reason =
      kind === own
        ? `this chat's harness, ${own}, can do it and has usage left`
        : [...passed, `${kind} can do it and has usage left`].join('; ');
    return { harness: kind, reason, considered };
  }
  const why = considered.map((c) => `${c.harness}: ${c.why}`).join('; ') || 'none is set up';
  throw Object.assign(
    new Error(`No harness can take this session now (${why}). Tell the user; it can start once one is available or its usage resets.`),
    { code: 'no_harness', why },
  );
}

/**
 * A harness passed by name (not "auto") that lacks what the brief needs is refused before anything is made.
 * @param {{ o: any }} orch
 * @param {string} kind
 * @param {string[]} needs
 */
function requireNeeds(orch, kind, needs) {
  const lacking = needs.filter((n) => orch.o.lacks?.(kind, n) === true);
  if (lacking.length)
    fail(
      'harness_lacks',
      `${kind} can't use ${lacking.map((n) => NEED_WORDS[n]).join(' or ')} now. Pass harness "auto" to let MoPilot pick one that can.`,
    );
}

/** Whether the linked session `childId`'s harness ran out of usage: it is out now, as far as the app knows. */
function ranOut(orch, childId) {
  const harness = orch.journal.child(childId)?.harness;
  return !!harness && orch.o.quota?.(harness)?.limited === true;
}

/**
 * The note and offer for a linked session whose turn failed while its harness was out of usage: a proposal to restart
 * it on another harness (the user starts it, or asks the parent to), carrying its task, its branch and its recent
 * conversation, or a note that none can take it now. One open offer per session: a later failure names the same one.
 * The note wakes the parent, which tells the user.
 * @param {any} orch the Orchestrator
 * @param {string} childId
 */
async function offerRestart(orch, childId) {
  const { o, journal } = orch;
  const child = journal.child(childId);
  // the chat that hears from it now: its parent, or the live ancestor above an archived one (family.cjs)
  const parentId = liveSelfOrAbove(journal, child.parentId, orch.archived);
  const branch = child.useWorktree ? (o.worktreeInfo(child.cwd)?.branch ?? null) : null;
  const open = Object.entries(journal.data.proposals).find(([, p]) => p.args.restartOf === childId && p.status === 'open');
  let none = '';
  // picked again each time, so an open offer moves off a harness that has run out since
  /** @type {{ harness: string } | null} */
  const choice = await chooseHarness(orch, parentId, { needs: child.needs ?? [], exclude: [child.harness] }).catch((error) => {
    if (error?.code !== 'no_harness') noteIgnored('pick a harness to restart a linked session on', error);
    none = error?.why ?? 'none could be checked';
    return null;
  });
  const id = open?.[0] ?? (choice ? `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}` : null);
  const now = o.now();
  const lead = `The session "${child.title}" you started (${child.name}, ${childId}) stopped because its harness, ${child.harness}, is at its usage limit.`;
  const body = choice
    ? `${lead} A restart on ${choice.harness} is proposed as ${id}, with its task, its recent conversation${branch ? ` and its branch "${branch}"` : ''}. Tell the user in one line; start it with start_session {"proposal_id": "${id}"} only when they ask, or send_message the session once its usage resets.`
    : `${lead} No other harness can take it now: ${none}. Tell the user in one line; send_message the session once its usage resets.`;
  journal.change((d) => {
    if (!d.children[childId]) return; // deleted meanwhile: forget.cjs told the parent
    if (choice && open) d.proposals[open[0]].args.harness = choice.harness;
    else if (choice)
      d.proposals[/** @type {string} */ (id)] = {
        parentId,
        kind: 'own_initiative',
        args: {
          title: child.title,
          prompt: `Continue the task of the session ${child.name} ("${child.title}"), which stopped when its harness, ${child.harness}, reached its usage limit.${branch ? ` Its work so far is on branch "${branch}": merge refs/heads/${branch} to build on it.` : ''}\n\nIts task:\n${child.task ?? child.title}`,
          background: null,
          name: null,
          initiation: 'own_initiative',
          context: 'fresh',
          useWorktree: !!child.useWorktree,
          // a session in the parent's folder keeps the write scope it had (writeScope.cjs)
          paths: child.paths ?? null,
          harness: choice.harness,
          needs: child.needs ?? [],
          after: [],
          // read when it starts (spawn.cjs): the restarted session's conversation, in place of the parent's
          excerptFrom: childId,
          restartOf: childId,
        },
        harnessChecked: true,
        turn: null,
        status: 'open',
        createdAt: now,
        expiresAt: now + RESTART_DAYS * 86400000,
        chatId: null,
      };
    addNote(d, parentId, { childId, body, at: now, wakes: true });
  });
  return id;
}

module.exports = { quotaOf, quotaResetOf, chooseHarness, requireNeeds, ranOut, offerRestart, NEEDS, RESTART_DAYS };
