// Render the choices and input fields the desktop actually offers for a pending request.
import { useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Button, Card, Field, useStyles, Heading } from './ui';
import type { Data } from '../presentation/thread';
import { receiptLine, type Receipt } from '../presentation/receipts';
import { Markdown } from './Markdown';
import { TargetLine } from './TargetLine';
import { WaitingCard } from './WaitingCard';
type Choice = { key: string; label: string; deny?: boolean; hold?: boolean };
type Question = { id: string; question?: string; header?: string; options?: { label: string }[]; isOther?: boolean; multiSelect?: boolean };
type FieldSchema = { title?: string; description?: string; type?: string; enum?: unknown[]; enumLabels?: string[] };
export type CardData = {
  id: string | number;
  title: string;
  rev: number;
  detail?: string | null;
  /** An approval's destination as the Mac words it (a sanitised site label, never a url); a card without one has no line. */
  to?: string;
  inApp?: boolean;
  questions?: Question[];
  schema?: { properties?: Record<string, FieldSchema> };
  url?: string;
  choices?: Choice[];
  /** `plan`: a plan waiting for approval; `plan` is what to read before approving it. */
  kind?: string;
  plan?: { text: string; clipped?: boolean; file?: string };
  /** `mac-only`: only the Mac finishes it (a payment, a sign-in, a check); the phone shows `waitingCopy` and offers nothing. */
  where?: 'phone' | 'mac-only';
  waitingCopy?: string;
  /** The card came through the machine's own path (not the Mac): it is answered there, whether or not the Mac is up. */
  viaMachine?: true;
};
export const cardKey = (card: CardData) => JSON.stringify([card.id, card.rev]);
/** The plan card's refusal asks for changes: the plan is not approved, and the user says what to change in the chat. */
export const asksForChanges = (card: CardData, key: string) => card.kind === 'plan' && !!card.choices?.some((c) => c.key === key && c.deny);
export function RequestCard({
  card,
  answer,
  answered = false,
  receipt = null,
  bare = false,
}: {
  card: CardData;
  answer: (key: string, values?: Data) => Promise<boolean>;
  /** Someone else (the Mac, another phone) answered this card first. */
  answered?: boolean;
  /** The card was answered and says where; it keeps its title and loses its buttons. */
  receipt?: Receipt | null;
  /** Drawn without its own box, inside a sheet. */
  bare?: boolean;
}) {
  const styles = useStyles();
  const [values, setValues] = useState<Data>({});
  const answers = (id: string): string[] => (Array.isArray(values[id]) ? (values[id] as string[]) : []);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  async function submit(key: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    let answered = false;
    try {
      answered = await answer(key, values);
    } finally {
      inFlight.current = false;
      // an accepted answer leaves the card disabled until the Mac takes it down, so a second tap cannot read as "answered elsewhere"
      if (!answered) setPending(false);
    }
  }
  // only the Mac finishes this one (a payment, a sign-in): its words, and nothing to press, wherever the card is drawn
  if (card.where === 'mac-only') return <WaitingCard card={card} />;
  const done = receipt ?? (answered ? ({ by: 'mac' } as const) : null);
  const Box = bare ? View : Card;
  const choices = Array.isArray(card.choices) ? card.choices : [];
  // one main action: the first choice that is not a refusal; the others are quieter, and the refusal is red text
  const main = choices.find((c) => !c.deny);
  const others = choices.filter((c) => c !== main);
  return (
    <Box style={bare ? { gap: 10 } : undefined}>
      <Heading>{card.title}</Heading>
      {done ? (
        <Text accessibilityRole="alert" style={styles.muted}>
          {receiptLine(done)}
        </Text>
      ) : null}
      {!done && <TargetLine card={card} />}
      {!done && !!card.detail && <Text style={styles.text}>{card.detail}</Text>}
      {!done && card.kind === 'plan' && !!card.plan && (
        <View style={{ gap: 8 }}>
          <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
            {/* a plan is Markdown the agent wrote: read as headings and lists, never as raw marks */}
            {card.plan.text ? (
              <Markdown text={card.plan.text} />
            ) : (
              <Text style={styles.text}>This plan has no text. Read it on your Mac.</Text>
            )}
          </ScrollView>
          {card.plan.clipped && <Text style={styles.muted}>Only the start of the plan is shown. Read the rest on your Mac.</Text>}
          {!!card.plan.file && <Text style={styles.muted}>Saved as {card.plan.file}</Text>}
        </View>
      )}
      {!done && card.inApp ? <Text style={styles.muted}>Finish this request on your computer.</Text> : null}
      {!done &&
        Array.isArray(card.questions) &&
        card.questions.map((q: Question) => (
          <View key={q.id} style={{ gap: 8 }}>
            <Text style={styles.text}>{q.question ?? q.header}</Text>
            {Array.isArray(q.options) &&
              q.options.map((o) => (
                <Button
                  key={o.label}
                  secondary
                  title={`${answers(q.id).includes(o.label) ? '✓ ' : ''}${o.label}`}
                  selected={answers(q.id).includes(o.label)}
                  onPress={() =>
                    setValues({
                      ...values,
                      [q.id]: q.multiSelect
                        ? answers(q.id).includes(o.label)
                          ? answers(q.id).filter((v: string) => v !== o.label)
                          : [...answers(q.id), o.label]
                        : [o.label],
                    })
                  }
                />
              ))}
            {q.isOther && (
              <Field placeholder="Your answer" value={answers(q.id)[0] ?? ''} onChangeText={(v) => setValues({ ...values, [q.id]: [v] })} />
            )}
          </View>
        ))}
      {!done &&
        card.schema?.properties &&
        Object.entries(card.schema.properties).map(([key, field]) => (
          <View key={key} style={{ gap: 8 }}>
            <Text style={styles.text}>{field.title ?? key}</Text>
            {Array.isArray(field.enum) ? (
              field.enum.map((option: unknown, i: number) => (
                <Button
                  key={JSON.stringify(option)}
                  secondary
                  title={`${values[key] === option ? '✓ ' : ''}${field.enumLabels?.[i] ?? String(option)}`}
                  selected={values[key] === option}
                  onPress={() => setValues({ ...values, [key]: option })}
                />
              ))
            ) : field.type === 'boolean' ? (
              <View style={styles.row}>
                {[true, false].map((value) => (
                  <Button
                    key={String(value)}
                    secondary
                    title={`${values[key] === value ? '✓ ' : ''}${value ? 'Yes' : 'No'}`}
                    selected={values[key] === value}
                    onPress={() => setValues({ ...values, [key]: value })}
                  />
                ))}
              </View>
            ) : (
              <Field
                placeholder={field.description ?? key}
                value={typeof values[key] === 'string' ? String(values[key]) : values[key] === undefined ? '' : JSON.stringify(values[key])}
                onChangeText={(v) => {
                  if (field.type === 'string' || !field.type) setValues({ ...values, [key]: v });
                  else {
                    try {
                      setValues({ ...values, [key]: JSON.parse(v) });
                    } catch {
                      setValues({ ...values, [key]: v });
                    }
                  }
                }}
              />
            )}
          </View>
        ))}
      {!done && card.url && <Text style={styles.muted}>Open this request on your computer: {card.url}</Text>}
      {!done && !!main && (
        <Button
          disabled={pending}
          hold={main.hold}
          title={main.label}
          onPress={() => {
            void submit(main.key);
          }}
        />
      )}
      {!done && others.length > 0 && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {others.map((choice: Choice) => (
            <View key={choice.key} style={{ flex: 1 }}>
              <Button
                secondary
                // asking for changes to a plan is not a refusal to warn about: it stays neutral
                quietDanger={choice.deny === true && card.kind !== 'plan'}
                disabled={pending}
                hold={choice.hold}
                title={card.kind === 'plan' && choice.deny ? 'Ask for changes' : choice.label}
                onPress={() => {
                  void submit(choice.key);
                }}
              />
            </View>
          ))}
        </View>
      )}
    </Box>
  );
}
