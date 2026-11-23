// Compatibility examples preserve table structure, controlled disclosures, value callbacks and chart data across authored variants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act } from 'react';
import { typeInto } from './support/shell-panels-kit.ts';
import { renderCanvasSource } from './support/canvas-kit.ts';

test('layout and data surfaces retain nested content, column alignment, padded rows and empty-state labels', async () => {
  const r =
    await renderCanvasSource(`import { Stack, Row, Grid, H1, H2, H3, Text, Code, Spacer, Divider, Table, Stat, Callout, mergeStyle } from 'cursor/canvas';
    export default ()=><Stack><Row><H1>Plan</H1><Spacer/><Code>rev</Code></Row><Row wrap gap={2} justify="space-between"><Text as="span" size="small" tone="secondary" weight="semibold" italic truncate>Evidence</Text></Row>
      <Grid columns="1fr 2fr"><H2>Findings</H2><H3>Sources</H3></Grid><Divider/><Divider style={mergeStyle({margin:0},{margin:3})}/>
      <Text style={mergeStyle({padding:0})}>Default text</Text><Stat value={32} label="Incidents" tone="warning"/>
      <Callout title="Scope" tone="warning" icon="!">Preserve source</Callout><Callout>Default callout</Callout>
      <Table headers={['Name','Value']} rows={[[<Code key="name">first</Code>,2,'ignored'],[<Code>second</Code>],['third',3]]} columnAlign={['left','right']} rowTone={['success',undefined,'warning']} striped stickyHeader/>
      <Table headers={['Empty']} rows={[]} framed={false} emptyMessage="Nothing selected"/>
      <Table headers={['Default empty']} rows={[]}/>
    </Stack>;`);
  try {
    assert.equal(r.host.querySelector('h1')!.textContent, 'Plan');
    assert.equal(r.host.querySelector('h2')!.textContent, 'Findings');
    assert.equal(r.host.querySelector('h3')!.textContent, 'Sources');
    const table = r.host.querySelector('table')!;
    assert.equal(table.querySelectorAll('tbody tr').length, 3);
    assert.equal(table.querySelectorAll('tbody tr')[1].querySelectorAll('td').length, 2);
    assert.doesNotMatch(table.textContent!, /ignored/);
    assert.equal(table.querySelector('tr td:last-child')!.getAttribute('style')!.includes('right'), true);
    assert.equal(table.querySelector('[aria-label="success"]')!.textContent, '●');
    assert.match(r.host.textContent!, /Nothing selected/);
    assert.match(r.host.textContent!, /No rows/);
    assert.match(r.host.textContent!, /Preserve source/);
  } finally {
    await r.unmount();
  }
});

test('cards support uncontrolled and controlled expansion while keeping header actions and outside-card content readable', async () => {
  const r = await renderCanvasSource(`import { Card, CardHeader, CardBody, Button, useCanvasState } from 'cursor/canvas';
    export default function Cards(){const [open,setOpen]=useCanvasState('open',false);return <>
      <CardHeader trailing="metadata">Outside header</CardHeader><CardBody>Outside body</CardBody>
      <Card><CardHeader>Default card</CardHeader><CardBody>Always readable</CardBody></Card>
      <Card collapsible defaultOpen={false} variant="borderless" size="lg" stickyHeader><CardHeader trailing="count">Uncontrolled</CardHeader><CardBody>Hidden until opened</CardBody></Card>
      <Card collapsible open={open} onOpenChange={setOpen}><CardHeader>Controlled</CardHeader><CardBody>Controlled body</CardBody></Card>
      <Button disabled>Disabled action</Button>
    </>;}`);
  try {
    assert.match(r.host.textContent!, /Outside body/);
    assert.match(r.host.textContent!, /Always readable/);
    assert.doesNotMatch(r.host.textContent!, /Hidden until opened|Controlled body/);
    const buttons = [...r.host.querySelectorAll('button')];
    await act(() => buttons.find((b) => b.textContent!.includes('Uncontrolled'))!.click());
    assert.match(r.host.textContent!, /Hidden until opened/);
    await act(() => buttons.find((b) => b.textContent === 'Controlled')!.click());
    assert.match(r.host.textContent!, /Controlled body/);
    assert.equal(buttons.find((b) => b.textContent === 'Disabled action')!.disabled, true);
  } finally {
    await r.unmount();
  }
});

test('badges, disabled inputs and optional control callbacks keep their advertised accessible behavior', async () => {
  const r = await renderCanvasSource(`import { Pill, TextInput, TextArea, Select, Checkbox, Toggle, IconButton } from 'cursor/canvas';
    export default ()=> <>
      <Pill title="Status" tone="success" size="sm" leadingContent="✓" keyboardHint="K">Approved</Pill>
      <Pill active disabled onClick={()=>{throw Error('disabled')}}>Disabled pill</Pill>
      <TextInput placeholder="Optional input"/><TextArea placeholder="Optional notes" rows={2}/>
      <TextInput placeholder="Disabled input" disabled/><TextArea placeholder="Disabled notes" disabled/>
      <Select options={[{value:'open',label:'Open',disabled:true},{value:'closed',label:'Closed'}]}/>
      <Checkbox/><Toggle/><Toggle size="sm" disabled checked/><IconButton variant="circle" size="sm" title="Optional action">x</IconButton><IconButton title="Normal action">y</IconButton>
    </>;`);
  try {
    assert.equal(r.host.querySelector('kbd')!.textContent, 'K');
    assert.equal(r.host.querySelector('[title="Status"]')!.tagName, 'SPAN');
    assert.equal([...r.host.querySelectorAll('button')].find((b) => b.textContent === 'Disabled pill')!.disabled, true);
    await act(() => typeInto(r.host.querySelector<HTMLInputElement>('input[placeholder]')!, 'optional'));
    await act(() => {
      const area = r.host.querySelector('textarea')!;
      typeInto(area as unknown as HTMLInputElement, 'optional');
    });
    await act(() => {
      const select = r.host.querySelector('select')!;
      select.value = 'closed';
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await act(() => r.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(() => r.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    assert.equal(r.host.querySelectorAll('[role="switch"]')[1].getAttribute('aria-checked'), 'true');
    assert.equal(r.host.querySelector('[aria-label="Optional action"]')!.getAttribute('title'), 'Optional action');
    for (const control of r.host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[aria-disabled="true"]')) {
      assert.equal(control.readOnly, true);
      assert.equal(control.disabled, false, 'temporarily disabled text controls preserve keyboard focus');
    }
  } finally {
    await r.unmount();
  }
});

test('bar charts retain categories, series legends and signed values for grouped, stacked, horizontal and normalized data', async () => {
  const r = await renderCanvasSource(`import { BarChart } from 'cursor/canvas';
    const categories=['Week 1','Week 2','Week 3'];const series=[{name:'Success',data:[4,-2,0],tone:'success'},{name:'Failure',data:[1,-3]}];
    export default ()=><>
      <BarChart categories={categories} series={series}/>
      <BarChart categories={categories} series={series} stacked horizontal showValues height={300} valuePrefix="$" valueSuffix="h" beginAtZero={false} referenceLines={[{value:8,label:'Budget'}]}/>
      <BarChart categories={categories} series={series} stacked normalized showValues yMin={-100} yMax={100} referenceLines={[{value:50,label:'Threshold',tone:'warning'}]}/>
      <BarChart categories={[]} series={[]} yMin={2} yMax={2}/>
      <BarChart categories={[]} series={[]} beginAtZero={false} yMin={Infinity}/>
    </>;`);
  try {
    const figures = r.host.querySelectorAll('figure');
    assert.equal(figures.length, 5);
    assert.match(figures[0].textContent!, /Week 1/);
    assert.match(figures[0].textContent!, /Success/);
    assert.match(figures[0].textContent!, /Failure/);
    assert.match(figures[0].querySelector('title')!.textContent!, /Week 1 · Success: 4/);
    assert.match(figures[1].textContent!, /\$-3h/);
    assert.match(figures[1].textContent!, /Budget/);
    assert.match(figures[2].textContent!, /Threshold/);
    assert.match(figures[2].textContent!, /100%/);
    for (const rect of r.host.querySelectorAll('rect')) {
      assert.ok(Number(rect.getAttribute('width')) >= 0);
      assert.ok(Number(rect.getAttribute('height')) >= 0);
    }
  } finally {
    await r.unmount();
  }
});

test('line and pie charts preserve exact values, references, legends and a usable zero-valued or missing-data plot', async () => {
  const r = await renderCanvasSource(`import { LineChart, PieChart } from 'cursor/canvas';
    const categories=['Mon','Tue'];const series=[{name:'Latency',data:[10,20],tone:'info'},{name:'Target',data:[15]}];
    export default ()=><>
      <LineChart categories={categories} series={series}/>
      <LineChart categories={categories} series={series} fill showValues referenceLines={[{value:15,label:'Budget'},{value:20,label:'Limit',tone:'danger'}]} valueSuffix="ms"/>
      <LineChart categories={['Only']} series={[{name:'Zero',data:[0]}]}/>
      <PieChart data={[{label:'Passed',value:3,tone:'success'},{label:'Failed',value:1},{label:'Unused',value:-1}]}/>
      <PieChart data={[{label:'Empty',value:0}]} donut size={160}/>
    </>;`);
  try {
    const figures = r.host.querySelectorAll('figure');
    assert.equal(figures.length, 5);
    assert.match(figures[0].textContent!, /Mon · Latency: 10/);
    assert.match(figures[1].textContent!, /Budget/);
    assert.match(figures[1].textContent!, /20ms/);
    assert.match(figures[3].textContent!, /Passed: 3/);
    assert.match(figures[3].textContent!, /Failed: 1/);
    assert.equal(figures[4].querySelector('svg')!.getAttribute('width'), '160');
    for (const line of r.host.querySelectorAll('polyline')) assert.doesNotMatch(line.getAttribute('points')!, /NaN|Infinity/);
  } finally {
    await r.unmount();
  }
});

test('normalized alone produces a 100-percent stack rather than grouped partial composition', async () => {
  const r = await renderCanvasSource(
    `import {BarChart} from 'cursor/canvas';export default()=> <BarChart normalized categories={['A']} series={[{name:'One',data:[3]},{name:'Two',data:[1]}]}/>;`,
  );
  try {
    const bars = r.host.querySelectorAll('rect');
    assert.equal(bars[0].getAttribute('x'), bars[1].getAttribute('x'), 'normalized implies stacked');
    assert.equal(bars[0].getAttribute('width'), bars[1].getAttribute('width'));
    assert.match(r.host.textContent!, /100%/);
  } finally {
    await r.unmount();
  }
});

test('grouped bars honor data-only and explicit domains and suppress automatic labels in dense plots', async () => {
  const r = await renderCanvasSource(`import {BarChart} from 'cursor/canvas';
    export default()=> <>
      <BarChart categories={['A','B']} series={[{name:'Latency',data:[10,20]}]} beginAtZero={false} showValues valueSuffix="ms"/>
      <BarChart categories={['A']} series={[{name:'Latency',data:[10]}]} yMin={5} yMax={15} showValues/>
      <BarChart categories={['A','B','C','D','E','F','G','H','I']} series={[{name:'Latency',data:[1,2,3,4,5,6,7,8,9]}]}/>
    </>;`);
  try {
    const figures = r.host.querySelectorAll('figure');
    assert.equal(figures[0].querySelector('svg > text')!.textContent, '10ms');
    assert.equal(figures[1].querySelector('svg > text')!.textContent, '5');
    assert.equal(figures[0].querySelectorAll('svg > g > g > text').length, 2);
    assert.equal(figures[2].querySelectorAll('svg > g > g > text').length, 0);
    assert.equal(figures[2].querySelectorAll('rect').length, 9);
  } finally {
    await r.unmount();
  }
});
