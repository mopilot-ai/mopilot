// Settings → Built-in tools → Computer access (#1364): let chats on your other computers use this Mac's browser and
// apps (off until turned on), pair a device with the code both sides show, choose what each device may use, remove a
// device, stop a remote session, read the access log; and connect this MoPilot to another computer the same way.
import { visiblePoll } from '../../../lib/visiblePoll';
import { useCallback, useEffect, useRef, useState } from 'react';
import { native } from '../../../lib/native';
import { useEffectOn } from '../../../lib/effects';
import type { AccessComputer, AccessHostState, AccessLogLine, AccessScopes } from '../../../lib/native/computerAccess';
import { errorText } from '../../../lib/ignored';
import { copyText } from '../../../session/clipboard';
import { toast, toastFailure } from '../../../store/core';
import { answerTaken } from '../../../store/answerRetired';
import { Group, Row, Toggle } from './Controls';
import { accessLogText, remoteCardAllow, remoteCardText, scopeLabels, SCOPE_CHOICES, timeLeft } from '../../../lib/computerAccess';
import { useSessions } from '../../../store/session/useSession';
import type { SageApprovalParams } from '../../../lib/native/contracts/control';

export function ComputerAccessSettings() {
  const [host, setHost] = useState<AccessHostState | null>(null);
  const [computers, setComputers] = useState<AccessComputer[]>([]);
  const [log, setLog] = useState<AccessLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reads = useRef(0);
  const load = useCallback(() => {
    // only the newest read lands: an older answer arriving late can't replace it
    const n = ++reads.current;
    return Promise.all([native.computerAccess.state(), native.computerAccess.log(50)]).then(
      ([st, lines]) => {
        if (n !== reads.current) return;
        setHost(st.host);
        setComputers(st.computers);
        setLog(lines);
        setError(null);
      },
      (e: unknown) => {
        if (n === reads.current) setError(errorText(e));
      },
    );
  }, []);
  useEffect(() => {
    // cannot reject: load shows a failed read with Retry
    void load();
    return native.computerAccess.onChanged(() => void load());
  }, [load]);
  const act = (what: string, run: () => Promise<unknown>) => run().then(() => load(), toastFailure(`Couldn't ${what}`));
  if (error && !host)
    return (
      <Group title="Computer access">
        <Row title="Couldn't read Computer access" desc={error}>
          <button className="btn-pill" onClick={() => void load()}>
            Retry
          </button>
        </Row>
      </Group>
    );
  if (!host) return <Group title="Computer access" desc="Starting…" children={null} />;
  return (
    <>
      <ThisMac host={host} act={act} />
      {host.devices.length > 0 && <Devices host={host} act={act} />}
      {host.active.length > 0 && (
        <Group title="Using this Mac now" desc="Stop ends the session here and stops that chat on its device.">
          {host.active.map((a) => (
            <div key={a.id} data-testid="access-active">
              <Row title={a.deviceName} desc={`A ${a.harness} chat on ${a.deviceName}`}>
                <button
                  className="btn-pill danger"
                  onClick={() => void act("stop that computer's session", () => native.computerAccess.stop(a.id))}
                >
                  Stop
                </button>
              </Row>
              <RemoteCards ownerId={a.id} act={act} />
            </div>
          ))}
        </Group>
      )}
      <OtherComputers computers={computers} act={act} />
      <Group title="Access log" desc="Every pairing, connection and call by a paired device. Never what was typed or seen.">
        {log.length === 0 ? (
          <div className="access-log-empty">Nothing yet.</div>
        ) : (
          <ul className="access-log" data-testid="access-log">
            {log.map((l) => (
              <li key={`${l.t} ${l.event} ${l.device ?? ''} ${l.chat ?? ''} ${l.tool ?? ''}`}>{accessLogText(l)}</li>
            ))}
          </ul>
        )}
      </Group>
    </>
  );
}

type Act = (what: string, run: () => Promise<unknown>) => Promise<unknown>;

/**
 * The cards a remote session raised on this Mac, answerable here as well as on its device (the first answer counts):
 * what it asks, Allow (once, as its own card's first choice) and Deny.
 */
function RemoteCards({ ownerId, act }: { ownerId: string; act: Act }) {
  const approvals = useSessions((s) => s.sessions[ownerId]?.approvals) ?? [];
  const cards = approvals.filter((a) => typeof a.method === 'string' && a.method.startsWith('sage/'));
  if (!cards.length) return null;
  return (
    <ul className="access-cards" aria-label="Waiting for your OK">
      {cards.map((c) => {
        const params = c.params as Partial<SageApprovalParams>;
        const allow = remoteCardAllow(params);
        const id = String(c.id);
        return (
          <li key={id} className="access-card" data-testid="access-card">
            <span>{remoteCardText(params)}</span>
            <button
              className="btn-pill soft"
              onClick={() =>
                void act('deny that', () => native.computer.answer(id, { decision: 'deny' }).then((taken) => answerTaken(taken, toast)))
              }
            >
              Deny
            </button>
            {allow && (
              <button
                className="btn-pill primary"
                onClick={() => void act('allow that', () => native.computer.answer(id, allow).then((taken) => answerTaken(taken, toast)))}
              >
                Allow
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const DEFAULT_SCOPES: AccessScopes = { browser: true, chrome: false, apps: false, files: false };

function ThisMac({ host, act }: { host: AccessHostState; act: Act }) {
  const [offer, setOffer] = useState<{ text: string; expiresAt: number } | null>(null);
  const [scopes, setScopes] = useState<AccessScopes>(DEFAULT_SCOPES);
  const [, tick] = useState(0);
  // an offer past its time pairs nothing: it leaves the page the second it expires
  const expired = !!offer && offer.expiresAt <= Date.now();
  const shownOffer = offer && host.pairing && !expired ? offer : null;
  // the offer's countdown, once a second while one is shown here
  useEffect(() => {
    if (!shownOffer) return;
    return visiblePoll('now:1000', 1000, () => tick((n) => n + 1));
  }, [shownOffer]);
  // each device asking starts from the built-in browser alone, never from what the last one was given
  const asking = host.request?.code ?? null;
  useEffectOn([asking], () => {
    setScopes(DEFAULT_SCOPES);
  });
  const status = host.blocked
    ? 'MoPilot has turned Computer access off for now.'
    : !host.available
      ? "This Mac can't keep the access keys in the Keychain, so Computer access can't be turned on."
      : host.listening
        ? `On. Paired devices reach this Mac at ${host.listening.address}:${host.listening.port}.`
        : 'Off. No other computer can use this Mac.';
  return (
    <Group
      title="This Mac"
      desc="Let chats on your other computers use this Mac's browser and apps, with the same approvals, blocked apps and Esc to stop as chats here."
    >
      {host.problem ? (
        <Row title="Computer access settings can't be read" desc={`${host.problem}. Reset removes every paired device and starts over.`}>
          <button className="btn-pill danger" onClick={() => void act('reset Computer access', () => native.computerAccess.reset())}>
            Reset
          </button>
        </Row>
      ) : (
        <Row title="Let paired devices use this Mac" desc={status}>
          <Toggle
            on={host.enabled && !host.blocked}
            disabled={host.blocked || !host.available}
            onChange={(on) => act(on ? 'turn Computer access on' : 'turn Computer access off', () => native.computerAccess.setEnabled(on))}
          />
        </Row>
      )}
      <Row title="Allow computers on this network" desc="Off: only programs on this Mac (or tunnels to it) can reach it.">
        <Toggle
          on={host.lan}
          disabled={!host.enabled}
          onChange={(on) => {
            // a code names the address it was made for: one shown now would point at the old one
            if (shownOffer) {
              setOffer(null);
              void act('cancel pairing', () => native.computerAccess.cancelPairing());
            }
            void act('change who can reach this Mac', () => native.computerAccess.setLan(on));
          }}
        />
      </Row>
      <Row
        title="Pair a device"
        desc={
          (shownOffer
            ? `Paste this code into Settings → Computer access on the other computer. It works once, for ${timeLeft(shownOffer.expiresAt, Date.now())}.`
            : expired
              ? 'That code expired. Make a new one.'
              : 'Shows a one-time code to paste on the other computer.') +
          // off: the code names this Mac's own address, which only it (or a tunnel) can reach
          (host.lan ? '' : ' Other computers need Allow computers on this network.')
        }
      >
        {shownOffer ? (
          <button
            className="btn-pill soft"
            onClick={() => {
              setOffer(null);
              void act('cancel pairing', () => native.computerAccess.cancelPairing());
            }}
          >
            Cancel
          </button>
        ) : (
          <button
            className="btn-pill"
            disabled={!host.listening}
            onClick={() =>
              void act('start pairing', async () => {
                const o = await native.computerAccess.startPairing();
                setOffer(o);
              })
            }
          >
            Pair a device
          </button>
        )}
      </Row>
      {shownOffer && (
        <div className="access-offer">
          <code data-testid="access-offer">{shownOffer.text}</code>
          <button className="btn-pill soft" onClick={() => copyText(shownOffer.text, 'Copied the pairing code')}>
            Copy
          </button>
        </div>
      )}
      {host.request && (
        <div
          className="access-request"
          data-testid="access-request"
          role="alertdialog"
          aria-label={`${host.request.name} wants to use this Mac`}
        >
          <div className="access-request-title">{host.request.name} wants to use this Mac</div>
          <div className="access-request-code">{host.request.code}</div>
          <div className="settings-row-desc">
            Allow only if the other computer shows the same code. Screenshots and pages it opens here go to that computer and its model.
          </div>
          <ScopePicker scopes={scopes} onChange={setScopes} />
          <div className="access-request-actions">
            <button className="btn-pill soft" onClick={() => void act('deny pairing', () => native.computerAccess.answerPairing(false))}>
              Deny
            </button>
            <button
              className="btn-pill primary"
              onClick={() =>
                void act('allow pairing', async () => {
                  await native.computerAccess.answerPairing(true, scopes);
                  setOffer(null);
                })
              }
            >
              Allow
            </button>
          </div>
        </div>
      )}
    </Group>
  );
}

function ScopePicker({ scopes, onChange }: { scopes: AccessScopes; onChange: (s: AccessScopes) => unknown }) {
  return (
    <div className="access-scopes" role="group" aria-label="What it may use">
      {SCOPE_CHOICES.map((c) => (
        <label key={c.id} className="access-scope">
          <input type="checkbox" checked={scopes[c.id]} onChange={(e) => onChange({ ...scopes, [c.id]: e.target.checked })} />
          {c.label}
        </label>
      ))}
    </div>
  );
}

function Devices({ host, act }: { host: AccessHostState; act: Act }) {
  return (
    <Group title="Paired devices" desc="Each can use only what you allow here. Remove one and it can't connect again.">
      {host.devices.map((d) => (
        <div key={d.id} className="access-device" data-testid="access-device">
          <Row
            title={d.name}
            desc={`${d.expired ? 'Unused for 30 days: pair it again' : d.online ? 'Connected' : 'Not connected'} · ${scopeLabels(d.scopes)} · key ${d.fingerprint.slice(0, 8)}`}
          >
            <button className="btn-pill danger" onClick={() => void act('remove that device', () => native.computerAccess.revoke(d.id))}>
              Remove
            </button>
          </Row>
          <ScopePicker
            scopes={d.scopes}
            onChange={(scopes) => act('change what that device may use', () => native.computerAccess.setDevice(d.id, { scopes }))}
          />
          <label className="access-scope">
            <input
              type="checkbox"
              checked={d.hostOnlyApprovals}
              onChange={(e) =>
                void act('change who approves', () => native.computerAccess.setDevice(d.id, { hostOnlyApprovals: e.target.checked }))
              }
            />
            Only this Mac can approve its actions
          </label>
        </div>
      ))}
    </Group>
  );
}

function OtherComputers({ computers, act }: { computers: AccessComputer[]; act: Act }) {
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState<string | null>(null);
  // the outcome reaches every window: only the one that started this pairing says it
  const pairing = useRef(false);
  useEffect(
    () =>
      native.computerAccess.onPaired((r) => {
        if (!pairing.current) return;
        pairing.current = false;
        setCode(null);
        if (r.ok) toast(`Paired with ${r.name}`, 'info');
        else toast(`Pairing didn't finish: ${r.error}`, 'error');
      }),
    [],
  );
  return (
    <Group
      title="Other computers"
      desc="Let chats here use another computer's browser and apps. Turn on Computer access there, pair a device, and paste its code."
    >
      {computers.map((c) => (
        <Row key={c.id} title={c.name} desc={`${c.connected ? 'Connected' : 'Not connected'} · ${c.address}:${c.port}`}>
          <button className="btn-pill soft" onClick={() => void act('forget that computer', () => native.computerAccess.forget(c.id))}>
            Forget
          </button>
        </Row>
      ))}
      <div className="access-connect">
        <input
          className="text-input slim wide"
          placeholder="mopilot-access:1:…"
          aria-label="Pairing code from the other computer"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn-pill"
          disabled={!draft.trim()}
          onClick={() =>
            void act('connect to that computer', async () => {
              const r = await native.computerAccess.pair(draft.trim());
              pairing.current = true;
              setCode(r.code);
              setDraft('');
            })
          }
        >
          Connect
        </button>
      </div>
      {code && (
        <div className="access-request" data-testid="access-pairing-code">
          <div className="access-request-code">{code}</div>
          <div className="settings-row-desc">Check that the other computer shows this code, then allow it there.</div>
        </div>
      )}
    </Group>
  );
}
