// A developer screen for the in-place selection (#4837): the same Markdown laid out by the React Native renderer and by the native text run, heights side by side at the system's text size, a stack of 30 runs whose total must agree, and the edit menu's own entry counted. Built only with MOPILOT_SELECTABLE_PROBE=1.
import { useState } from 'react';
import { Platform, SafeAreaView, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { parseMarkdown } from '../../../shared/markdownParse.mjs';
import { Markdown } from '../components/Markdown';
import { SelectableRun } from '../components/SelectableRun';
import { groupRuns, type proseRuns } from '../presentation/proseRuns';
import { nativeSelectableText } from '../platform/selectableText';
import { typo } from '../typography';

/** The samples, as Markdown a native run draws: a line, wrapping English, Chinese, mixed scripts, emoji, a heading with a paragraph, lists, and every inline style at once. */
export const SAMPLES = [
  'Short line.',
  'The quick brown fox jumps over the lazy dog. Select a word here with a long press, then drag a handle across the paragraph to pick a range.',
  '这是一段中文文字，用来比较两种排版的行高与折行是否一致。长按选中一个词，再拖动手柄选择一个范围。',
  'Mixed 中文 and English 文字 on one line, then more words so that it wraps around the end of the line once or twice.',
  'Emoji 😀 on a line that wraps 🎉 with several 👩🏽‍💻 of them 🚀 so the fallback font’s metrics matter, ending 🙂.',
  '# A heading\n\nA paragraph under it that is long enough to wrap onto a second line at the default text size.\n\n### A smaller heading\n\nAnother paragraph.',
  'Intro line:\n\n- first item\n- second item that is long enough to wrap onto a second line at the default size\n- third\n\nAfter the list.',
  '1. one\n2. two\n   - nested a\n   - nested b\n3. three\n\nDone.',
  'Plain, then **bold words**, then *italic words*, then `inline code`, then [a link](https://mopilot.ai/probe) and enough plain text after them to wrap onto a second and a third line.',
];
/** How far apart two heights may be and still lay out the same: a point. */
export const TOLERANCE = 1;
/** Whether two measured heights are the same layout. */
export const sameHeight = (a: number | undefined, b: number | undefined) =>
  a !== undefined && b !== undefined && Math.abs(a - b) <= TOLERANCE;

type Block = Parameters<typeof proseRuns>[0][number] & { position: { start: { offset: number } } };
/** The stretches of run blocks in a Markdown text. */
export const runsOf = (text: string): Block[][] =>
  groupRuns((parseMarkdown(text) as unknown as { children: Block[] }).children).flatMap((g): Block[][] => ('run' in g ? [g.run] : []));

function Row({ id, text, report }: { id: string; text: string; report: (id: string, which: 'rn' | 'native', height: number) => void }) {
  const { width } = useWindowDimensions();
  return (
    <View style={{ width: width - 32, gap: 6 }}>
      <View onLayout={(e) => report(id, 'rn', e.nativeEvent.layout.height)}>
        <Markdown text={text} serif selectable={false} />
      </View>
      <View onLayout={(e) => report(id, 'native', e.nativeEvent.layout.height)}>
        {runsOf(text).map((run) => (
          <SelectableRun key={run[0].position.start.offset} blocks={run} fallback={null} />
        ))}
      </View>
    </View>
  );
}

export function SelectableTextProbe() {
  const Native = nativeSelectableText();
  const { fontScale } = useWindowDimensions();
  const [heights, setHeights] = useState<Record<string, { rn?: number; native?: number }>>({});
  const report = (id: string, which: 'rn' | 'native', height: number) =>
    setHeights((old) => ({ ...old, [id]: { ...old[id], [which]: height } }));
  const stack = Array.from({ length: 30 }, (_, n) => `stack-${n}`);
  const total = (which: 'rn' | 'native') => Number(stack.reduce((sum, id) => sum + (heights[id]?.[which] ?? 0), 0).toFixed(2));
  const rows = SAMPLES.map((text, n) => ({ id: `sample-${n}`, text }));
  const same = rows.filter((r) => sameHeight(heights[r.id]?.rn, heights[r.id]?.native)).length;
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#fff' }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
        <Text style={typo.subheadSemibold}>
          {`iOS ${String(Platform.Version)} · system text scale ${fontScale} · ${Native ? 'native view present' : 'NO native view in this build'}`}
        </Text>
        <Text selectable>{`${same} of ${rows.length} samples match (within ${TOLERANCE} pt)`}</Text>
        <Text>{`30 stacked runs: RN ${total('rn')} · native ${total('native')} · ${sameHeight(total('rn'), total('native')) ? 'same' : 'DIFFERENT'} (${(total('native') - total('rn')).toFixed(2)} pt)`}</Text>
        {rows.map((r) => (
          <View key={r.id} style={{ gap: 4 }}>
            <Text style={{ color: sameHeight(heights[r.id]?.rn, heights[r.id]?.native) ? '#0a7d32' : '#b00020' }}>
              {`${r.id}: RN ${heights[r.id]?.rn ?? '…'} · native ${heights[r.id]?.native ?? '…'}`}
            </Text>
            <Row id={r.id} text={r.text} report={report} />
          </View>
        ))}
        {stack.map((id) => (
          <Row key={id} id={id} text={SAMPLES[1]} report={report} />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
