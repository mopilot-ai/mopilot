// One skill's detail on the All harnesses tab: where it is on or off, its SKILL.md, and Try now.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { errorText } from '../../lib/ignored';
import { navigate } from '../../store/panes';
import { Markdown } from '../markdown/Markdown';
import { FAMILIES, FAMILY_LABEL } from '../plugins/ReachStrip';
import { MessageCirclePlus, Spinner, X } from '../ui/icons';
import type { SkillRow } from './mergeSkills';

export function SkillDetailDialog({ row, onClose }: { row: SkillRow; onClose: () => void }) {
  const file = FAMILIES.map((f) => row.copies[f]?.file).find(Boolean);
  const [body, setBody] = useState<string | null>(file ? null : '');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return;
    let live = true;
    // a SKILL.md that can't be read says why instead of loading forever
    native.fs.readText(file).then(
      (t) => live && setBody((t ?? '').replace(/^---[\s\S]*?\n---\n?/, '')),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [file]);
  return (
    <div className="sketch-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skill-detail" role="dialog" aria-labelledby="skill-detail-title">
        <div className="skill-detail-head">
          <span className="flex1" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="skill-detail-title" id="skill-detail-title">
          {row.title} <span>Skill</span>
        </div>
        <div className="skill-detail-desc">
          {FAMILIES.map((f) => `${FAMILY_LABEL[f]}: ${row.copies[f] ? (row.copies[f]!.on ? 'on' : 'off') : 'not available'}`).join(' · ')}
        </div>
        <div className="skill-detail-body">
          {error ? (
            <p className="settings-row-desc">Couldn't read this skill: {error}</p>
          ) : body == null ? (
            <Spinner size={14} />
          ) : (
            <Markdown text={body || row.description} />
          )}
        </div>
        <div className="skill-detail-foot">
          <span />
          <button
            className="btn-white lg"
            onClick={() => {
              navigate({ name: 'home' });
              setTimeout(
                () =>
                  window.dispatchEvent(
                    new CustomEvent('insert-skill', {
                      detail: {
                        name: row.codex?.name ?? row.key,
                        path: file,
                        displayName: row.title,
                      },
                    }),
                  ),
                150,
              );
              onClose();
            }}
          >
            <MessageCirclePlus size={15} /> Try now
          </button>
        </div>
      </div>
    </div>
  );
}
