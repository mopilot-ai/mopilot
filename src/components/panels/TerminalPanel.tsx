// The terminal pane: terminal tabs over the working directory, each an xterm view of a shell.

import { defaultShellName, isWin, platform } from '../../lib/platform';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useEffectOn } from '../../lib/effects';
import { onActivate } from '../../lib/focus';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { native } from '../../lib/native';
import { terminalShortcut } from '../../lib/terminalShortcuts';
import { useStore, set as setState, get as getState } from '../../store/core';
import { useResolvedDark } from '../markdown/Markdown';
import { Plus, X, SquareTerminal } from '../ui/icons';
import { basename } from '../../lib/paths';
import { machineShellTab, shellWhere, sshTargetOf, type ShellMachine } from '../../lib/machineShell';
import { clampSplit } from '../../lib/splitClamp';
import { startEdgeDrag } from '../../lib/edgeDrag';
import { noteIgnored, errorText } from '../../lib/ignored';
import { defaultPalette } from '../../../shared/defaultPalette.mjs';
import type { Tab, TermEvents, TermIo, TermTransport } from '../../session/terminalTransport';

export type { Tab, TermEvents, TermIo, TermTransport };

/** Fit a terminal to its panel. A panel with no size yet (hidden, or not laid out) throws; it is fitted again when it gets one. */
export function fitTerminal(fit: Pick<FitAddon, 'fit'> | null) {
  try {
    fit?.fit();
  } catch (e) {
    noteIgnored('fit a terminal to a panel with no size', e);
  }
}

/** A new shell tab in `cwd`, titled after the folder; for a chat on a machine added over ssh, a shell in its folder there (this Mac has no folder of it). */
function shellTab(cwd: string, machine?: ShellMachine | null): Tab {
  return (
    (machine && machineShellTab(machine, cwd)) || { id: `term-${crypto.randomUUID()}`, cwd, title: basename(cwd) || defaultShellName() }
  );
}

/** The bottom terminal keeps 120px and leaves the chat above it 200px, through the shared split clamp. */
const TERMINAL_SPLIT = { min: 120, keep: 200 };

export function TerminalPanel({ cwd, machine = null }: { cwd: string; machine?: ShellMachine | null }) {
  // the panel opens with one shell
  // a chat on a machine this Mac has no ssh to has no shell: none is started here in its place
  const noShell = !!machine && !sshTargetOf(machine.id);
  const [tabs, setTabs] = useState<Tab[]>(() => (noShell ? [] : [shellTab(cwd, machine)]));
  const [active, setActive] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [height, setHeight] = useState(260);
  const panel = useRef<HTMLDivElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  // a window made shorter after the panel opened must not leave the chat above it without room
  useEffect(() => {
    const lane = panel.current!.parentElement!;
    // a drag owns the height until it is released, and fits the column with each frame
    const ro = new ResizeObserver(() => stopDrag.current || setHeight((h) => clampSplit(h, lane.clientHeight, TERMINAL_SPLIT)));
    ro.observe(lane);
    return () => ro.disconnect();
  }, []);

  // a chat on another machine or folder than the shells open: its own shell comes up beside them, so "Open terminal" is never one on this Mac
  const where = machine && machineShellTab(machine, cwd) ? shellWhere(machine) : null;
  useEffectOn([where, noShell], () => {
    // (a chat on this Mac after one on a machine without ssh finds no tab: it gets one)
    if (noShell || (where ? tabs.some((x) => x.where === where) : tabs.length > 0)) return;
    const tab = shellTab(cwd, machine);
    setTabs((t) => [...t, tab]);
    setActive(tab.id);
  });

  const newTab = () => {
    const tab = shellTab(cwd, machine);
    setTabs((t) => [...t, tab]);
    setActive(tab.id);
  };

  // Unmounting the tab's TermView kills its pty.
  const close = (id: string) => {
    setTabs((t) => {
      const rest = t.filter((x) => x.id !== id);
      if (!rest.length) setState({ bottomPanelOpen: false });
      if (active === id) setActive(rest[rest.length - 1]?.id ?? null);
      return rest;
    });
  };

  return (
    <div className="bottom-panel" ref={panel} style={{ height }}>
      <div
        className="bottom-resize"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const startY = e.clientY;
          const startH = height;
          // the column it shares with the chat above it, not the window (the title bar is part of the window too)
          const el = panel.current!;
          const lane = el.parentElement!;
          stopDrag.current?.();
          // one height per frame on the panel itself, its state on release (src/lib/edgeDrag.ts, #2049)
          stopDrag.current = startEdgeDrag(e, {
            axis: 'row',
            size: (ev) => clampSplit(startH + startY - ev.clientY, lane.clientHeight || window.innerHeight, TERMINAL_SPLIT),
            apply: (h) => {
              el.style.height = `${h}px`;
            },
            ended: () => {
              stopDrag.current = null;
            },
            commit: setHeight,
          });
        }}
      />
      <div className="bottom-tabs">
        {tabs.map((t) => (
          // a tab, not a <button>: it holds its close button
          <div
            key={t.id}
            className={`bottom-tab ${t.id === active ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={t.id === active}
            aria-label={t.exited == null ? t.title : `${t.title} (exited)`}
            onClick={() => setActive(t.id)}
            onKeyDown={onActivate(() => setActive(t.id))}
          >
            <SquareTerminal size={13} />
            <span>{t.title}</span>
            {t.exited != null && <span className="bottom-tab-exit">exited</span>}
            <button
              className="icon-btn xs"
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                close(t.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {!noShell && (
          <button className="icon-btn xs" onClick={newTab} title="New terminal">
            <Plus size={14} />
          </button>
        )}
        <div className="bottom-tabs-spacer" />
        <button className="icon-btn xs" onClick={() => setState({ bottomPanelOpen: false })} title="Hide panel">
          <X size={14} />
        </button>
      </div>
      <div className="bottom-body">
        {noShell && <div className="bottom-note">{machine!.name} has no ssh from this Mac, so there is no terminal here.</div>}
        {tabs.map((t) => (
          <TermView
            key={t.id}
            tab={t}
            visible={t.id === active}
            onExit={(code) => setTabs((x) => x.map((y) => (y.id === t.id ? { ...y, exited: code } : y)))}
          />
        ))}
      </div>
    </div>
  );
}

/** The default: this window's own pty, started for the view and ended with it. */
const ptyTransport: TermTransport = (tab, size, on) => {
  let alive = true;
  let inputTimer: ReturnType<typeof setTimeout> | undefined;
  const off = native.pty.onEvent((e) => {
    if (e.id !== tab.id) return;
    if (e.type === 'data') on.data(e.data);
    else on.exit(e.exitCode);
  });
  native.pty
    .spawn(tab.id, {
      command: tab.command,
      windowsCommandLine: tab.windowsCommandLine,
      env: tab.env,
      cwd: tab.cwd,
      cols: size.cols,
      rows: size.rows,
      systemBrowser: tab.signIn,
    })
    .then(() => {
      if (!alive) return;
      if (tab.input) inputTimer = setTimeout(() => native.pty.write(tab.id, tab.input!), 400);
    })
    .catch((e) => {
      if (alive) on.error(errorText(e));
    });
  return {
    write: (d) => native.pty.write(tab.id, d),
    resize: (cols, rows) => native.pty.resize(tab.id, cols, rows),
    close: () => {
      alive = false;
      clearTimeout(inputTimer);
      off();
      // the pty may already have exited
      native.pty.kill(tab.id).catch((e) => noteIgnored("end a closed terminal's shell", e));
    },
  };
};

export function TermView({
  tab,
  visible,
  onExit,
  onError,
  transport,
  readOnly = false,
}: {
  tab: Tab;
  visible: boolean;
  onExit: (code: number) => void;
  onError?: (message: string) => void;
  /** a process someone else owns (a harness install run in main); by default the view starts its own pty */
  transport?: TermTransport;
  /** A shared package log accepts no terminal input. */
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const dark = useResolvedDark();
  const fontSize = useStore((s) => s.prefs.codeFontSize);
  // the latest handler: callers pass a new one each render
  const exited = useEffectEvent(onExit);
  const failed = useEffectEvent((message: string) => onError?.(message));
  const acceptsInput = useEffectEvent(() => !readOnly);

  // One shell per session id: a new id ends this one and starts another. The rest of `tab` (command, folder, input)
  // is how the session starts, and callers rebuild it each render, so it is no reason to start again; a new terminal
  // starts in the current theme and font size, and the effects below follow later changes.
  useEffectOn([tab.id], () => {
    let alive = true;
    const term = new Terminal({
      // Official terminal: 12px system monospace.
      fontFamily: termFontFamily(),
      fontSize,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      allowProposedApi: true,
      theme: termTheme(dark),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current!);
    termRef.current = term;
    fitRef.current = fit;
    // no size yet: the ResizeObserver fits it later
    fitTerminal(fit);
    const io = (transport ?? ptyTransport)(
      tab,
      { cols: term.cols, rows: term.rows },
      {
        data: (d) => term.write(d),
        exit: (code) => {
          term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`);
          exited(code);
        },
        error: (message) => {
          term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`);
          failed(message);
        },
      },
    );
    const clear = (event: Event) => {
      if ((event as CustomEvent<{ id: string }>).detail.id === 'clear-terminal' && ref.current?.contains(document.activeElement))
        term.clear();
    };
    window.addEventListener('workspace-shortcut', clear);
    term.attachCustomKeyEventHandler((event) =>
      alive ? terminalShortcut(event, getState().prefs.keybindings, () => term.clear(), platform) : true,
    );
    const dataSub = term.onData((d) => {
      if (acceptsInput()) io.write(d);
    });
    const resizeSub = term.onResize(({ rows, cols }) => io.resize(cols, rows));
    // a hidden panel has no size; it fits again when shown
    const ro = new ResizeObserver(() => fitTerminal(fit));
    ro.observe(ref.current!);
    return () => {
      alive = false;
      io.close();
      window.removeEventListener('workspace-shortcut', clear);
      dataSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      term.dispose();
    };
  });

  useEffect(() => {
    termRef.current!.options.disableStdin = readOnly;
    termRef.current!.options.cursorBlink = !readOnly;
  }, [readOnly]);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme(dark);
  }, [dark]);
  // a new code font size applies to open terminals too, refitted to the panel
  useEffect(() => {
    // the session's terminal: its effect above runs first
    const term = termRef.current!;
    if (term.options.fontSize === fontSize) return;
    term.options.fontSize = fontSize;
    fitTerminal(fitRef.current);
  }, [fontSize]);
  // fit and focus the terminal when shown, and its replacement when the session changes while shown
  useEffectOn([visible, tab.id], () => {
    if (visible) {
      const frame = requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch (e) {
          // still zero-sized: the ResizeObserver fits it later
          noteIgnored('fit a terminal to a panel with no size', e);
        }
        termRef.current?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
  });

  return (
    <div
      className="term-view"
      ref={ref}
      role={readOnly ? 'log' : undefined}
      aria-label={readOnly ? 'Command output' : undefined}
      style={{ display: visible ? 'block' : 'none' }}
    />
  );
}

/** Official terminal: 12px system monospace. */
export function termFontFamily(win = isWin) {
  return win ? 'Consolas, "Cascadia Mono", monospace' : 'Menlo, monospace';
}

function termTheme(dark: boolean) {
  const { bg, fg, selection } = defaultPalette(dark);
  return { background: bg, foreground: fg, cursor: fg, selectionBackground: selection };
}
