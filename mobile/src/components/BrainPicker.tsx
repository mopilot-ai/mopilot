// Picks MoMo's brain from the computer's own agent, account and model lists; offered only where the Mac allows phones to change it.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { MobileRuntime } from '../contracts';
import { Button, Card, ErrorLine, useStyles, Heading } from './ui';
import { Choice } from './Choice';
import type { MomoApi } from '../momo/api';
import { messageOf } from '../momo/api';
import { explain, loadOptions, loadStart, type Harness, type Options } from '../remote/client';
import { useOwnedRequest } from '../remote/useOwnedRequest';

export function BrainPicker({ runtime, api, done }: { runtime: MobileRuntime; api: MomoApi; done: () => void }) {
  const styles = useStyles();
  const request = useOwnedRequest(runtime);
  const [harnesses, setHarnesses] = useState<Harness[] | null>(null);
  const [ceiling, setCeiling] = useState('auto-review');
  const [harness, setHarness] = useState<string | null>(null);
  const [options, setOptions] = useState<Options | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    loadStart(request).then(
      (loaded) => {
        if (!active) return;
        setHarnesses(loaded.harnesses);
        setCeiling(loaded.caps.ceiling);
      },
      (e) => active && setError(explain(e)),
    );
    return () => {
      active = false;
    };
  }, [request]);
  useEffect(() => {
    if (!harness) return;
    let active = true;
    setOptions(null);
    setAccount(null);
    loadOptions(request, harness, ceiling).then(
      (loaded) => {
        if (!active) return;
        setOptions(loaded);
        setModel(loaded.model);
      },
      (e) => active && setError(explain(e)),
    );
    return () => {
      active = false;
    };
  }, [request, harness, ceiling]);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const label = options?.models.find((m) => m.id === model)?.label ?? null;
      await api.setBrain({ harness: harness!, account, model, modelLabel: label });
      done();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }
  return (
    <Card>
      <Heading>Change brain</Heading>
      <ErrorLine text={error} />
      {!harnesses && !error && <Text style={styles.muted}>Loading your computer's options…</Text>}
      {harnesses && <Choice title="Agent" options={harnesses} value={harness} pick={setHarness} />}
      {harness && !options && !error && <Text style={styles.muted}>Loading models…</Text>}
      {options && (
        <View style={{ gap: 12 }}>
          <Choice title="Account" options={options.accounts.filter((a) => !a.signedOut)} value={account} pick={setAccount} />
          <Choice title="Model" options={options.models} value={model} pick={setModel} />
        </View>
      )}
      <View style={styles.row}>
        <Button title={busy ? 'Saving…' : 'Use this brain'} disabled={!harness || !options || busy} onPress={() => void save()} />
        <Button secondary title="Cancel" disabled={busy} onPress={done} />
      </View>
    </Card>
  );
}
