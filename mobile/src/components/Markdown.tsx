// A reply's Markdown (CommonMark) as native text: paragraphs, headings, lists, quotes, code blocks, inline code, emphasis and links.
import { Fragment, memo, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking, Platform, ScrollView, Text, View, type TextStyle } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import Animated, { Easing, FadeIn, useReducedMotion } from 'react-native-reanimated';
import { parseMarkdown } from '../../../shared/markdownParse.mjs';
import { blockText } from '../presentation/replyText';
import { useTheme, type Theme } from '../theme';
import { monoFamily, serifFamily } from '../fonts';
import { dur, ease } from '../motion';
import { fadeEnd, splitFades, withAlpha, type Step } from '../presentation/wordFade';
import { typo, typoHeading, typoWeight } from '../typography';
import { ChatLinkContext, chatIdOfLink } from '../chatLinks';
import { useTranslation } from '../ui/i18n';
import { openable, showLinkMenu } from './linkMenu';
import { groupRuns } from '../presentation/proseRuns';
import { nativeSelectableText } from '../platform/selectableText';
import { nativeGate } from '../presentation/nativeGate';
import { SelectableRun } from './SelectableRun';
import { SelectableCell } from './SelectableCell';

type Node = {
  type: string;
  /** where the node starts in the text: a stable key for a node among its siblings */
  position: { start: { offset: number }; end: { offset: number } };
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  children?: Node[];
  /** a table's column alignment */
  align?: (('left' | 'right' | 'center') | null)[];
};

/** The sans body of a card or sheet. */
const SANS: TextStyle = { ...typo.subhead };
/** The assistant's prose in Claude's transcript: New York at 17 pt, 26 pt leading. */
const SERIF: TextStyle = { ...typo.reply, fontFamily: serifFamily() };
/** The words still fading in, as a block sees them: the steps that revealed the text and the frame's time. */
type Fx = { steps: readonly Step[]; now: number; source: string } | null;

/** A block that is not prose (a code block, a rule) arrives while the reply streams fading in on the enter curve. */
const arrive = FadeIn.duration(dur.base).easing(Easing.bezier(...ease.enter));

/** A link: a MoPilot chat opens in the app; any other link goes to iOS. A long press offers Open and Copy link. */
export function LinkText({ url, color, children }: { url: string; color: string; children: ReactNode }) {
  const openChat = useContext(ChatLinkContext);
  const { t } = useTranslation();
  const chatId = chatIdOfLink(url);
  const open = () => {
    if (chatId) openChat?.(chatId);
    else if (openable(url)) void Linking.openURL(url).catch(() => undefined);
  };
  const words = { open: t('message.openLink'), copy: t('message.copyLink'), cancel: t('message.cancel') };
  const menu = () => showLinkMenu(url, words, chatId || openable(url) ? open : null);
  return (
    <Text
      accessibilityRole="link"
      onPress={open}
      onLongPress={Platform.OS === 'ios' ? menu : undefined}
      style={{ color, textDecorationLine: 'underline' }}
    >
      {children}
    </Text>
  );
}

/** Inline content (text, emphasis, code, links) as nested Text, which wraps as one paragraph. */
function inline(nodes: Node[] | undefined, theme: Theme, fx: Fx, key = '', tone = theme.ink): ReactNode[] {
  return (nodes ?? []).map((node, i) => {
    const k = `${key}${i}`;
    if (node.type === 'text' && fx) {
      const { start, end } = { start: node.position.start.offset, end: node.position.end.offset };
      const parts = splitFades(node.value!, start, end, fx.steps, fx.now, fx.source.slice(start, end));
      let offset = 0;
      if (parts.some((part) => part.alpha < 1))
        return (
          <Fragment key={k}>
            {parts.map((part) => {
              const key = offset;
              offset += part.text.length;
              return part.alpha === 1 ? (
                part.text
              ) : (
                <Text key={key} style={{ color: withAlpha(tone, part.alpha) }}>
                  {part.text}
                </Text>
              );
            })}
          </Fragment>
        );
    }
    if (node.type === 'text' || node.type === 'html') return <Fragment key={k}>{node.value}</Fragment>;
    if (node.type === 'break') return <Fragment key={k}>{'\n'}</Fragment>;
    if (node.type === 'inlineCode')
      return (
        <Text key={k} style={{ fontFamily: monoFamily(), ...typo.footnote, backgroundColor: theme.sunken }}>
          {node.value}
        </Text>
      );
    if (node.type === 'strong')
      return (
        <Text key={k} style={{ fontWeight: typoWeight.semibold }}>
          {inline(node.children, theme, fx, `${k}.`, tone)}
        </Text>
      );
    if (node.type === 'delete')
      return (
        <Text key={k} style={{ textDecorationLine: 'line-through' }}>
          {inline(node.children, theme, fx, `${k}.`, tone)}
        </Text>
      );
    if (node.type === 'emphasis')
      return (
        <Text key={k} style={{ fontStyle: 'italic' }}>
          {inline(node.children, theme, fx, `${k}.`, tone)}
        </Text>
      );
    if (node.type === 'link')
      return (
        <LinkText key={k} url={node.url!} color={theme.info}>
          {inline(node.children, theme, fx, `${k}.`, theme.info)}
        </LinkText>
      );
    // an image reads as its description; anything else inline (a reference link) as its text
    if (node.type === 'image' || node.type === 'imageReference') return <Fragment key={k}>{node.alt}</Fragment>;
    return <Fragment key={k}>{inline(node.children, theme, fx, `${k}.`, tone)}</Fragment>;
  });
}

/** The text a node holds, for sizing a table's columns. */
const plain = (node: Node): string => node.value ?? (node.children ?? []).map(plain).join('');

/** A table: a header row and body rows, each cell aligned as its delimiter says, in a sideways scroll so a wide table keeps its columns. VoiceOver reads cell by cell, the header cells as headers. */
function TableBlock({ node, theme, body, opts }: { node: Node; theme: Theme; body: TextStyle; opts: BlockOptions }) {
  const rows = node.children!;
  const widths = rows[0]!.children!.map((_, col) => {
    const longest = Math.max(...rows.map((row) => plain(row.children![col] ?? { type: 'tableCell' }).length));
    return Math.min(240, Math.max(72, longest * 14 + 20));
  });
  const grid = (
    <View accessibilityRole="grid" style={{ borderWidth: 1, borderColor: theme.line, borderRadius: 8, overflow: 'hidden' }}>
      {rows.map((row, r) => (
        <View key={row.position.start.offset} style={{ flexDirection: 'row', backgroundColor: r === 0 ? theme.sunken : undefined }}>
          {row.children!.map((cell, c) => {
            const box = { width: widths[c], padding: 8, borderRightWidth: 1, borderTopWidth: r === 0 ? 0 : 1, borderColor: theme.line };
            const words = (
              <Text
                key={cell.position.start.offset}
                selectable={opts.selectable}
                accessibilityRole={r === 0 ? 'header' : undefined}
                style={[
                  body,
                  {
                    color: theme.ink,
                    ...typo.footnote,
                    textAlign: node.align?.[c] ?? 'left',
                    fontWeight: r === 0 ? typoWeight.semibold : typoWeight.regular,
                    // beside native cells the box is the wrapper's; a cell drawn by React is its own box
                    ...(opts.cells ? null : box),
                  },
                ]}
              >
                {/* the header's words are bold as a `**` run is, which the phone draws on every device; the cell's own weight alone read as regular */}
                {r === 0 ? (
                  <Text style={{ fontWeight: typoWeight.semibold }}>{inline(cell.children, theme, null)}</Text>
                ) : (
                  inline(cell.children, theme, null)
                )}
              </Text>
            );
            return opts.cells ? (
              <View key={cell.position.start.offset} style={box}>
                <SelectableCell
                  cell={cell}
                  header={r === 0}
                  align={node.align?.[c]}
                  selectTable={() => opts.onBlock?.('table', blockText(node))}
                  fallback={words}
                />
              </View>
            ) : (
              words
            );
          })}
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      onTouchStartCapture={opts.cells ? () => nativeGate.touch(false) : undefined}
    >
      {/* The press wrapper stays over native cells: a shown native cell's own menu replaces the table-wide long press (a second menu would open over a
          selection), a cell that is not native yet gets the table's menu so a press is never left with nothing, and without the wrapper the sideways
          scroller never takes a drag that starts over a native cell, and a wide table cannot be scrolled. */}
      <Tap
        feel="none"
        accessible={false}
        onLongPress={() =>
          opts.cells && nativeGate.touchedNative()
            ? nativeGate.awaitMenu(() => opts.onBlock?.('table', blockText(node)))
            : opts.onBlock?.('table', blockText(node))
        }
        delayLongPress={350}
      >
        {grid}
      </Tap>
    </ScrollView>
  );
}

/**
 * What a block is drawn with besides its content: `selectable` (prose that the system selects whole; a reply turns it off, since its own
 * long-press menu selects any range) and `a11y`, the custom VoiceOver actions the first block of a reply carries.
 */
export type BlockOptions = {
  selectable: boolean;
  /** a table's cells are native text views iOS selects words in (the in-place selection is on) */
  cells?: boolean;
  /** a long press on a code block or a table: the reply's menu for that block (Copy code, Copy table) */
  onBlock?: (kind: 'code' | 'table' | 'block', text: string) => void;
  a11y?: {
    accessibilityActions: { name: string; label: string }[];
    onAccessibilityAction: (e: { nativeEvent: { actionName: string } }) => void;
  };
};
const PLAIN: BlockOptions = { selectable: true };

function block(node: Node, theme: Theme, key: string, body: TextStyle, fx: Fx, opts: BlockOptions = PLAIN): ReactNode {
  if (node.type === 'paragraph')
    return (
      <Text key={key} selectable={opts.selectable} {...opts.a11y} style={[body, { color: theme.ink }]}>
        {inline(node.children, theme, fx)}
      </Text>
    );
  if (node.type === 'heading')
    return (
      <Text
        key={key}
        selectable={opts.selectable}
        {...opts.a11y}
        accessibilityRole="header"
        style={{
          fontFamily: body.fontFamily,
          ...typoHeading[node.depth!],
          color: theme.ink,
        }}
      >
        {inline(node.children, theme, fx)}
      </Text>
    );
  if (node.type === 'code')
    return (
      <ScrollView key={key} horizontal style={{ backgroundColor: theme.sunken, borderRadius: 10 }} contentContainerStyle={{ padding: 10 }}>
        <Tap
          feel="none"
          accessible={false}
          onLongPress={() => nativeGate.touchedNative() || opts.onBlock?.('code', node.value!)}
          delayLongPress={350}
        >
          <Text selectable={opts.selectable} style={{ fontFamily: monoFamily(), ...typo.footnote, color: theme.ink }}>
            {node.value}
          </Text>
        </Tap>
      </ScrollView>
    );
  if (node.type === 'list')
    return (
      <View key={key} style={{ gap: 4 }}>
        {node.children!.map((item, i) => (
          <View key={item.position.start.offset} style={{ flexDirection: 'row', gap: 6 }}>
            <Text style={[body, { color: theme.ink2, minWidth: 14 }]}>{node.ordered ? `${node.start! + i}.` : '•'}</Text>
            <View style={{ flex: 1, gap: 4 }}>
              {item.children!.map((child) => nestedBlock(child, theme, String(child.position.start.offset), body, fx, opts))}
            </View>
          </View>
        ))}
      </View>
    );
  if (node.type === 'blockquote')
    return (
      <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: theme.line, paddingLeft: 10, gap: 6 }}>
        {node.children!.map((child, i) => nestedBlock(child, theme, `${key}.${i}`, body, fx, opts))}
      </View>
    );
  if (node.type === 'table') return <TableBlock key={key} node={node} theme={theme} body={body} opts={opts} />;
  if (node.type === 'thematicBreak')
    return <View key={key} style={{ borderBottomWidth: 1, borderBottomColor: theme.line, marginVertical: 4 }} />;
  // html and anything this renderer does not draw shows as its own text
  return (
    <Text key={key} selectable={opts.selectable} style={[body, { color: theme.ink }]}>
      {node.value ?? inline(node.children, theme, fx)}
    </Text>
  );
}

/** Prose fades word by word; the rest of a block that arrives while the reply streams fades in whole. */
const PROSE = new Set(['paragraph', 'heading', 'list', 'blockquote']);

/** Nested code and rules have the same arrival policy as their top-level siblings. */
function nestedBlock(node: Node, theme: Theme, key: string, body: TextStyle, fx: Fx, opts: BlockOptions): ReactNode {
  const whole = fx && !PROSE.has(node.type) && node.position.start.offset >= fx.steps[0].at;
  return (
    <Animated.View key={key} entering={whole ? arrive : undefined}>
      {block(node, theme, '0', body, fx, { selectable: opts.selectable, onBlock: opts.onBlock })}
    </Animated.View>
  );
}

/** One top-level block. A block wholly before the live steps gets no `fx`, so it is not drawn again while later words fade. */
const Block = memo(
  function Block({
    node,
    signature,
    theme,
    body,
    fx,
    whole,
    opts,
  }: {
    node: Node;
    signature: string;
    theme: Theme;
    body: TextStyle;
    fx: Fx;
    whole: boolean;
    opts: BlockOptions;
  }) {
    void signature;
    return <Animated.View entering={whole ? arrive : undefined}>{block(node, theme, '0', body, fx, opts)}</Animated.View>;
  },
  (a, b) =>
    a.signature === b.signature && a.theme === b.theme && a.body === b.body && a.fx === b.fx && a.whole === b.whole && a.opts === b.opts,
);

/** The frame time while words are fading (a frame at a time), then still: nothing redraws once the last word is opaque. */
function useFadeClock(steps: readonly Step[], on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  const last = steps.length ? steps[steps.length - 1].time : 0;
  useEffect(() => {
    if (!on || !last) return;
    let raf = 0;
    // the frame count bounds the loop should the clock stand still
    let frames = Math.ceil((fadeEnd(steps) - last) / 8);
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t < fadeEnd(steps) && --frames > 0) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, last, steps]);
  return now;
}

/**
 * Parsed once per text. `serif` sets the transcript's prose. `fade` makes a reply that is streaming fade in as Claude's
 * does: each word of `steps` fades over 400 ms from the moment its step showed (none under Reduce Motion), text already
 * shown never fades again, and code blocks and rules that arrive fade in whole.
 */
export const Markdown = memo(function Markdown({
  text,
  serif = false,
  fade = false,
  steps = [],
  selectable = true,
  a11y,
  onBlock,
  inPlace,
}: {
  text: string;
  serif?: boolean;
  fade?: boolean;
  steps?: readonly Step[];
  /** prose is selectable whole by the system; a reply with its own select menu turns it off */
  selectable?: boolean;
  /** VoiceOver actions the reply's first block carries (its menu's Copy and Select Text) */
  a11y?: BlockOptions['a11y'];
  /** a long press on a code block or a table */
  onBlock?: BlockOptions['onBlock'];
  /** in-place selection: runs of prose are native text views iOS selects a range of; `copyMessage` is their own menu entry */
  inPlace?: { copyMessage: () => void; selectText: () => void };
}) {
  const theme = useTheme();
  const reduce = useReducedMotion();
  // Later reference definitions can change earlier nodes without changing their source slice.
  // Compute parsed identities once per text update, never on a fade frame.
  const blocks = useMemo(
    () => (parseMarkdown(text) as unknown as Node).children!.map((node) => ({ node, signature: JSON.stringify(node) })),
    [text],
  );
  const body = serif ? SERIF : SANS;
  const animate = fade && !reduce;
  const now = useFadeClock(steps, animate);
  const live = animate && steps.length > 0 && now < fadeEnd(steps);
  const fx: Fx = live ? { steps, now, source: text } : null;
  // in-place selection: stretches of prose become native text views, the other blocks stay as drawn here
  // and only once the words have finished fading in (a streamed reply fades as React blocks, then swaps to the same text as a native run)
  const native = !!inPlace && nativeSelectableText() !== null && !live;
  const groups = useMemo((): ({ run: Node[]; index?: undefined } | { index: number; run?: undefined })[] => {
    const nodes = blocks.map((b) => b.node);
    if (!native) return nodes.map((_, index) => ({ index }));
    return groupRuns(nodes).map((g) => ('run' in g ? { run: g.run } : { index: nodes.indexOf(g.block) }));
  }, [blocks, native]);
  const first = useMemo(() => ({ selectable, a11y, onBlock, cells: native }), [selectable, a11y, onBlock, native]);
  const rest = useMemo(() => ({ selectable, onBlock, cells: native }), [selectable, onBlock, native]);
  return (
    <View style={{ gap: serif ? 12 : 8 }}>
      {/* the same views with or without the fade, so a reply that stops streaming keeps its blocks (and a selection in them) */}
      {groups.map((group) => {
        const draw = (i: number) => {
          const { node, signature } = blocks[i];
          const end = node.position.end.offset;
          const start = node.position.start.offset;
          const prose = PROSE.has(node.type);
          // a block the live steps have not reached keeps its drawing
          const blockFx = fx && end > steps[0].at ? fx : null;
          return (
            <Block
              key={start}
              node={node}
              signature={signature}
              theme={theme}
              body={body}
              fx={blockFx}
              whole={animate && !prose && steps.length > 0 && start >= steps[0].at}
              opts={i === 0 ? first : rest}
            />
          );
        };
        if (group.run) {
          // the run's blocks as React draws them, held until the native view has measured its text
          const fallback = (
            <View style={{ gap: serif ? 12 : 8 }}>{group.run.map((node) => draw(blocks.findIndex((b) => b.node === node)))}</View>
          );
          return (
            <SelectableRun
              key={group.run[0].position.start.offset}
              blocks={group.run}
              copyMessage={inPlace!.copyMessage}
              selectText={inPlace!.selectText}
              fallback={fallback}
            />
          );
        }
        const node = blocks[group.index].node;
        const start = node.position.start.offset;
        const drawn = draw(group.index);
        // beside native runs a quote or a rule has no run to select in: a long press on it opens the reply's menu
        return native && node.type !== 'code' && node.type !== 'table' ? (
          <Tap
            feel="none"
            key={start}
            accessible={false}
            onLongPress={() => nativeGate.touchedNative() || onBlock?.('block', blockText(node))}
            delayLongPress={350}
          >
            {drawn}
          </Tap>
        ) : (
          drawn
        );
      })}
    </View>
  );
});
