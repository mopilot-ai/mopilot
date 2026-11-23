// New chat's pickers as Claude for iOS's small sheets: Select model (models with their lines and a check, then Effort, Permissions and Account rows that open their own page), Agent, Project and Computer.
import { useState } from 'react';
import { Switch, Text } from 'react-native';
import type { Account, Harness, Options, Project } from '../remote/client';
import { useTheme } from '../theme';
import { BottomSheet } from './BottomSheet';
import { Group, GroupItem } from './Grouped';
import { Icon } from './Icon';
import { typo } from '../typography';

type Pick = (id: string) => void;
const labelOf = (list: { id: string; label: string }[], id: string | null) => list.find((x) => x.id === id)?.label;

/** The model sheet's pages: the current models first; More models, Effort, Permissions and Account each open in place, with ‹ back to the models. */
type Page = 'models' | 'more' | 'effort' | 'permission' | 'account';

export function ModelSheet({
  open,
  close,
  options,
  model,
  effort,
  permission,
  account,
  pickModel,
  pickEffort,
  pickPermission,
  pickAccount,
  serving,
  agent,
}: {
  /** An open chat's agent: a row under the models that opens the agent picker (New chat has its own Agent chip). */
  agent?: { label: string; open: () => void };
  open: boolean;
  close: () => void;
  options: Options;
  model: string | null;
  effort: string | null;
  permission: string | null;
  account: string | null;
  pickModel: Pick;
  pickEffort: Pick;
  pickPermission: Pick;
  /** absent where the account cannot be changed (an agent without per-chat accounts, an older Mac): the Account row is then left out */
  pickAccount?: (id: string | null) => void;
  /** an open chat on the agent's own choice: the login now serving it, named under Automatic */
  serving?: string | null;
}) {
  const [page, setPage] = useState<Page>('models');
  const shut = () => {
    setPage('models');
    close();
  };
  const back = () => setPage('models');
  const picked = options.models.find((m) => m.id === model);
  const efforts = picked?.efforts ?? [];
  // the Mac's own tags decide which models are current and which are older; the order is the Mac's, and a pick moves nothing
  const current = options.models.filter((m) => !m.more);
  const older = options.models.filter((m) => m.more);
  const modelRow = (m: Options['models'][number]) => (
    <GroupItem
      key={m.id}
      title={m.label}
      detail={m.description ?? undefined}
      end={m.id === model ? 'check' : 'none'}
      onPress={() => {
        pickModel(m.id);
        shut();
      }}
    />
  );
  const title = { models: 'Select model', more: 'More models', effort: 'Effort', permission: 'Permissions', account: 'Account' }[page];
  return (
    <BottomSheet open={open} title={title} onClose={shut} onBack={page === 'models' ? undefined : back}>
      {page === 'models' && (
        <>
          {current.length > 0 && <Group>{current.map(modelRow)}</Group>}
          {efforts.length > 0 && (
            <Group>
              <GroupItem
                key="effort"
                title="Effort"
                badge={picked?.defaultEffort && picked.defaultEffort === effort ? 'Recommended' : undefined}
                value={labelOf(efforts, effort) ?? 'Default'}
                end="chevron"
                onPress={() => setPage('effort')}
              />
            </Group>
          )}
          {older.length > 0 && (
            <Group>
              <GroupItem key="more" title="More models" end="chevron" onPress={() => setPage('more')} />
            </Group>
          )}
          <Group>
            {agent && (
              <GroupItem
                key="agent"
                title="Agent"
                value={agent.label}
                end="chevron"
                onPress={() => {
                  shut();
                  agent.open();
                }}
              />
            )}
            {options.permissions.length > 0 && (
              <GroupItem
                key="permission"
                title="Permissions"
                value={labelOf(options.permissions, permission) ?? 'Choose'}
                end="chevron"
                onPress={() => setPage('permission')}
              />
            )}
            {!!pickAccount && options.accounts.length > 0 && (
              <GroupItem
                key="account"
                title="Account"
                value={labelOf(options.accounts, account) ?? 'Automatic'}
                end="chevron"
                onPress={() => setPage('account')}
              />
            )}
          </Group>
        </>
      )}
      {page === 'more' && <Group>{older.map(modelRow)}</Group>}
      {page === 'effort' && (
        <Group>
          {efforts.map((e) => (
            <GroupItem
              key={e.id}
              title={e.label}
              badge={e.id === picked?.defaultEffort ? 'Recommended' : undefined}
              end={e.id === effort ? 'check' : 'none'}
              onPress={() => {
                pickEffort(e.id);
                back();
              }}
            />
          ))}
        </Group>
      )}
      {page === 'permission' && (
        <Group>
          {options.permissions.map((p) => (
            <GroupItem
              key={p.id}
              title={p.label}
              // the reason a row can't be picked replaces its line
              detail={p.disabled ?? p.detail}
              end={p.id === permission ? 'check' : 'none'}
              onPress={
                p.disabled
                  ? undefined
                  : () => {
                      pickPermission(p.id);
                      back();
                    }
              }
            />
          ))}
        </Group>
      )}
      {page === 'account' && (
        <Group>
          {[{ id: '', label: 'Automatic' } as Account, ...options.accounts].map((a) => (
            <GroupItem
              key={a.id || 'automatic'}
              title={a.label}
              // Automatic names the login now serving an open chat; a login that is signed out says where to sign in and is not offered
              detail={a.signedOut ? 'Signed out · Sign in on your Mac' : a.limited ? 'At its limit' : undefined}
              say={a.limited ? 'At its limit' : undefined}
              // the login in use is part of the row's label, so VoiceOver says it too; a pinned chat is not on Automatic, so it names none
              value={!a.id && !account && serving ? `Now on ${serving}` : undefined}
              end={(a.id || null) === account ? 'check' : 'none'}
              onPress={
                a.signedOut
                  ? undefined
                  : () => {
                      pickAccount!(a.id || null);
                      back();
                    }
              }
            />
          ))}
        </Group>
      )}
    </BottomSheet>
  );
}

/** The agents the Mac can start, as it lists them: Claude Code, Codex, then the admitted ACP agents. */
export function AgentSheet({
  open,
  close,
  harnesses,
  harness,
  pick,
}: {
  open: boolean;
  close: () => void;
  harnesses: Harness[];
  harness: string;
  pick: Pick;
}) {
  return (
    <BottomSheet open={open} title="Agent" onClose={close}>
      <Group>
        {harnesses.map((h) => (
          <GroupItem
            key={h.id}
            title={h.label}
            detail={h.detail ?? undefined}
            end={h.id === harness ? 'check' : 'none'}
            onPress={
              // an agent that machine cannot run now is listed with why, not offered
              h.unavailable
                ? undefined
                : () => {
                    pick(h.id);
                    close();
                  }
            }
          />
        ))}
      </Group>
    </BottomSheet>
  );
}

/** No project, or one of the Mac's projects with the branch it is on; with a project, whether to work in a new worktree. */
export function ProjectSheet({
  open,
  close,
  projects,
  project,
  worktree,
  pick,
  setWorktree,
}: {
  open: boolean;
  close: () => void;
  projects: Project[];
  project: string | null;
  worktree: boolean;
  pick: (id: string | null) => void;
  setWorktree: (on: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <BottomSheet open={open} title="Project" onClose={close}>
      <Group>
        {[{ id: '', label: 'No project', branch: null } as Project, ...projects].map((p) => (
          <GroupItem
            key={p.id || 'none'}
            title={p.label}
            detail={p.branch ?? undefined}
            icon={p.id ? <Icon name="arrow.triangle.branch" glyph="⑂" size={15} color={theme.ink2} /> : undefined}
            end={(p.id || null) === project ? 'check' : 'none'}
            onPress={() => {
              pick(p.id || null);
              if (!p.id) setWorktree(false);
              close();
            }}
          />
        ))}
      </Group>
      {project && (
        <Group>
          <GroupItem
            title="New worktree"
            detail="Works in a separate checkout so it can't touch your current files."
            trailing={
              <Switch
                accessibilityLabel="New worktree"
                value={worktree}
                onValueChange={setWorktree}
                trackColor={{ true: theme.ok, false: theme.fill2 }}
              />
            }
          />
        </Group>
      )}
    </BottomSheet>
  );
}

/** Where the chat runs: the paired Mac, with its live state. */
export function ComputerSheet({ open, close, name, online }: { open: boolean; close: () => void; name: string; online: boolean }) {
  const theme = useTheme();
  return (
    <BottomSheet open={open} title="Computer" onClose={close}>
      <Group>
        <GroupItem
          title={name}
          icon={<Icon name="laptopcomputer" glyph="💻" size={18} color={theme.ink} />}
          value={online ? 'Connected' : 'Offline'}
          end="check"
          onPress={close}
        />
      </Group>
      <Text style={{ ...typo.footnote, color: theme.ink2, paddingHorizontal: 16 }}>Change computers in Settings.</Text>
    </BottomSheet>
  );
}
