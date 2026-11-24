// Milestone M6 (managed machine, plan W): S5, a root-owned policy file that caps the permission mode, and S6, an approval that leaves a metadata-only audit record. Needs `sudo -n` for the file; without it S5 is a SKIP that says so.
import { prefixUnits } from '../../../shared/textPrefix.mjs';
import { ask, chat, expect, hostUp, restart, until } from '../steps.mjs';
import { answerCard, optionOf, refusalOf, rpc, waitCard } from './common.mjs';
import { removePolicyFile, sudoGap, writeManaged } from './policyFile.mjs';
import { workFolder } from '../workFolder.mjs';

/** The document that caps every client at "Ask for approval" (`default`). */
const CAP = { version: 1, organization: 'mopilot-accept', permission: { max: 'default' } };

/** The Host's `status` policy block, once `ok` says it is the state wanted. @param {any} ctx @param {(p: any) => unknown} ok @param {string} what */
const policyWhen = (ctx, ok, what) =>
  until(
    async () => {
      const policy = (await rpc(ctx, 'status')).policy;
      return ok(policy) && policy;
    },
    { what, every: 500 },
  );

/** A chat.start asking for Full access: the Host's code, or null. @param {any} ctx @param {number} n */
const fullAccess = (ctx, n) =>
  refusalOf(ctx, 'chat.start', {
    chatId: chat(ctx, n),
    epoch: 1,
    key: `accept-policy-${n}`,
    harness: 'acp:fake',
    text: 'hello',
    cwd: workFolder(ctx.state),
    permission: 'full-access',
  });

/** The command that runs `mopilot-host audit export` the way the running Host was started. @param {any} ctx */
async function auditCommand(ctx) {
  const args = (await ctx.m.run(`ps -o args= -p ${ctx.state.pid}`)).stdout.trim().split(/\s+/);
  expect(args.length >= 2, `The running Host's command line could not be read (${args.join(' ')}).`);
  return `${args[0]} ${args[1]} audit export --data-dir '${ctx.state.dataDir}'`;
}

export const M6_STEPS = [
  {
    id: 'S5a',
    title: 'M6/S5 A root-owned policy caps permission at Ask for approval: a start and a switch to Full access are refused',
    async run(ctx) {
      const gap = await sudoGap(ctx);
      if (gap) return (ctx.state.s5skip = gap), { skip: gap };
      await writeManaged(ctx, CAP, 'root');
      // a folder that did not exist when the Host started is not watched, so the Host reads the file at its next start
      ctx.state.pid = (await (restart(ctx), hostUp(ctx, ctx.state.pid))).pid;
      const policy = await policyWhen(ctx, (p) => p?.managed, 'the Host to report the managed policy');
      expect(policy.locked.includes('permissionMax'), `The status does not report the lock (locked: ${JSON.stringify(policy.locked)}).`);
      const start = await fullAccess(ctx, 21);
      expect(start === 'policy_refused', `chat.start with Full access got "${start}", not policy_refused.`);
      const kept = await refusalOf(ctx, 'chat.start', {
        chatId: chat(ctx, 22),
        epoch: 1,
        key: 'accept-policy-22',
        harness: 'acp:fake',
        text: 'allowed under the cap',
        cwd: workFolder(ctx.state),
        permission: 'default',
      });
      expect(kept === null, `chat.start with Ask for approval was refused too ("${kept}").`);
      const switched = await refusalOf(ctx, 'chat.permit', {
        chatId: chat(ctx, 22),
        epoch: 1,
        key: 'accept-policy-permit',
        value: 'full-access',
      });
      expect(switched === 'policy_refused', `A switch to Full access got "${switched}", not policy_refused.`);
      return `file ${ctx.state.policyFile} (root-owned); status managed, locked ${policy.locked.join(', ')}; Full access refused on start and on switch, Ask for approval allowed`;
    },
  },
  {
    id: 'S5b',
    title: 'M6/S5 A policy file the user can write is refused and reported, and the last good cap stays',
    async run(ctx) {
      if (ctx.state.s5skip) return { skip: `S5a was skipped: ${ctx.state.s5skip}` };
      await writeManaged(ctx, CAP, 'user');
      const policy = await policyWhen(ctx, (p) => p?.problem, 'the Host to report the writable file');
      expect(/root|written/.test(policy.problem), `The problem says "${policy.problem}".`);
      const start = await fullAccess(ctx, 23);
      expect(
        start === 'policy_refused',
        `With the file refused, Full access got "${start}", not policy_refused (the last good cap must hold).`,
      );
      return `status problem: "${policy.problem}"; the cap from the last good file still refuses Full access`;
    },
  },
  {
    id: 'S5c',
    title: 'M6/S5 Removing the policy file lifts the cap',
    async run(ctx) {
      if (ctx.state.s5skip) return { skip: `S5a was skipped: ${ctx.state.s5skip}` };
      await removePolicyFile(ctx);
      const policy = await policyWhen(ctx, (p) => p && !p.managed && !p.problem, 'the Host to drop the policy');
      expect(!policy.locked.includes('permissionMax'), 'The status still reports the permission lock.');
      const start = await fullAccess(ctx, 24);
      expect(start === null, `Full access is still refused after the file went ("${start}").`);
      return 'file removed; status no longer managed or locked; Full access is allowed again';
    },
  },
  {
    id: 'S6',
    title: 'M6/S6 An answered approval is in the audit record: who, which device, when; the chain holds; no text is kept',
    async run(ctx) {
      const id = chat(ctx, 25);
      const marker = `auditsecret${ctx.nonce}`;
      const c = await ask(ctx, id, `PERMIT ${marker}`);
      try {
        const card = await waitCard(c, id);
        const before = Number((await ctx.m.run('date +%s')).stdout) * 1000;
        await answerCard(c, card, optionOf(card, 'allow').optionId, 's6');
        await c.waitFor((e) => e.chatId === id && e.frame?.item?.event?.kind === 'turnEnd', 30_000);
        const exportCommand = await auditCommand(ctx);
        const out = await ctx.m.run(exportCommand);
        expect(out.code === 0, `audit export exited ${out.code} (${out.stderr.trim()}).`);
        const lines = out.stdout
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l));
        const line = lines.find((l) => l.kind === 'approval.answered' && l.chat === id);
        expect(line, `No approval.answered line names ${id} among ${lines.length} lines.`);
        expect(line.by?.fingerprint && line.by?.name && line.by?.kind, `The line does not name who answered (${JSON.stringify(line.by)}).`);
        expect(line.what?.decision === 'allow', `The line says the decision was "${line.what?.decision}".`);
        expect(Math.abs(line.at - before) < 10 * 60_000, `The line's time ${line.at} is not near the answer (${before}).`);
        const verified = await ctx.m.run(`${exportCommand} --verify`);
        expect(
          verified.code === 0 && /chain holds/.test(verified.stdout),
          `The chain did not verify: ${verified.stdout.trim()} ${verified.stderr.trim()}.`,
        );
        const leaked = [marker, card.summary.line].filter((t) => t && t.length >= 6);
        for (const text of leaked) {
          const found = await ctx.m.run(`grep -rlF '${text.replace(/'/g, '')}' '${ctx.state.dataDir}/audit'`);
          expect(found.stdout.trim() === '', `The audit folder holds the text "${text}" (${found.stdout.trim()}).`);
        }
        return `approval.answered by ${line.by.name} (${line.by.kind}, ${prefixUnits(String(line.by.fingerprint), 12)}…) at ${new Date(line.at).toISOString()}; chain holds for ${lines.length} lines; ${leaked.length} text(s) of the chat absent from the audit folder`;
      } finally {
        c.close();
      }
    },
  },
];
