// Memory: facts to search, edit or forget, and the About you and persona documents; a saved copy (encrypted on the phone) shows while the Mac is away.
import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, ErrorLine, Field, useStyles, Heading } from '../components/ui';
import type { MobileRuntime } from '../contracts';
import { messageOf, type MomoApi } from '../momo/api';
import type { MomoCache } from '../momo/cache';
import type { Docs, Fact } from '../momo/contract';
import { useLoad, type Guard } from '../momo/useLoad';

type MemoryView = { facts: Fact[]; docs: Docs | null; saved: boolean };
type DocName = 'aboutYou' | 'persona';
const DOCS: [DocName, string][] = [
  ['aboutYou', 'About you'],
  ['persona', 'Persona'],
];

export function MomoMemory({
  runtime,
  api,
  cache,
  scope,
  online,
  guard,
  version,
}: {
  runtime: MobileRuntime;
  api: MomoApi;
  cache: Promise<MomoCache | null> | undefined;
  scope: string;
  online: boolean;
  guard: Guard;
  version: number;
}) {
  const styles = useStyles();
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const memory = useLoad<MemoryView>(runtime, async () => {
    const store = await cache;
    if (!online) {
      const saved = await store?.load(scope);
      if (!saved) throw new Error('Nothing saved yet. Connect to your Mac to see your memory.');
      const q = searched.toLowerCase();
      return { facts: q ? saved.facts.filter((f) => f.text.toLowerCase().includes(q)) : saved.facts, docs: saved.docs, saved: true };
    }
    const [facts, docs] = await guard(() => Promise.all([api.facts(searched), api.docs()]));
    // only the whole list is kept: a search result would hide the rest when it is read offline
    if (!searched) await store?.save(scope, { facts, docs }).catch(() => undefined);
    return { facts, docs, saved: false };
  }, [online, searched, scope, version]);
  async function act(work: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await guard(work);
      memory.reload();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const data = memory.data;
  const locked = busy || !online;
  return (
    <View style={{ gap: 12 }}>
      <ErrorLine text={error ?? memory.error} />
      {data?.saved && <Text style={styles.muted}>Saved copy from your Mac. Changes need a connection.</Text>}
      <Field placeholder="Search memory" value={query} onChangeText={setQuery} />
      <Button
        secondary
        title="Search"
        onPress={() => {
          setSearched(query.trim());
          setEditing(null);
          setForgetting(null);
        }}
      />
      {!data && !memory.error && <Text style={styles.muted}>Loading memory…</Text>}
      {data && !data.facts.length && (
        <Text style={styles.muted}>{searched ? 'Nothing found.' : 'MoMo has not remembered anything yet.'}</Text>
      )}
      {data?.facts.map((fact) => (
        <Card key={fact.id}>
          {editing?.id === fact.id ? (
            <>
              <Field multiline placeholder="Edit fact" value={editing.text} onChangeText={(text) => setEditing({ id: fact.id, text })} />
              <View style={styles.row}>
                <Button
                  title="Save"
                  disabled={locked || !editing.text.trim()}
                  onPress={() => void act(() => api.editFact(fact.id, editing.text.trim()).then(() => setEditing(null)))}
                />
                <Button secondary title="Cancel" onPress={() => setEditing(null)} />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.text}>{fact.text}</Text>
              {fact.expired && <Text style={styles.muted}>Expired</Text>}
              <View style={styles.row}>
                <Button secondary title="Edit" disabled={locked} onPress={() => setEditing({ id: fact.id, text: fact.text })} />
                {forgetting === fact.id ? (
                  <Button
                    title="Confirm forget"
                    disabled={locked}
                    onPress={() => void act(() => api.forgetFact(fact.id).then(() => setForgetting(null)))}
                  />
                ) : (
                  <Button secondary title="Forget" disabled={locked} onPress={() => setForgetting(fact.id)} />
                )}
              </View>
            </>
          )}
        </Card>
      ))}
      {data?.docs &&
        DOCS.map(([name, title]) => (
          <Card key={name}>
            <Heading>{title}</Heading>
            {data.docs!.unreadable.includes(name) && <Text style={styles.muted}>Can't be read on your Mac.</Text>}
            <Text selectable style={styles.text}>
              {data.docs![name] || 'Nothing written yet.'}
            </Text>
            <Text style={styles.muted}>Change this on your Mac.</Text>
          </Card>
        ))}
    </View>
  );
}
