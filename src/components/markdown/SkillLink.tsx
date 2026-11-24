// Skill mentions: inline skill links and opening a skill in the side pane.

import { useEffect, useState, type ReactNode } from 'react';
import { skillName } from '../../lib/skills';
import { openSkill, openSkillClick } from '../../session/openSkill';
import { useFileMenu } from '../ui/FileMenu';
import { dirname, joinPath } from '../../lib/paths';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { parseJson } from '../../../shared/jsonRecord.mjs';
import { SkillGlyph } from './SkillGlyph';

const displayNames = new Map<string, Promise<string | null>>();
function displayName(path: string) {
  let pending = displayNames.get(path);
  if (!pending) {
    pending = native.fs
      .readText(joinPath(dirname(path), 'agents/openai.yaml'))
      .then((source) => {
        const value = /^  display_name:\s*(.+?)\s*$/m.exec(source ?? '')?.[1];
        if (!value) return null;
        if (value.startsWith('"')) {
          // a double-quoted value is a JSON string; one that doesn't parse has no usable name
          const parsed = parseJson(value);
          return parsed.ok ? (parsed.value as string) : null;
        }
        return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replace(/''/g, "'") : value;
      })
      .catch((e) => {
        // unreadable now: the folder name shows, and the next mention reads it again (a failure isn't cached)
        displayNames.delete(path);
        noteIgnored("read a skill's display name", e);
        return null;
      });
    displayNames.set(path, pending);
  }
  return pending;
}

export { openSkill };

/** Shared by assistant links, sent skill mentions, and composer attachments. */
export function SkillLink({ path, children }: { path: string; children?: ReactNode }) {
  const [label, setLabel] = useState<string | null>(null);
  const rawName = skillName(path);
  const useDisplayName = children == null || children === rawName;
  const menu = useFileMenu(path);
  useEffect(() => {
    let alive = true;
    setLabel(null);
    if (useDisplayName)
      // cannot reject: displayName answers null for a name it can't read
      void displayName(path).then((name) => {
        if (alive) setLabel(name);
      });
    return () => {
      alive = false;
    };
  }, [path, useDisplayName]);
  return (
    <>
      {/* inline in a message, with no room for a menu button: the path's menu opens on a right-click or the keyboard */}
      <a
        className="skill-link"
        href={path}
        title={path}
        onClick={(e) => {
          e.preventDefault();
          openSkillClick(path, e);
        }}
        {...menu.target}
      >
        <SkillGlyph />
        <span>{useDisplayName ? (label ?? children ?? rawName) : children}</span>
      </a>
      {menu.menu}
    </>
  );
}
