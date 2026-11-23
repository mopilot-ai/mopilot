// Settings -> Computer use: what was approved on each Host's desktop, apart from this Mac's lists (electron/capabilities/hostApprovals.cjs), with Remove for each app and for the machine's always-allowed list.
import { ownTable } from '../../../../shared/ownTable.mjs';
import { native, type ComputerGrant, type ComputerStatus } from '../../../lib/native';
import { Group, Row } from '../Settings';

const LEVEL: Record<string, string> = ownTable({ view: 'View only', click: 'Click', full: 'Full control' });

export function GrantRow({ g, chat, onRemove }: { g: ComputerGrant; chat?: string; onRemove: () => void }) {
  return (
    <Row title={g.name} desc={[LEVEL[g.level] ?? g.level, chat].filter(Boolean).join(' · ')}>
      <button className="btn-pill soft" aria-label={`Remove ${g.name}`} onClick={onRemove}>
        Remove
      </button>
    </Row>
  );
}

/** One group per machine that holds approvals: "On <machine>". @param change runs a change and reads the status again */
export function MachineGroups({
  machines,
  chatTitle,
  change,
}: {
  machines: NonNullable<ComputerStatus['machines']>;
  chatTitle: (chatId: string) => string;
  change: (what: string, run: () => Promise<unknown>) => Promise<unknown>;
}) {
  return (
    <>
      {machines.map((m) => (
        <Group
          key={m.id}
          title={`On ${m.name}`}
          desc="Approved for that machine's desktop only."
          action={
            m.global.length ? (
              <button
                className="btn-pill soft"
                onClick={() => change(`remove the apps always allowed on ${m.name}`, () => native.computer.revokeAllOnMachine(m.id))}
              >
                Remove all
              </button>
            ) : undefined
          }
        >
          {m.global.map((g: ComputerGrant) => (
            <GrantRow
              key={g.bundleId}
              g={g}
              chat="always"
              onRemove={() => change(`remove ${g.name}`, () => native.computer.revokeOnMachine(m.id, null, g.bundleId))}
            />
          ))}
          {m.chats.flatMap(({ chatId, grants }) =>
            grants.map((g: ComputerGrant) => (
              <GrantRow
                key={`${chatId}:${g.bundleId}`}
                g={g}
                chat={chatTitle(chatId)}
                onRemove={() => change(`remove ${g.name}`, () => native.computer.revokeOnMachine(m.id, chatId, g.bundleId))}
              />
            )),
          )}
        </Group>
      ))}
    </>
  );
}
