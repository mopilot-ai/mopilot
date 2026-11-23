// Settings → Connections: the optional built-in connectors (GitHub, for every harness) and the macOS Quick Actions. Both are off until the user turns them on here; turning on is the only thing that downloads or writes outside the app's own folders.

import { useEffect, useState } from 'react';
import { Group, Row, Toggle } from './Controls';
import { native } from '../../../lib/native';
import { toast } from '../../../store/core';
import type { BuiltinConnector } from '../../../lib/native/contracts/builtinConnectors';
import type { QuickActionsStatus } from '../../../lib/native/contracts/quickActions';

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Built-in connectors, one switch each: on installs it for Codex, Claude Code and the other harnesses. */
export function BuiltinConnectors() {
  const [list, setList] = useState<BuiltinConnector[]>([]);
  useEffect(() => {
    let live = true;
    native.plugins.builtin.list().then(
      (l) => live && setList(l),
      (e) => live && toast(failure(e), 'error'),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!list.length) return null;
  return (
    <Group title="Built-in connectors">
      {list.map((c) => (
        <Row key={c.id} title={c.title} desc={c.state === 'unavailable' ? c.why : `${c.description} Version ${c.version}.`}>
          <Toggle
            on={c.state === 'on'}
            disabled={c.state === 'unavailable'}
            label={c.title}
            onChange={async (on) => {
              try {
                setList(await native.plugins.builtin.set(c.id, on));
              } catch (e) {
                toast(failure(e), 'error');
              }
            }}
          />
        </Row>
      ))}
    </Group>
  );
}

/** The Services-menu actions: Ask, New Chat Here (Finder) and Send to MoPilot. Not offered where they can't be installed. */
export function QuickActions() {
  const [status, setStatus] = useState<QuickActionsStatus | null>(null);
  useEffect(() => {
    let live = true;
    native.app.quickActions.status().then(
      (s) => live && setStatus(s),
      (e) => live && toast(failure(e), 'error'),
    );
    return () => {
      live = false;
    };
  }, []);
  if (!status || status.state === 'unavailable') return null;
  return (
    <Group title="macOS">
      <Row
        title="Quick Actions"
        desc={
          status.state === 'stale'
            ? 'Out of date. Turn off and on to update.'
            : 'Ask, send files or start a chat from the Services menu and Finder.'
        }
      >
        <Toggle
          on={status.state !== 'off'}
          label="Quick Actions"
          onChange={async (on) => {
            try {
              setStatus(await native.app.quickActions.set(on));
            } catch (e) {
              toast(failure(e), 'error');
            }
          }}
        />
      </Row>
    </Group>
  );
}
