// The new-chat home page: the hero with its project chooser, and the composer.

import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { useStore } from '../../store/core';
import { newChatTarget } from '../../store/projects';
import { codexUsable, claudeUsable, savedDefaultHarness } from '../../store/chats';
import { admittedBasics } from '../../harness/launch';
import { launchKind } from '../../lib/welcome';
import { openWelcome } from './Welcome';
import { Composer } from '../composer/Composer';
import { MoPilotMark } from '../ui/icons';
import { useAnchor } from '../ui/Popover';
import { ProjectMenu } from '../composer/ProjectMenu';
import { applyNewChatDefault, newChatStartMode } from '../../session/newChatStart';

export function Home() {
  // subscribe so the title follows project changes
  useStore((s) => s.newChatProjectId);
  useStore((s) => s.savedProjects);
  useStore((s) => s.threadOrder);
  useStore((s) => s.newChatCwd);
  useStore((s) => s.newChatHost);
  const project = newChatTarget();
  const menu = useAnchor();
  const basicOnly = useStore((s) => launchKind(codexUsable(s), claudeUsable(s), admittedBasics(s.basicHarnesses).length) === 'basic-only');
  const temporary = useStore((s) => s.newChatTemporary);
  // the draft shows its own pick, else Settings' fixed default when new chats use one; again once the saved prefs load
  const start = useStore((s) => JSON.stringify([newChatStartMode(s), savedDefaultHarness(s), s.prefs.newChatDefault]));
  useEffect(() => void (start && applyNewChatDefault()), [start]);
  // Like the official app: "build" for git repositories, "work on" for plain folders.
  const root = project?.path;
  const [isRepo, setIsRepo] = useState(true);
  useEffect(() => {
    if (!root) return;
    let live = true;
    native.git.info(root).then(
      (g) => live && setIsRepo(!!g),
      (e: unknown) => {
        // only the hero's wording depends on it: say "work on", as for a plain folder
        noteIgnored("check whether the new chat's folder is a git repository", e);
        if (live) setIsRepo(false);
      },
    );
    return () => {
      live = false;
    };
  }, [root]);

  return (
    <div className="home">
      <div className="home-hero">
        <MoPilotMark size={58} className="home-mark" />
        <h1 className="home-title">
          {temporary ? (
            <span className="home-temp">Temporary chat</span>
          ) : project ? (
            <>
              What should we {isRepo ? 'build' : 'work on'} in{' '}
              <button ref={menu.ref} className="home-project" onClick={menu.toggle}>
                {project.name}
              </button>
              ?
            </>
          ) : (
            <button ref={menu.ref} className="home-project plain" onClick={menu.toggle}>
              What should we build?
            </button>
          )}
        </h1>
      </div>
      <div className="home-composer">
        <Composer threadId={null} variant="home" />
      </div>
      {basicOnly && (
        <p className="home-setup login-hint">
          Only a basic harness is set up.{' '}
          <button type="button" className="text-link" onClick={openWelcome}>
            Set up Codex or Claude Code
          </button>{' '}
          for goals, plan mode and the full chat experience.
        </p>
      )}
      <ProjectMenu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom" />
    </div>
  );
}
