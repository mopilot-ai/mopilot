// The PR inbox's live sources for a chat, on every harness: the chat and the sessions it started (theirs too), each one's
// tracked PR from the PR monitor or its worktree branch, optionally every other PR its history names, the PR's status
// from the app's one PR reader, and the session's live state and question.
import { useEffect, useMemo, useState } from 'react';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { linkedChildren, useOrchestration } from '../../lib/sideSessions';
import { visiblePoll } from '../../lib/visiblePoll';
import { windowReady } from '../../lib/windowReady';
import { historyVersion, pullRequestUrl, type ThreadPullRequest } from '../../lib/threadPullRequest';
import type { OrchestrationView } from '../../../shared/orchestration';
import type { PrMonitorState } from '../../lib/native/prMonitor';
import type { SessionCardState } from './SessionCard';
import { inboxView, startOfDay, type InboxSource, type InboxView } from '../../lib/prInbox';
import { lastAnswers, lastGood, lastListed } from '../../lib/prLastAnswer';
import { readPullRequest } from '../../session/pullRequestReader';
import { useStore } from '../../store/core';
import { nativeOf } from '../../store/chats';

/** A session that may still act on its PR itself. */
const BUSY: ReadonlySet<SessionCardState> = new Set(['starting', 'working', 'queued', 'waiting']);

/** How often an open chat reads its family's PRs again; the reader's own minute cache makes a sooner read free. */
export const INBOX_POLL_MS = 60_000;

/** `chatId` and every chat below it, parents before children, each once (a damaged record's loop stops the walk). */
export function familyOf(view: OrchestrationView, chatId: string): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    linkedChildren(view, id).forEach(walk);
  };
  walk(chatId);
  return out;
}

/** Each chat's PR link: the one its PR monitor tracks (`bound`), else the one its worktree branch opened. */
export function familyUrls(view: OrchestrationView, family: string[], monitors: Record<string, PrMonitorState | null>) {
  const urls: { chatId: string; url: string; bound: boolean }[] = [];
  for (const id of family) {
    const tracked = pullRequestUrl(monitors[id]?.url);
    const url = tracked ?? pullRequestUrl(view.children[id]?.facts?.pr?.url);
    if (url) urls.push({ chatId: id, url, bound: !!tracked });
  }
  return urls;
}

/** The family's PR monitor rows, read once per chat and again when main says one changed. */
function useMonitors(family: string[], on: boolean) {
  const key = on ? family.join('\n') : '';
  const [monitors, setMonitors] = useState<Record<string, PrMonitorState | null>>({});
  useEffect(() => {
    if (!key) return;
    const ids = key.split('\n');
    let live = true;
    // a later read of a chat replaces an earlier one that settles after it
    const asked: Record<string, number> = {};
    const read = (id: string) => {
      const n = (asked[id] = (asked[id] ?? 0) + 1);
      void windowReady()
        .then(() => native.prMonitor.snapshot(id))
        .then((state) => {
          if (live && asked[id] === n) setMonitors((was) => ({ ...was, [id]: state }));
        })
        .catch(ignoring('read a session PR monitor'));
    };
    ids.forEach(read);
    const off = native.prMonitor.onChanged((id) => {
      if (ids.includes(id)) read(id);
    });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return monitors;
}

/**
 * Each link's last status, read now and every minute while the window shows; a read that failed keeps the last full
 * answer, and a remount starts from it instead of from nothing.
 */
function useStatuses(urls: string[]) {
  const key = urls.join('\n');
  const [statuses, setStatuses] = useState<Record<string, ThreadPullRequest>>(() =>
    Object.fromEntries(urls.flatMap((u) => (lastAnswers.has(u) ? [[u, lastAnswers.get(u)!]] : []))),
  );
  useEffect(() => {
    if (!key) return;
    let live = true;
    const readAll = () => {
      for (const url of key.split('\n'))
        readPullRequest
          .status(url)
          .then((answer) => {
            // a read always answers, with unknown status at worst
            const pr = lastGood(url, answer)!;
            if (live) setStatuses((was) => (was[url] === pr ? was : { ...was, [url]: pr }));
          })
          .catch(ignoring('read a session PR'));
    };
    readAll();
    const stop = visiblePoll('pr-inbox', INBOX_POLL_MS, readAll);
    return () => {
      live = false;
      stop();
    };
  }, [key]);
  return statuses;
}

/**
 * Every PR each chat's history names, read now and every minute while the window shows. A chat updating doesn't read
 * again by itself: a running session's history changes constantly, and the minute's read picks up its latest version.
 */
function useListed(family: string[], on: boolean) {
  const key = on ? family.join('\n') : '';
  const [listed, setListed] = useState<Record<string, ThreadPullRequest[]>>(() =>
    Object.fromEntries(family.flatMap((id) => (lastListed.has(id) ? [[id, lastListed.get(id)!]] : []))),
  );
  useEffect(() => {
    if (!key) return;
    let live = true;
    const readAll = () => {
      for (const id of key.split('\n')) {
        const thread = useStore.getState().threads[id];
        // a chat this window doesn't know has no history to name: its tracked PR still shows
        if (!thread) continue;
        readPullRequest
          .listed(id, historyVersion(thread.updatedAt, nativeOf(id)))
          .then((prs) => {
            const good = prs.map((pr) => lastGood(pr.url, pr)!);
            lastListed.set(id, good);
            if (live) setListed((was) => (JSON.stringify(was[id]) === JSON.stringify(good) ? was : { ...was, [id]: good }));
          })
          .catch(ignoring("list a chat's PRs"));
      }
    };
    readAll();
    const stop = visiblePoll('pr-inbox-listed', INBOX_POLL_MS, readAll);
    return () => {
      live = false;
      stop();
    };
  }, [key]);
  return listed;
}

const knownState = (pr: ThreadPullRequest) => pr.state === 'merged' || pr.state === 'closed' || !!pr.details;

/**
 * The chat's family (itself first) and its inbox. `states`: the family's live session states, which the caller's probes
 * report (a hook can't read one per chat). By default it reads only the PRs each chat tracks, and merges of today, with a
 * null inbox for a chat that started no session: cheap enough for every main chat's sidebar row. `all` reads every PR the
 * family's histories name, of any date, for the one chat on screen, which needs no session to have PRs of its own.
 */
export function usePrInbox(
  chatId: string,
  states: Record<string, SessionCardState>,
  options: { all: true },
): { view: InboxView; family: string[] };
export function usePrInbox(chatId: string, states: Record<string, SessionCardState>): { view: InboxView | null; family: string[] };
export function usePrInbox(
  chatId: string,
  states: Record<string, SessionCardState>,
  { all = false }: { all?: boolean } = {},
): { view: InboxView | null; family: string[] } {
  const view = useOrchestration();
  const familyKey = familyOf(view, chatId).join('\n');
  const family = useMemo(() => familyKey.split('\n'), [familyKey]);
  const on = all || family.length > 1;
  const monitors = useMonitors(family, on);
  const listed = useListed(family, all);
  const links = familyUrls(view, family, monitors);
  const statuses = useStatuses(links.map((l) => l.url));
  if (!on) return { view: null, family };
  const sessionName = (id: string) => (id === chatId ? null : view.children[id].name);
  const tracked: InboxSource[] = links.map(({ chatId: id, url, bound }) => {
    const wrap = view.wrapUps[id];
    return {
      url,
      chatId: id,
      // every chat below the main one is a linked child
      session: sessionName(id),
      pr: statuses[url] ?? null,
      // the main chat's own question shows in its own wrap-up box, right above
      asking: id !== chatId && states[id] === 'needsInput',
      busy: !!states[id] && BUSY.has(states[id]),
      ask: wrap?.ask ? { text: wrap.ask, actions: wrap.actions } : null,
      // what the monitor says is about its own link, never a branch's PR it doesn't track
      monitor: bound ? monitors[id] : null,
    };
  });
  // a parent's reply often reports a session's PR, so the sessions come first: the first source for a link names its chat.
  // Only a tracked PR carries its session's question and monitor: those say nothing about the session's other PRs. A PR
  // only named needs a known state to count: with GitHub unreadable, every old PR would otherwise read as open.
  const named: InboxSource[] = family.toReversed().flatMap((id) =>
    (listed[id] ?? []).filter(knownState).map((pr) => ({
      url: pr.url,
      chatId: id,
      session: sessionName(id),
      pr,
      busy: !!states[id] && BUSY.has(states[id]),
    })),
  );
  return { view: inboxView([...tracked, ...named], all ? null : startOfDay(Date.now())), family };
}
