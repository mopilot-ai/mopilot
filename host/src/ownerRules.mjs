// The owner's rules and the spend counter made together for one Host (plan U2, U5): a raised limit frees the chats it held, and the counter publishes to the chats' state lane.
import { createPolicy } from './policy.mjs';
import { createSpend } from './spend.mjs';
import { createManagedFile } from './managedPolicyFile.mjs';

/**
 * @param {{ dataDir: string, report: (line: string) => void, audit?: { governed: (e: any) => boolean, note: (e: any) => void } }} o
 * @returns {{ managedFile: ReturnType<typeof createManagedFile>, policy: ReturnType<typeof createPolicy>, spend: ReturnType<typeof createSpend>, attach: (late: { leases?: { hasOrg: (harness: string) => boolean }, protocol?: { chatState: (chatId: string, patch: Record<string, unknown>) => void }, sessions?: { drainChat: (chatId: string) => void, holdBy: (fn: (chatId: string) => boolean) => void } }) => void }}
 */
export function createOwnerRules({ dataDir, report, audit }) {
  // a root-owned managed policy, watched for the life of the Host (the caller stops it)
  const managedFile = createManagedFile({ report });
  managedFile.watch();
  /** The protocol and the sessions are made after these (the sessions hold a chat's message by the counter), so they are given when they exist. @type {Parameters<ReturnType<typeof createOwnerRules>['attach']>[0]} */
  const late = {};
  const policy = createPolicy({
    dataDir,
    report,
    managedFile,
    audit,
    // `hosts.credentials.orgOnly`: a chat needs an organization lease (the credentials are made after the rules, so they are given later)
    hasOrgLease: (harness) => late.leases?.hasOrg(harness) ?? false,
    // a raised limit frees what it held: the chats' attention clears and each one's next waiting message goes
    onChange: () => {
      for (const chatId of spend.reevaluate()) late.sessions?.drainChat(chatId);
    },
  });
  const spend = createSpend({
    dataDir,
    limits: () => policy.effective().doc.spend ?? {},
    state: (chatId, patch) => late.protocol?.chatState(chatId, patch),
    report,
  });
  return {
    managedFile,
    policy,
    spend,
    attach: (given) => {
      Object.assign(late, given);
      given.sessions?.holdBy(spend.holds);
    },
  };
}
