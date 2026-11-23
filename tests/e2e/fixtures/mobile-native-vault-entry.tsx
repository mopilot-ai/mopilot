// CI-only simulator entry checks production vault persistence and pair-scoped routing across two launches.
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { registerRootComponent } from 'expo';
import * as SQLite from 'expo-sqlite';
import { openVaultStorage } from './src/platform/vault';
import { phonePrimitives } from './src/platform/crypto';
import { createRelayRouting } from './src/relayRouting';
import { phoneSnapshot } from './src/snapshot';
import { createPhoneVault } from '../shared/remote/phoneVault.mjs';
import App from './App';

function checkRouting() {
  const projected = phoneSnapshot(
    {
      phase: 'error',
      generation: 1,
      user: null,
      pairs: [],
      selectedPair: null,
      safetyNumber: '123456',
      pendingPair: true,
      error: 'Disconnected',
      presence: {},
      reconnect: null,
      outbox: [],
    },
    'idle',
  );
  if (!projected.pairCleanup || projected.safetyNumber !== null) throw new Error('interrupted pairing still asks for confirmation');
  const committing = phoneSnapshot({ ...projected, phase: 'pairing', user: { id: 'native-check' }, safetyNumber: '123456' }, 'committing');
  if (!committing.pairingCommit || committing.pairCleanup || committing.safetyNumber !== '123456')
    throw new Error('active commit was offered cleanup');
  const finishing = phoneSnapshot({ ...committing, phase: 'pairing' }, 'idle', true);
  if (!finishing.pairingCommit || finishing.pairCleanup) throw new Error('final pairing read was offered cleanup');
  for (const ev of ['pair.removed', 'mailbox.dropped']) {
    let interrupted = 0;
    const selected = {
      closed: false,
      close() {
        this.closed = true;
      },
      receive: async () => {},
    };
    const other = {
      closed: false,
      close() {
        this.closed = true;
      },
      receive: async () => {},
    };
    const route = createRelayRouting({
      channels: new Map([
        ['first', selected],
        ['second', other],
      ]),
      selectedPair: () => 'first',
      generation: () => 0,
      refreshPairs: async () => {},
      reconciliationError: () => {
        throw new Error('unexpected routing refresh failure');
      },
      interrupt: () => {
        interrupted++;
      },
    });
    route.event({ ev, pair: 'second' });
    if (selected.closed || !other.closed || interrupted) throw new Error('unrelated pair interrupted the selected computer');
    route.joining('joining');
    route.event({ ev, pair: 'unrelated' });
    if (interrupted) throw new Error('unrelated pair interrupted pairing');
    route.event({ ev, pair: 'joining' });
    if (interrupted !== 1) throw new Error('joining pair was not retired');
    route.reset();
    route.event({ ev, pair: 'joining' });
    if (interrupted !== 1) throw new Error('retired joining pair was reused');
    route.event({ ev, pair: 'first' });
    if (!selected.closed || interrupted !== 2) throw new Error('selected pair was not retired');
  }
}

function NativeVaultCheck() {
  const [status, setStatus] = useState('MOBILE VAULT RUNNING');
  useEffect(() => {
    void (async () => {
      try {
        const storage = await openVaultStorage();
        const vault = createPhoneVault({ ...storage, prim: phonePrimitives() });
        const id = await vault.getInstallId();
        const raw = await storage.transaction((row) => row.read());
        if (!raw || raw.includes(id)) throw new Error('vault row is not sealed');
        const db = await SQLite.openDatabaseAsync('native-check.db');
        await db.execAsync('CREATE TABLE IF NOT EXISTS checkpoint (id TEXT NOT NULL)');
        const prior = await db.getFirstAsync<{ id: string }>('SELECT id FROM checkpoint LIMIT 1');
        if (prior && prior.id !== id) throw new Error('vault identity changed after restart');
        if (!prior) await db.runAsync('INSERT INTO checkpoint (id) VALUES (?)', id);
        checkRouting();
        setStatus(`${prior ? 'MOBILE VAULT SECOND PASS' : 'MOBILE VAULT FIRST PASS'}\nMOBILE ROUTING PASS`);
      } catch (error) {
        console.error('MOBILE VAULT FAIL', error instanceof Error ? error.message.slice(0, 300) : 'Native storage check failed');
        setStatus('MOBILE VAULT FAIL');
      }
    })();
  }, []);
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ fontSize: 18, textAlign: 'center', marginTop: 48 }}>{status}</Text>
      <App />
    </View>
  );
}
registerRootComponent(NativeVaultCheck);
