// MoPilot-owned computer access, browser permission and dev-server approval cards.
import { useEffect, useRef, useState } from 'react';
import { useWindowListener } from '../../../lib/effects';
import { browserPlace } from '../../../lib/browserSites';
import { type SageAccessLevel, type SageApprovalAnswer, type SageApprovalParams } from '../../../lib/native';
import { Globe, SquareTerminal, MousePointerClick, AlertTriangle, MonitorSmartphone } from '../../ui/icons';
import {
  HOLD_MS,
  accessSentence,
  activatesOnEnter,
  approvalKey,
  approvesOnEnter,
  cardOwnsKey,
  endsHold,
  isTypingTarget,
  scopeChord,
  scopeCopy,
  warningLine,
} from '../approvalLogic';
import { copy } from '../../../harness/copy';
import { MenuItem } from '../../ui/Popover';
import { useSourceLabel, answerSageCard, AllowSplit, humanClick } from './shared';
import { AutoSwitchItem } from './autoSwitch';
import { ConfirmAllow } from './confirmAllow';
import { useAppIdentity } from '../../../lib/appNames';
/**
 * One card for every request Sage asks itself: computerAccess (control an app, at a level, for this
 * call, this chat or always), computerConfirm (can't be undone: allowed one call at a time) and
 * browserOrigin. It reads as Claude Desktop's site card: the question, then Deny and one split button whose primary is Always allow where it is offered (else Allow in
 * this chat), the other scopes in its menu. 1, 2, 3 pick a scope, ⌘↩ allows once, ⇧⌘↩ always allows, Esc
 * denies; a confirmation takes a click or ⌘↩ held for a second.
 * Only a person's input counts: synthetic events are ignored. A risky site (params.risk) says which
 * risk class it is and why; an ordinary action there may be allowed for good ("Always allow on this site", ⇧⌘↩,
 * params.siteAlways: #5464), a click with no hold. A site card lets the
 * person give less than the agent asked for (read only when it asked to read and write); an app card
 * offers only the levels at or above the one the call needs.
 */
/**
 * A card a paired computer raised (computer access, #1364): it says which computer acts and gets the answer, so it can
 * never pass for one about this Mac.
 */
export function RemoteMark({ params }: { params: SageApprovalParams }) {
  if (!params.remote) return null;
  return (
    <div className="approval-remote" role="note" data-testid="approval-remote">
      <MonitorSmartphone size={14} strokeWidth={1.8} />
      <span>
        On <strong>{params.remote.hostName}</strong>, a paired computer. Your answer goes there.
      </span>
    </div>
  );
}

/** A site card of a chat that runs on a machine: the page is on that machine, not on this Mac. */
export function MachineMark({ params }: { params: SageApprovalParams }) {
  if (!params.onMachine) return null;
  return (
    <p className="sage-access-hint" data-testid="approval-machine">
      The page is on <strong>{params.onMachine}</strong>, not on this Mac.
    </p>
  );
}

export function SageApprovalCard({ id, threadId, params }: { id: string; threadId: string; params: SageApprovalParams }) {
  const agent = useSourceLabel(threadId, params);
  const app = params.app?.name ?? params.origin ?? 'this app';
  const levels = params.levels ?? [];
  const need = Math.max(
    0,
    levels.findIndex((l) => l.id === params.level),
  );
  const site = params.kind === 'browserOrigin';
  const [level, setLevel] = useState<SageAccessLevel | undefined>(params.level);
  const picked = levels.findIndex((l) => l.id === level);
  // the person chose less than the site card asked for
  const lower = site && picked >= 0 && picked < need;
  const [holding, setHolding] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirm = params.kind === 'computerConfirm';
  // an ordinary action on a high-risk site: allowed for the task with a click, no hold (#2328)
  const task = confirm && params.task === true;
  // an ordinary message: allowed on the site for the rest of the chat's errand with a click, as a task is (errandGrants.cjs)
  const errand = confirm && !task && params.errand === true;
  const wide = task || errand;
  // an ordinary action on a high-risk site: its site's ordinary actions may be allowed for good (#5464); never a paired computer's
  const siteAlways = confirm && params.siteAlways === true && !params.remote;
  // a local server can be allowed for good to read only: "Always allow" is there while read is the level picked
  // a paired computer's card is answered for that chat only: its "always" would not be this Mac's to give
  const always = !params.remote && (params.allowAlways === 'read' ? level === 'read' : params.allowAlways !== false);
  const root = useRef<HTMLDivElement>(null);
  const answer = (r: SageApprovalAnswer) => answerSageCard(id, r);
  const allow = (scope: 'once' | 'chat' | 'always') => answer({ decision: 'allow', scope, level });
  const deny = () => answer({ decision: 'deny' });
  // keys answer with the level and choices shown now
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    // a focused control (Deny, the chevron) keeps its own Enter, chord or not
    if (siteAlways && !activatesOnEnter(e.target as HTMLElement | null) && scopeChord(e) === 'always') {
      e.preventDefault();
      return answer({ decision: 'allow', scope: 'always' });
    }
    const chord = (confirm && !wide) || activatesOnEnter(e.target as HTMLElement | null) ? null : scopeChord(e);
    if (chord && (chord === 'once' || (always && !wide))) {
      e.preventDefault();
      return allow(chord);
    }
    const k = approvalKey(e, { choices: always && !wide ? 3 : 2, destructive: confirm && !wide });
    if (!k) return;
    e.preventDefault();
    if (k.type === 'deny') deny();
    else if (k.type === 'holdStart') {
      setHolding(true);
      holdTimer.current = setTimeout(() => answer({ decision: 'allow', scope: 'once' }), HOLD_MS);
    } else if (wide) answer({ decision: 'allow', scope: k.index === 0 ? 'once' : task ? 'task' : 'errand' });
    else allow((['once', 'chat', 'always'] as const)[k.index]);
  });
  useWindowListener('keyup', (e) => {
    if (!endsHold(e.key)) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(false);
  });
  // a card that goes away mid-hold doesn't answer
  useEffect(
    () => () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    },
    [],
  );
  // a site card names its browser: the in-app browser, or the user's own Chrome where they are signed in
  const place = browserPlace(params.browser);
  const scoped = scopeCopy(agent, params, { always });
  const message = task ? (
    `Allow ${agent} to act on ${app}?`
  ) : confirm ? (
    `Allow ${agent} to ${params.verb ?? 'act'} in ${app}? This can't be undone.`
  ) : params.kind === 'visionConsent' ? (
    copy('computerUse', 'visionConsent', { 'vision model': params.model, App: app, Harness: agent, vendor: params.vendor })
  ) : (
    <>
      {scoped.ask}
      <span className="browser-site">{scoped.what}</span>
      {scoped.tail}
    </>
  );
  return (
    <div ref={root} className="approval-card sage-approval" data-kind={params.kind}>
      <div className="approval-top">
        <div className="approval-kind">
          {confirm ? (
            <AlertTriangle size={18} strokeWidth={1.6} />
          ) : params.kind === 'browserOrigin' ? (
            <Globe size={18} strokeWidth={1.6} />
          ) : (
            <MousePointerClick size={18} strokeWidth={1.6} />
          )}
          {/* a site's card (its access, or an action on it that can't be undone) is the browser's, whichever browser */}
          <span>{site || params.browser ? 'Browser' : params.kind === 'visionConsent' ? 'Screen reading' : 'Computer use'}</span>
        </div>
        <div className="approval-message">{message}</div>
        <RemoteMark params={params} />
        <MachineMark params={params} />
        {/* what the step is, and where: one line under the question */}
        {confirm && (params.summary || place) && <p className="sage-access-hint">{[params.summary, place].filter(Boolean).join(' · ')}</p>}
        {confirm && params.actionTarget && (
          <p className="sage-access-hint" style={{ overflowWrap: 'anywhere' }} data-action-target={JSON.stringify(params.actionTarget)}>
            To: {params.actionTarget.label}
          </p>
        )}
        {confirm && params.commits && <p className="sage-access-hint">Asks every time: {params.commits}.</p>}
        {params.risk?.label && (
          <div className="approval-risk" role="note" data-level={params.risk.level} data-category={params.risk.category ?? undefined}>
            <AlertTriangle size={14} strokeWidth={1.8} />
            <span>
              <strong>{params.risk.label}.</strong> {params.risk.explanation}
            </span>
          </div>
        )}
      </div>
      {!confirm && levels.length > 0 && (
        <div className="approval-detail">
          <div
            className="segmented sage-levels"
            role="radiogroup"
            aria-label="Access level"
            title={site ? 'Read and write also clicks and types. This site and port.' : undefined}
          >
            {levels.map((l, i) => (
              <button
                key={l.id}
                role="radio"
                aria-checked={level === l.id}
                className={level === l.id ? 'on' : ''}
                disabled={!site && i < need}
                onClick={humanClick(() => setLevel(l.id))}
              >
                {l.label}
              </button>
            ))}
          </div>
          {lower && (
            <p className="sage-access-hint sage-access-lower" role="note">
              It asks again before clicking or typing.
            </p>
          )}
        </div>
      )}
      <div className="approval-foot">
        <button className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        {confirm ? (
          <ConfirmAllow task={task} errand={errand} siteAlways={siteAlways} holding={holding} answer={answer} />
        ) : (
          <AllowSplit
            human
            label={always ? 'Always allow' : 'Allow in this chat'}
            title={scoped.saved}
            kbd={always ? '⇧⌘⏎' : '2'}
            onAllow={() => allow(always ? 'always' : 'chat')}
            menu={
              <>
                <MenuItem onSelect={() => allow('once')} right={<kbd>⌘⏎</kbd>}>
                  Allow once
                </MenuItem>
                {always && (
                  <MenuItem onSelect={() => allow('chat')} right={<kbd>2</kbd>}>
                    Allow in this chat
                  </MenuItem>
                )}
                {/* Auto never covers a risky site (high risk, sign-in details in the address), and a paired computer
                    never runs a remote owner above Ask (#1364): no switch there */}
                {site && !params.risk && !params.remote && (
                  <AutoSwitchItem threadId={threadId} onAllow={() => answer({ decision: 'allow', scope: 'once', level, then: 'auto' })} />
                )}
              </>
            }
          />
        )}
      </div>
    </div>
  );
}

/**
 * The desktop_* tools' cards: computerAccessSet (a set of apps, each at the tier its kind allows) and
 * computerTakeover (MoPilot may take over the screen for the rest of this chat). The access card is
 * one sentence and three buttons; a broad-reach warning stays visible as one line, and the task, the
 * apps with their tiers (unchecking one leaves it out), what can't be granted and the fine print sit
 * behind "Details". Agents work in apps in the background (desktop_app_*), so the access card never asks
 * for screen control: the takeover card comes just in time, on the first input that needs the real
 * pointer and keyboard, with why in one line. Enter or 1 allows, Esc denies; only a person's input counts.
 */
export function DesktopAccessCard({ id, threadId, params }: { id: string; threadId: string; params: SageApprovalParams }) {
  const agent = useSourceLabel(threadId, params);
  const takeover = params.kind === 'computerTakeover';
  const apps = params.apps ?? [];
  const [picked, setPicked] = useState<Set<string>>(() => new Set(apps.map((a) => a.bundleId)));
  const root = useRef<HTMLDivElement>(null);
  const answer = (r: SageApprovalAnswer) => answerSageCard(id, r);
  // remember: "Always allow" (a click only); Enter and 1 keep meaning Allow for this chat
  const allow = (remember = false) =>
    answer(
      takeover
        ? { decision: 'allow' }
        : {
            decision: 'allow',
            apps: [...picked],
            clipboardRead: params.clipboardRead,
            clipboardWrite: params.clipboardWrite,
            systemKeyCombos: params.systemKeyCombos,
            ...(remember ? { remember: true } : {}),
          },
    );
  const deny = () => answer({ decision: 'deny' });
  const empty = !takeover && apps.length > 0 && picked.size === 0;
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    const k = approvalKey(e, { choices: 1, destructive: false });
    if (k?.type === 'deny') {
      e.preventDefault();
      deny();
    } else if ((k?.type === 'choose' || approvesOnEnter(e)) && !empty) {
      e.preventDefault();
      allow();
    }
  });
  const toggle = (bundleId: string) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(bundleId)) next.delete(bundleId);
      else next.add(bundleId);
      return next;
    });
  const message = accessSentence(agent, params);
  // the one app it asks for, by its icon; several apps (or none) keep the generic glyph
  const icon = useAppIdentity(apps.length === 1 ? apps[0].name : '').icon;
  const warning = takeover ? '' : warningLine(apps);
  const fine = takeover ? null : (
    <details className="desktop-access-details">
      <summary>Details</summary>
      {params.reason ? <p className="sage-access-hint">“{params.reason}”</p> : null}
      {apps.length > 0 && (
        <ul className="desktop-access-apps">
          {apps.map((a) => (
            <li key={a.bundleId}>
              <label>
                <input type="checkbox" checked={picked.has(a.bundleId)} onChange={humanClick(() => toggle(a.bundleId))} />
                <span className="desktop-access-name">{a.name}</span>
                <span className="desktop-access-tier" data-tier={a.tier}>
                  {a.tierLabel ?? a.tier}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {(params.denied?.length ?? 0) > 0 && (
        <p className="sage-access-hint">Not available: {params.denied!.map((d) => `${d.name} (${d.reason})`).join('; ')}.</p>
      )}
      <p className="sage-access-hint">Browsers are view only; terminals and editors, click only.</p>
    </details>
  );
  return (
    <div ref={root} className="approval-card sage-approval desktop-access" data-kind={params.kind}>
      <div className="approval-top">
        {/* one line (Claude Design option 4A): the app's icon, then the question */}
        <div className="approval-message desktop-access-title">
          {icon ? <img className="desktop-access-icon" src={icon} alt="" /> : <MousePointerClick size={16} strokeWidth={1.6} />}
          <span>{message}</span>
        </div>
        <RemoteMark params={params} />
        {takeover && params.reason ? <div className="sage-access-hint desktop-access-why">{params.reason}</div> : null}
        {warning ? (
          <div className="desktop-access-warning">
            <AlertTriangle size={13} strokeWidth={1.6} /> {warning}
          </div>
        ) : null}
        {fine}
      </div>
      <div className="approval-foot">
        <button className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        {!takeover && apps.length > 0 && !params.remote && (
          <button
            className="ap-btn"
            disabled={empty}
            onClick={humanClick(() => allow(true))}
            title="Every chat. Remove in Settings → Computer use."
          >
            Always allow
          </button>
        )}
        <button className="ap-btn allow solo" disabled={empty} onClick={humanClick(() => allow())}>
          {takeover ? 'Allow' : 'Allow in this chat'} <kbd>⏎</kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * devServer (browser_preview_start, any harness): run a command to start a dev server; terminalTab (open_terminal_tab):
 * open a shell in a folder. An answer covers the same command or folder for the rest of the chat. Enter or 1 allows,
 * Esc denies; only a person's input counts.
 */
export function DevServerCard({ id, threadId, params }: { id: string; threadId: string; params: SageApprovalParams }) {
  const agent = useSourceLabel(threadId, params);
  const terminal = params.kind === 'terminalTab';
  // run_in_terminal names the line it would type: allowed for that line only
  const line = terminal ? params.command : undefined;
  const root = useRef<HTMLDivElement>(null);
  const answer = (r: SageApprovalAnswer) => answerSageCard(id, r);
  const allow = () => answer({ decision: 'allow', scope: 'chat' });
  const deny = () => answer({ decision: 'deny' });
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    const k = approvalKey(e, { choices: 1, destructive: false });
    if (k?.type === 'deny') {
      e.preventDefault();
      deny();
    } else if (k?.type === 'choose' || approvesOnEnter(e)) {
      e.preventDefault();
      allow();
    }
  });
  return (
    <div ref={root} className="approval-card sage-approval" data-kind={params.kind}>
      <div className="approval-top">
        <div className="approval-kind">
          <SquareTerminal size={18} strokeWidth={1.6} />
          <span>{terminal ? 'Terminal' : 'Dev server'}</span>
        </div>
        <div className="approval-message">
          {line
            ? `Allow ${agent} to run this in a terminal?`
            : terminal
              ? `Allow ${agent} to open a terminal?`
              : `Allow ${agent} to start a dev server?`}
        </div>
        <p className="sage-access-hint" title={params.cwd}>
          <code>{terminal && !line ? params.cwd : params.command}</code>
        </p>
        {line && params.cwd ? <p className="sage-access-hint">in {params.cwd}</p> : null}
      </div>
      <div className="approval-foot">
        <button className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        <AllowSplit human label={line ? 'Allow once' : 'Allow in this chat'} kbd="⏎" onAllow={allow} />
      </div>
    </div>
  );
}

/** What a page asks to use, as the browser permission card says it. */
const WEB_PERMISSION_LABEL = { camera: 'camera', microphone: 'microphone', geolocation: 'location', notifications: 'notifications' };

/**
 * browserPermission (any harness): a page the user drives in the built-in browser asks for the camera,
 * microphone, location or notifications. 1 or Enter allows once, 2 always for the site, Esc denies; only a
 * person's input counts.
 */
export function BrowserPermissionCard({ id, params }: { id: string; params: SageApprovalParams }) {
  const root = useRef<HTMLDivElement>(null);
  const answer = (r: SageApprovalAnswer) => answerSageCard(id, r);
  const once = () => answer({ decision: 'allow', scope: 'once' });
  const always = () => answer({ decision: 'allow', scope: 'always' });
  const deny = () => answer({ decision: 'deny' });
  useWindowListener('keydown', (e) => {
    if (isTypingTarget(e.target as HTMLElement | null) || document.querySelector('.popover-layer') || !cardOwnsKey(e, root.current)) return;
    const k = approvalKey(e, { choices: 2, destructive: false });
    if (k?.type === 'deny') {
      e.preventDefault();
      deny();
    } else if (k?.type === 'choose' || approvesOnEnter(e)) {
      e.preventDefault();
      if (k?.type === 'choose' && k.index === 1) always();
      else once();
    }
  });
  const what = (params.permissions ?? []).map((p) => WEB_PERMISSION_LABEL[p]).join(' and ');
  return (
    <div ref={root} className="approval-card sage-approval" data-kind="browserPermission">
      <div className="approval-top">
        <div className="approval-kind">
          <Globe size={18} strokeWidth={1.6} />
          <span>Browser</span>
        </div>
        <div className="approval-message">
          Allow <code>{params.origin}</code> to use your {what}?
        </div>
      </div>
      <div className="approval-foot">
        <button className="ap-btn deny" onClick={humanClick(deny)}>
          Deny <kbd>Esc</kbd>
        </button>
        <AllowSplit
          human
          label="Allow once"
          kbd="⏎"
          onAllow={once}
          menu={
            <MenuItem onSelect={always} right={<kbd>2</kbd>}>
              Always allow for this site
            </MenuItem>
          }
        />
      </div>
    </div>
  );
}
