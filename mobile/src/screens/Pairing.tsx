// Add a computer: the camera opens at once with corner brackets for the computer's code, one tap of the system Paste button pairs a copied code, a pasted field is the way when neither works, and the steps (AddComputerSteps, with the Host tab) are a link away; a scan pairs at once.
import { useEffect, useRef, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Linking, Share, Text, View } from 'react-native';
import { Tap } from '../ui/ds/Tap';
import type { MobileRuntime } from '../contracts';
import { SheetFrame } from '../components/SheetFrame';
import { AddComputerSteps } from '../components/AddComputerSteps';
import { PasteCodeButton } from '../components/PasteCodeButton';
import { otherAccount, type CodeHint } from '../accountHint';
import { APP_STORE_URL, isPairingCode } from '../pairingCode';
import { Swap } from '../components/Swap';
import { Button, Card, ErrorLine, Field, useStyles } from '../components/ui';
import { monoFamily } from '../fonts';
import { useTheme } from '../theme';
import { useHardwareBack } from '../useHardwareBack';
import {
  PAIR_TIMEOUT_MS,
  explained,
  failureOutcome,
  needsUpdate,
  pairFailure,
  pairMark,
  pairingReport,
  pairingSteps,
  timeoutSentence,
  type PairOutcome,
} from '../pairingLog';
import { onForeground } from '../platform/lifecycle';
import { connectedPairFor } from '../alreadyConnected';
import { typo } from '../typography';

/** The four corner brackets over the viewfinder, as the baseline draws them. */
function Brackets() {
  // white on the camera in both themes, as the baseline draws them
  const arm = { position: 'absolute', width: 28, aspectRatio: 1, borderColor: '#ffffff' } as const;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{ position: 'absolute', top: 60, bottom: 60, left: 80, right: 80 }}
    >
      <View style={{ ...arm, left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3, borderTopLeftRadius: 10 }} />
      <View style={{ ...arm, right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3, borderTopRightRadius: 10 }} />
      <View style={{ ...arm, left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3, borderBottomLeftRadius: 10 }} />
      <View style={{ ...arm, right: 0, bottom: 0, borderRightWidth: 3, borderBottomWidth: 3, borderBottomRightRadius: 10 }} />
    </View>
  );
}

/** A blue text button, as the sheets' links ("Enter code instead"). */
function Link({ title, onPress }: { title: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Tap
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      hitSlop={8}
      style={{ alignSelf: 'center', minHeight: 44, justifyContent: 'center' }}
    >
      <Text style={{ ...typo.body, color: theme.accent }}>{title}</Text>
    </Tap>
  );
}

export function Pairing({
  runtime,
  back,
  timeoutMs = PAIR_TIMEOUT_MS,
  share = (message) => Share.share({ message }),
  now = Date.now,
  defaultName = 'Phone',
  account,
  userId,
  signOut,
  host = false,
  start = 'scan',
}: {
  runtime: MobileRuntime;
  back: () => void;
  timeoutMs?: number;
  share?: (message: string) => Promise<unknown>;
  now?: () => number;
  /** The name the form starts with: this phone's own (mobile/src/phoneName.ts). */
  defaultName?: string;
  /** Who this phone is signed in as, for the line that says the Mac uses another account. */
  account?: string | null;
  /** The id of that account: a computer whose code names another one is told at the scan. */
  userId?: string | null;
  /** Signs this phone out, so the other account can sign in (the fix for a computer on another account). */
  signOut?: () => void;
  /** The account has Host: the steps offer a Host tab. */
  host?: boolean;
  /** Where the sheet opens: the camera (the default), or the steps. */
  start?: 'steps' | 'scan';
}) {
  const styles = useStyles();
  const theme = useTheme();
  useHardwareBack(back);
  const [qr, setQr] = useState('');
  const [name, setName] = useState(defaultName);
  const [scanning, setScanning] = useState(false);
  const [typing, setTyping] = useState(false);
  // the camera is asked for as the sheet opens: a person who opened the paste field meanwhile is not given the camera under it
  const typingNow = useRef(false);
  const openEntry = (open: boolean) => {
    typingNow.current = open;
    setTyping(open);
  };
  // the phone's name is the device's own unless the person opens Advanced and writes another
  const [advanced, setAdvanced] = useState(false);
  // the code was fine but this phone's MoPilot is too old for the computer: the fix is the App Store
  const [outdated, setOutdated] = useState(false);
  // the computer's code names another account than this phone's: nothing is paired, and the fix is on the screen
  const [other, setOther] = useState<CodeHint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState(start);
  // the code is for the Mac this phone is connected to now: its name, said instead of pairing again
  const [already, setAlready] = useState<string | null>(null);
  // why the camera is not running: the system can still ask, only Settings can turn it on, or it would not start
  const [blocked, setBlocked] = useState<'ask' | 'settings' | null>(null);
  // a code was scanned and did not pair: the next one is the person's move, as the old one would be read again
  const [scanned, setScanned] = useState(false);
  const [, requestPermission] = useCameraPermissions();
  // where the attempt stands, for the log under the form; null before the first Connect
  const [log, setLog] = useState<{ outcome: PairOutcome; startedAt: number; endedAt: number | null } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // which attempt is current: Stop and a newer attempt retire the one before, whose late result is then ignored
  const attempt = useRef(0);
  // the camera reports the code in every frame while it is in view: only the first read of a scan pairs
  const read = useRef(false);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // a camera that would not start is not retried by itself: the person chooses, from the viewfinder's button
  const unavailable = useRef(false);
  async function scan() {
    try {
      const permission = await requestPermission();
      if (permission.granted && !typingNow.current) {
        read.current = false;
        setBlocked(null);
        setScanned(false);
        setError(null);
        setScanning(true);
      } else if (!permission.granted) {
        const onlySettings = !permission.canAskAgain;
        setBlocked(onlySettings ? 'settings' : 'ask');
        setError(onlySettings ? 'Camera access is off. Turn it on in Settings, or paste a copied code.' : null);
      }
    } catch {
      setError('The camera could not start. Paste a copied code instead.');
    }
  }
  const scanNow = useRef(scan);
  scanNow.current = scan;
  // the camera starts once the person asks for it (Look for my computer): the first time the system asks here, after that it simply runs
  useEffect(() => void (stage === 'scan' && scanNow.current()), [stage]);
  // back from Settings: access may have been turned on
  useEffect(() => (blocked === 'settings' ? onForeground(() => void scanNow.current()) : undefined), [blocked]);
  async function pair(code = qr) {
    // a test's runtime may draw the sheet without a snapshot
    const same = connectedPairFor(code, runtime.snapshot?.());
    if (same) return setAlready(same.name?.trim() || 'This computer');
    const elsewhere = otherAccount(code, userId);
    if (elsewhere) {
      setScanning(false);
      setScanned(true);
      return setOther(elsewhere);
    }
    const startedAt = now();
    const mine = ++attempt.current;
    setBusy(true);
    setError(null);
    setOutdated(false);
    setLog({ outcome: 'running', startedAt, endedAt: null });
    clearTimeout(timer.current as never);
    timer.current = setTimeout(() => setLog({ startedAt, outcome: 'timeout', endedAt: now() }), timeoutMs);
    try {
      await runtime.pair(code, name);
    } catch (e: unknown) {
      // a failure that arrives after Stop, or after a newer attempt began, belongs to neither
      if (mine !== attempt.current) return;
      setError(pairFailure(e, account));
      setOutdated(needsUpdate(e));
      setLog({ startedAt, outcome: failureOutcome(e), endedAt: now() });
    } finally {
      if (mine === attempt.current) {
        clearTimeout(timer.current as never);
        setBusy(false);
      }
    }
  }
  /** The system Paste button handed over the copied text: a pairing code pairs at once, anything else says what to copy. */
  function pasteCode(text: string) {
    const code = text.trim();
    if (!isPairingCode(code)) return setError("That isn't a MoPilot pairing code. Copy the code on your computer, then tap Paste.");
    read.current = true;
    setScanning(false);
    setScanned(true);
    void pair(code);
  }
  /** Give up on an attempt that never answered, so the form can be used again. */
  async function stop() {
    clearTimeout(timer.current as never);
    try {
      await runtime.cancelPairing();
      ++attempt.current;
      setBusy(false);
      setLog(null);
      setError(null);
    } catch (e: unknown) {
      setError(pairFailure(e, account));
    }
  }
  // the attempt once it has ended (answered late, refused or timed out): what the report is made from
  const ended = log && log.endedAt !== null ? { outcome: log.outcome, elapsedMs: log.endedAt - log.startedAt } : null;
  const entering = typing;
  const action =
    blocked === 'settings'
      ? { title: 'Open Settings', run: () => void Linking.openSettings() }
      : { title: scanned ? 'Scan again' : 'Turn on the camera', run: () => void scan() };
  if (already)
    return (
      <SheetFrame title="Add a computer" onClose={back}>
        <View style={{ gap: 16, paddingTop: 24 }}>
          <Text accessibilityLiveRegion="polite" style={{ textAlign: 'center', ...typo.bodySemibold, color: theme.ink }}>
            {already} is already connected.
          </Text>
          <Button title="Done" onPress={back} />
        </View>
      </SheetFrame>
    );
  if (other)
    return (
      <SheetFrame title="Add a computer" onClose={back}>
        <View style={{ gap: 16, paddingTop: 24 }}>
          <Text accessibilityLiveRegion="polite" style={{ textAlign: 'center', ...typo.bodySemibold, color: theme.ink }}>
            {`This computer uses ${other.who ?? 'a different MoPilot account'}.${account ? ` You're signed in as ${account}.` : ''}`}
          </Text>
          {signOut && <Button title={other.who ? `Sign out and use ${other.who}` : 'Sign out and use another account'} onPress={signOut} />}
          <Button
            secondary
            title="Scan another code"
            onPress={() => {
              setOther(null);
              openEntry(false);
              setQr('');
              void scan();
            }}
          />
        </View>
      </SheetFrame>
    );
  return stage === 'steps' ? (
    <SheetFrame title="" onClose={back} back>
      <AddComputerSteps account={account} host={host} lookForMac={() => setStage('scan')} done={back} />
    </SheetFrame>
  ) : (
    <SheetFrame title="Add a computer" onClose={back}>
      <ErrorLine text={error} />
      {log?.outcome === 'otherAccount' && signOut && <Button title="Sign out and use another account" onPress={signOut} />}
      {outdated && <Button title="Update MoPilot" onPress={() => void Linking.openURL(APP_STORE_URL).catch(() => undefined)} />}
      <Swap id={entering ? 'paste' : 'scan'}>
        {entering ? (
          <View style={{ gap: 12 }}>
            <Text style={{ ...typo.subhead, color: theme.ink2, paddingHorizontal: 4 }}>
              Paste the code you copied from MoPilot on your computer.
            </Text>
            <Field
              placeholder="Paste pairing code"
              value={qr}
              onChangeText={setQr}
              multiline
              autoCapitalize="none"
              // a typed code is not words: Android keyboards turn "ws" into "WS"
              autoCorrect={false}
              spellCheck={false}
              // the code is long: at the largest text sizes the field would fill the screen and push Connect out of reach, so it scrolls inside
              style={{ fontFamily: monoFamily(), ...typo.subhead, maxHeight: 160 }}
            />
            {advanced ? (
              <Field placeholder="Phone name" value={name} onChangeText={setName} />
            ) : (
              <Link title="Advanced" onPress={() => setAdvanced(true)} />
            )}
            <Button title={busy ? 'Connecting…' : 'Connect'} disabled={busy || !qr.trim()} onPress={() => void pair()} />
            <Link
              title="Scan instead"
              onPress={() => {
                openEntry(false);
                setQr('');
                setError(null);
                if (!unavailable.current && !blocked) void scan();
              }}
            />
          </View>
        ) : (
          <View style={{ gap: 4 }}>
            {/* the viewfinder: the live camera once allowed, else the one tap that asks for it */}
            <View
              style={{
                // the baseline's viewfinder: 330 pt tall on a 390 pt phone, radius 28
                aspectRatio: 1.08,
                borderRadius: 28,
                overflow: 'hidden',
                backgroundColor: '#111110',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 14,
              }}
            >
              {scanning ? (
                <CameraView
                  style={{ position: 'absolute', inset: 0 }}
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onMountError={() => {
                    unavailable.current = true;
                    setScanning(false);
                    openEntry(true);
                    setError('The camera could not start. Paste a copied code instead.');
                  }}
                  onBarcodeScanned={({ data }) => {
                    // every frame reports the code while it is in view: the first one pairs, the scanner closes
                    if (read.current) return;
                    read.current = true;
                    setScanning(false);
                    setScanned(true);
                    void pair(data);
                  }}
                />
              ) : busy ? (
                <Text style={{ ...typo.calloutSemibold, color: '#ffffff' }}>Connecting…</Text>
              ) : (
                <Tap
                  accessibilityRole="button"
                  accessibilityLabel={action.title}
                  onPress={action.run}
                  style={{
                    minHeight: 44,
                    paddingHorizontal: 18,
                    borderRadius: 22,
                    justifyContent: 'center',
                    backgroundColor: 'rgba(255,255,255,0.14)',
                  }}
                >
                  <Text style={{ ...typo.calloutSemibold, color: '#ffffff' }}>{action.title}</Text>
                </Tap>
              )}
              <Brackets />
            </View>
            <Text style={{ textAlign: 'center', ...typo.bodySemibold, color: theme.ink }}>Scan the code on your computer</Text>
            <Text style={{ textAlign: 'center', ...typo.subhead, color: theme.ink2 }}>In MoPilot there: Connect your phone</Text>
            {/* one tap pairs a copied code; the link below is the way where the system has no Paste button */}
            <PasteCodeButton onText={pasteCode} />
            <Link
              title="Paste code instead"
              onPress={() => {
                setScanning(false);
                openEntry(true);
                setError(null);
              }}
            />
            <Link title="How to connect" onPress={() => setStage('steps')} />
          </View>
        )}
      </Swap>
      {log && !explained(log.outcome) && (
        <Card>
          <ErrorLine text={log.outcome === 'timeout' ? timeoutSentence(timeoutMs) : null} />
          {pairingSteps(log.outcome).map((step) => (
            <Text key={step.name} style={styles.text}>
              {pairMark(step)} {step.name}
              {step.hint ? ` — ${step.hint}` : ''}
            </Text>
          ))}
          {ended && (
            <>
              <Text style={styles.muted}>The report lists these steps and the time, never the code.</Text>
              {log.outcome === 'timeout' && <Button title="Stop and try again" onPress={() => void stop()} />}
              <Button
                secondary
                title="Share report"
                onPress={() => {
                  share(pairingReport(ended.outcome, ended.elapsedMs)).catch(() => undefined);
                }}
              />
            </>
          )}
        </Card>
      )}
    </SheetFrame>
  );
}
