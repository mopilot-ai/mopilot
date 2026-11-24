// The Claude Code tab of the Plugins and Customize pages: what Claude Code has installed, read-only,
// with installing handed to the claude CLI in a terminal.
import { useEffect, useState } from 'react';
import { currentCwdForNewChat } from '../../../store/projects';
import { navigate } from '../../../store/panes';
import { native, type ClaudeCatalog } from '../../../lib/native';
import { useHarnessStatus } from '../../../session/harness/select';
import { Group, Row } from '../../pages/Settings';
import { ClaudePlugins, type LoadError } from './Extensions';
import { SkillDetailDialog } from '../../skills/SkillDetailDialog';
import { mergeSkills, type SkillRow } from '../../skills/mergeSkills';
import { ownGet } from '../../../../shared/ownTable.mjs';
import { errorText } from '../../../lib/ignored';

export function ClaudeCustomize({ tab }: { tab: string }) {
  const st = useHarnessStatus('claude');
  const cwd = currentCwdForNewChat();
  const [catalog, setCatalog] = useState<ClaudeCatalog | null>(null);
  // a catalog that couldn't be read: said with Retry (which reads again for this folder and CLI), not shown as none
  const [error, setError] = useState<LoadError | null>(null);
  // the skill whose definition is open: the same detail the Skills page shows
  const [detail, setDetail] = useState<SkillRow | null>(null);
  const bin = st.bin;
  useEffect(() => {
    if (!bin) return;
    let alive = true;
    const load = () => {
      setError(null);
      native.claude.catalog(bin, cwd).then(
        (c) => alive && setCatalog(c),
        (e: unknown) => alive && setError({ message: errorText(e), retry: load }),
      );
    };
    load();
    return () => {
      alive = false;
    };
  }, [bin, cwd]);
  const skills = tab === 'skills';
  return (
    <div className="page plugins-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{skills ? 'Skills' : 'Plugins'}</h1>
          <p className="page-sub">
            {skills ? 'Skills Claude Code has found for this project and your account' : 'Plugins Claude Code has installed'}
          </p>
        </div>
        <button className="btn-white" onClick={() => navigate({ name: 'settings', section: 'claude', tab: 'extensions' })}>
          Claude Code settings
        </button>
      </div>
      {!bin ? (
        <Group>
          <Row title="Claude Code isn't installed or signed in" desc="Plugins and skills appear here once it is." />
        </Group>
      ) : skills ? (
        <Group title="Skills" desc="Add or remove skills in ~/.claude/skills or a project's .claude/skills.">
          <Row
            title={error ? "Couldn't read the skills" : catalog ? (catalog.skills.length ? 'Available' : 'None found') : 'Loading…'}
            desc={
              error
                ? error.message
                : catalog?.skills.length
                  ? catalog.skills.map((n, i) => (
                      <SkillName
                        key={n}
                        name={n}
                        first={i === 0}
                        open={
                          ownGet(catalog.skillFiles, n) &&
                          (() => setDetail(mergeSkills({ codex: [], claude: [n], claudeFiles: catalog.skillFiles, plugins: [] })[0]))
                        }
                      />
                    ))
                  : catalog
                    ? 'Start a chat to load skills, or add one to ~/.claude/skills.'
                    : undefined
            }
          >
            {error && (
              <button className="btn-pill soft" onClick={error.retry}>
                Retry
              </button>
            )}
          </Row>
        </Group>
      ) : (
        <ClaudePlugins bin={bin} plugins={catalog?.plugins ?? null} error={error} />
      )}
      {detail && <SkillDetailDialog row={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** A listed skill's name: it opens the skill's detail when its SKILL.md was found (`open`), else it is plain text. */
function SkillName({ name, open, first }: { name: string; open?: () => void; first: boolean }) {
  return (
    <>
      {first ? null : '  '}
      {open ? (
        <button type="button" className="skill-link" onClick={open}>
          {name}
        </button>
      ) : (
        name
      )}
    </>
  );
}
