// Execute authored TSX through the real parser, compatibility SDK and React renderer, including state and failure recovery.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { render, typeInto } from './support/shell-panels-kit.ts';
import { compileCanvas } from '../src/lib/canvas/compile.ts';
import { canvasRequire, canvasRuntime } from '../src/lib/canvas/runtime.tsx';
import { CanvasContext, canvasEnvironment, useCanvasState, useHostTheme, useCanvasAction } from '../src/lib/canvas/context.tsx';
import { authoredCanvas as authored } from './support/canvas-kit.ts';
const click = async (host: HTMLElement, text: string) =>
  act(() => {
    const button = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes(text));
    assert.ok(button, text);
    button.click();
  });

test('a typed plan renders headings, theme tokens, roadmap tables, disclosures and view switches', async () => {
  const Plan =
    authored(`import { Stack, Row, Grid, H1, H2, Text, Pill, Stat, Table, CollapsibleSection, useCanvasState, useHostTheme } from 'cursor/canvas';
    type Task = { title: string; days: number };
    const tasks: Task[] = [{title:'Repair quarantined journeys', days:3}, {title:'Harden recovery',days:2}];
    export default function Plan() {
      const theme=useHostTheme(); const [view,setView]=useCanvasState('view','Roadmap');
      return <Stack style={{color:theme.text.primary}}><H1>Improve reliability while preserving delivery speed</H1>
        <Grid columns={2}><Stat value={32} label="Incidents"/><Stat value="66%" label="Recorded stability"/></Grid>
        <Row><Pill active={view==='Roadmap'} onClick={()=>setView('Roadmap')}>Roadmap</Pill><Pill active={view==='Evidence'} onClick={()=>setView('Evidence')}>Evidence</Pill></Row>
        {view==='Roadmap'?<><H2>Delivery order</H2><Table headers={['Task','Days']} rows={tasks.map(t=>[t.title,t.days])}/><CollapsibleSection title="Acceptance targets" count={0}><Text>Original repro passes</Text></CollapsibleSection></>:<Text>32 captured incidents</Text>}
      </Stack>;
    }`);
  const sent: any[] = [];
  const environment = canvasEnvironment(true, {}, (message) => sent.push(message));
  const r = await render(h(CanvasContext.Provider, { value: environment }, h(Plan)));
  try {
    assert.match(r.host.querySelector('h1')!.textContent!, /Improve reliability/);
    assert.equal(r.host.querySelectorAll('tbody tr').length, 2);
    assert.match(r.host.textContent!, /Repair quarantined journeys/);
    assert.doesNotMatch(r.host.textContent!, /Original repro passes/);
    await click(r.host, 'Acceptance targets');
    assert.match(r.host.textContent!, /Original repro passes/);
    await click(r.host, 'Acceptance targets');
    assert.doesNotMatch(r.host.textContent!, /Original repro passes/);
    await click(r.host, 'Evidence');
    assert.equal(r.host.querySelector('table'), null);
    assert.match(r.host.textContent!, /32 captured incidents/);
    await click(r.host, 'Roadmap');
    assert.equal(r.host.querySelectorAll('tbody tr').length, 2);
    assert.deepEqual(
      sent.map((m) => [m.key, m.value]),
      [
        ['view', 'Evidence'],
        ['view', 'Roadmap'],
      ],
    );
  } finally {
    await r.unmount();
  }
});

test('keyed controls share updates, retain object defaults, use saved values and keep independent keys', async () => {
  const environment = canvasEnvironment(false, { count: 4 }, () => {});
  const setters: unknown[] = [];
  const dispatchers: unknown[] = [];
  function Control() {
    const [count, setCount] = useCanvasState('count', 0);
    const [filter, setFilter] = useCanvasState('filter', { value: 'all' });
    const theme = useHostTheme();
    setters.push(setCount);
    dispatchers.push(useCanvasAction());
    assert.equal(theme.tokens.surface.canvas, 'var(--background)');
    return h(
      'button',
      {
        onClick: () => {
          setCount((n) => n + 1);
          setFilter((previous) => ({ value: previous.value === 'all' ? 'open' : 'all' }));
        },
      },
      `${theme.kind} ${count} ${filter.value}`,
    );
  }
  const r = await render(h(CanvasContext.Provider, { value: environment }, h('div', null, h(Control), h(Control))));
  try {
    await click(r.host, 'light 4 all');
    assert.deepEqual(
      [...r.host.querySelectorAll('button')].map((b) => b.textContent),
      ['light 5 open', 'light 5 open'],
    );
    assert.equal(setters[0], setters[2]);
    assert.equal(dispatchers[0], dispatchers[2]);
    await act(() => environment.restore({ count: 10 }, 3, 2));
    await act(() => environment.restore({ count: 999 }, 2, 2));
    assert.deepEqual(
      [...r.host.querySelectorAll('button')].map((b) => b.textContent),
      ['light 10 all', 'light 10 all'],
    );
    await r.rerender(h(CanvasContext.Provider, { value: environment }, h(Control)));
    assert.equal(r.host.textContent, 'light 10 all');
  } finally {
    await r.unmount();
  }
});

test('older restore acknowledgments preserve newer local typing and functional updates', async () => {
  const sent: any[] = [];
  const environment = canvasEnvironment(false, {}, (message) => sent.push(message));
  function Counter() {
    const [count, setCount] = useCanvasState('count', 0);
    return h('button', { onClick: () => setCount((previous) => previous + 1) }, String(count));
  }
  const r = await render(h(CanvasContext.Provider, { value: environment }, h(Counter)));
  try {
    await click(r.host, '0');
    await click(r.host, '1');
    await act(() => environment.restore({ count: 1, filter: 'open' }, 1, 1));
    assert.equal(r.host.textContent, '2', 'the first acknowledgment cannot rewind a newer local edit');
    assert.deepEqual(
      sent.map((m) => [m.sequence, m.value]),
      [
        [1, 1],
        [2, 2],
      ],
    );
    assert.equal(environment.get('filter', 'all'), 'open', 'unrelated authoritative keys still arrive');
    await click(r.host, '2');
    assert.equal(sent.at(-1).value, 3, 'the next functional edit starts from the latest local value');
    await act(() => environment.restore({ count: 2 }, 2, 2));
    assert.equal(r.host.textContent, '3');
    await act(() => environment.restore({ count: 3 }, 3, 3));
    await act(() => environment.restore({ count: 4 }, 4, 3));
    assert.equal(r.host.textContent, '4', 'acknowledged edits no longer mask a later external change');
  } finally {
    await r.unmount();
  }
});

test('forms use value callbacks, links and host actions publish through their own environment', async () => {
  const sent: any[] = [];
  const Plan =
    authored(`import { TextInput, TextArea, Select, Checkbox, Toggle, IconButton, Button, Link, useCanvasState, useCanvasAction } from 'cursor/canvas';
    export default function Plan(){ const [name,setName]=useCanvasState('name',''); const [check,setCheck]=useCanvasState('check',false); const dispatch=useCanvasAction();
      return <><TextInput placeholder="Search" value={name} onChange={setName}/><TextArea placeholder="Notes" value={name} onChange={setName}/>
      <Select placeholder="Priority" options={[{value:'',label:'All'},{value:'open',label:'Open'}]} value={name} onChange={setName}/>
      <Checkbox checked={check} onChange={setCheck} label="Accepted"/><Toggle checked={check} onChange={setCheck}/>
      <IconButton title="Open source" onClick={()=>dispatch({type:'openFile',path:'/repo/source.ts'})}>Open</IconButton>
      <Button onClick={()=>setName('complete')}>Complete</Button><Link href="https://example.com/evidence">Evidence</Link><output>{name} {String(check)}</output></>;
    }`);
  const r = await render(h(CanvasContext.Provider, { value: canvasEnvironment(false, {}, (message) => sent.push(message)) }, h(Plan)));
  try {
    await act(() => typeInto(r.host.querySelector('input')!, 'open'));
    assert.match(r.host.querySelector('output')!.textContent!, /open/);
    await act(() => {
      const input = r.host.querySelector('textarea')!;
      typeInto(input as unknown as HTMLInputElement, 'notes');
    });
    assert.match(r.host.querySelector('output')!.textContent!, /notes/);
    await act(() => {
      const select = r.host.querySelector('select')!;
      select.value = 'open';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    assert.match(r.host.querySelector('output')!.textContent!, /open/);
    await act(() => r.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    assert.equal(r.host.querySelector('[role="switch"]')!.getAttribute('aria-checked'), 'true');
    await click(r.host, 'On');
    assert.match(r.host.querySelector('output')!.textContent!, /false/);
    await click(r.host, 'Open');
    assert.equal(sent.at(-1).action.path, '/repo/source.ts');
    await click(r.host, 'Complete');
    assert.match(r.host.querySelector('output')!.textContent!, /complete/);
    await act(() => r.host.querySelector<HTMLAnchorElement>('a')!.click());
    assert.deepEqual(sent.at(-1), { type: 'link', href: 'https://example.com/evidence' });
  } finally {
    await r.unmount();
  }
});

test('canvas modules accept React imports and reject unavailable imports and malformed source explicitly', () => {
  assert.equal(typeof authored(`import React from 'react'; export default () => <span>Works</span>;`), 'function');
  assert.equal(typeof authored(`import {jsx} from 'react/jsx-runtime'; export default () => jsx('span',{children:'Works'});`), 'function');
  assert.equal((canvasRequire('react/jsx-runtime') as any).Fragment, (canvasRequire('react') as any).Fragment);
  assert.equal((canvasRequire('cursor/canvas') as any).__esModule, true);
  assert.throws(() => authored(`import fs from 'node:fs'; export default fs.readFileSync('secret');`), /unavailable module/);
  assert.throws(
    () => authored(`import { MissingWidget } from 'cursor/canvas'; export default () => <MissingWidget/>;`)(),
    /unsupported component/,
  );
  assert.throws(() => canvasRequire('cursor/canvas')[Symbol('unknown') as any], /unsupported component/);
  assert.throws(() => compileCanvas('export default function Broken( {'), /Unexpected|Unterminated|Expected/);
});

test('the iframe reports ready only after a component mounts, and reports render and asynchronous errors', async () => {
  const sent: any[] = [];
  const post = mock.method(window, 'postMessage', (message: unknown) => sent.push(message));
  const logged = mock.method(console, 'error', () => {});
  const root = document.createElement('div');
  document.body.append(root);
  const runtime = canvasRuntime(window as any, root, { id: 'own-frame', dark: false, state: {} });
  try {
    assert.equal(runtime.React.createElement, (canvasRequire('react') as any).createElement);
    assert.equal(runtime.require, canvasRequire);
    assert.throws(() => runtime.mount(undefined as any), /default-export/);
    await act(() => runtime.mount(() => h('h1', null, 'Rendered plan')));
    assert.equal(root.textContent, 'Rendered plan');
    assert.deepEqual(sent.at(-1), { channel: 'mopilot-canvas', id: 'own-frame', type: 'booted' });
    const bootedCount = sent.length;
    const restore = { channel: 'mopilot-canvas', id: 'own-frame', type: 'restore', revision: 0, acknowledged: 0, state: {} };
    for (const data of [
      null,
      { ...restore, channel: 'other' },
      { ...restore, id: 'other' },
      { ...restore, type: 'other' },
      { ...restore, state: null },
      { ...restore, state: 42 },
      { ...restore, state: [] },
      { ...restore, revision: 0.5 },
      { ...restore, revision: -1 },
      { ...restore, acknowledged: undefined },
      { ...restore, acknowledged: -1 },
    ]) {
      await act(() => window.dispatchEvent(new window.MessageEvent('message', { source: window, data })));
    }
    await act(() => window.dispatchEvent(new window.MessageEvent('message', { source: null, data: restore })));
    assert.equal(sent.length, bootedCount, 'foreign or malformed restore requests cannot acknowledge readiness');
    await act(() =>
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: window,
          data: restore,
        }),
      ),
    );
    assert.deepEqual(sent.at(-1), { channel: 'mopilot-canvas', id: 'own-frame', type: 'ready', revision: 0 });
    const error = new window.ErrorEvent('error', { cancelable: true });
    window.dispatchEvent(error);
    assert.equal(error.defaultPrevented, true);
    assert.equal(sent.at(-1).type, 'error');
    await act(() =>
      runtime.mount(() => {
        throw Error('broken authored component');
      }),
    );
    assert.match(root.textContent!, /could not be rendered/);
    assert.equal(sent.at(-1).type, 'error');
    await act(() => runtime.failure(Error('<script>not markup</script>')));
    assert.match(root.querySelector('pre')!.textContent!, /<script>/);
    assert.equal(root.querySelector('script'), null);
    await act(() => runtime.failure('non-Error failure'));
    assert.equal(root.querySelector('pre')!.textContent, 'non-Error failure');
  } finally {
    await act(() => runtime.dispose());
    root.remove();
    post.mock.restore();
    logged.mock.restore();
  }
});

test('missing preview context produces a useful failure instead of pretending persistent controls work', async () => {
  const logged = mock.method(console, 'error', () => {});
  function MissingContext() {
    useCanvasAction();
    return null;
  }
  try {
    await assert.rejects(render(h(MissingContext)), /require a canvas preview/);
  } finally {
    logged.mock.restore();
  }
});

test('the bundled entry reads its own input and a failed bootstrap cannot later announce readiness', async () => {
  const post = mock.method(window, 'postMessage', () => {});
  const input = document.createElement('script');
  input.id = 'canvas-input';
  input.textContent = JSON.stringify({ id: 'entry', dark: true, state: {} });
  const root = document.createElement('div');
  root.id = 'canvas-root';
  document.body.append(input, root);
  try {
    await import('../src/lib/canvas/entry.ts');
    const runtime = (window as any).MoPilotCanvas;
    await act(() => runtime.failure('bootstrap failed'));
    assert.equal(post.mock.calls.at(-1)!.arguments[0].type, 'error');
    await act(() => runtime.mount(() => h('h1', null, 'Late completion')));
    assert.equal(root.textContent, 'Late completion');
    assert.equal(post.mock.calls.filter((call) => call.arguments[0].type === 'ready').length, 0);
    await act(() => runtime.dispose());
  } finally {
    root.remove();
    input.remove();
    post.mock.restore();
  }
});
