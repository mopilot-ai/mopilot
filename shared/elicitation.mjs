// Shared elicitation approval mappings: the app and main's Chrome panel use the same grants and reply shapes.
function elicitationAnswer(action, content, mode) {
  return { action, content: action === 'accept' && mode !== 'url' ? content : null, _meta: null };
}
const schemaOf = (p) => p?.requestedSchema;
const metaOf = (p) => p?._meta;
const KNOWN_PERSIST = /* @__PURE__ */ new Set(['session', 'always']);
const plainText = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
function fallbackTitle(app, display, tool) {
  if (app) return `Allow Codex to use ${display ?? app}?`;
  if (tool === 'start_audio_recording') return 'Allow Codex to record computer audio?';
  return `Allow Codex Computer Use to run ${tool}?`;
}
function nativeAppApproval(p) {
  const schema = schemaOf(p);
  const meta = metaOf(p);
  const properties = schema?.properties;
  if (p?.mode !== 'form' || schema?.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties))
    return null;
  if (Object.keys(properties).length) return null;
  if (schema.required !== void 0 && (!Array.isArray(schema.required) || schema.required.length)) return null;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || meta?.connector_id !== 'computer-use') return null;
  const app = typeof meta.tool_params?.app === 'string' ? meta.tool_params.app : null;
  const tool = plainText(meta.tool_name);
  if (!app && !(tool && meta.tool_params && typeof meta.tool_params === 'object')) return null;
  const offered = Array.isArray(meta.persist) ? meta.persist : [];
  let scopes;
  if (app) {
    scopes = offered.includes('always') ? [{ value: 'always', label: 'Always allow' }] : [];
    scopes.push({ value: 'session', label: 'Allow this conversation' });
  } else {
    scopes = [{ value: 'once', label: 'Allow once' }];
    if (offered.includes('session')) scopes.push({ value: 'session', label: 'Allow for this session' });
    if (offered.includes('always')) scopes.push({ value: 'always', label: 'Always allow' });
  }
  const details = [];
  for (const d of Array.isArray(meta.tool_params_display) ? meta.tool_params_display : []) {
    const label = plainText(d?.display_name) ?? plainText(d?.name);
    if (label && d.value !== void 0 && d.value !== null)
      details.push({ label, value: typeof d.value === 'string' ? d.value : JSON.stringify(d.value) });
  }
  const display = details.find((d) => d.label === 'App')?.value ?? null;
  const risk = plainText(meta.riskLevel);
  return {
    app,
    tool,
    title: plainText(p.message) ?? fallbackTitle(app, display, tool),
    connector: plainText(meta.connector_name),
    warning: plainText(meta.subtitle) ?? plainText(meta.warningSubtitle),
    risk: risk && risk.toLowerCase() !== 'low' ? risk : null,
    details,
    scopes,
    // Codex App leads with "Allow this conversation" for every app request, elevated risk included
    lead: app ? 'session' : 'once',
    unsupported: offered.filter((v) => !KNOWN_PERSIST.has(v)).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))),
  };
}
function nativeAppAnswer(p, choice) {
  if (choice === 'decline' || choice === 'cancel') return elicitationAnswer(choice, null, 'form');
  const approval = nativeAppApproval(p);
  if (!approval?.scopes.some((s) => s.value === choice)) return elicitationAnswer('cancel', null, 'form');
  const offered = metaOf(p)?.persist;
  const persists = choice !== 'once' && (choice !== 'session' || (Array.isArray(offered) && offered.includes('session')));
  return { action: 'accept', content: {}, _meta: persists ? { persist: choice } : null };
}
const offeredPersist = (persist) => (Array.isArray(persist) ? persist : persist == null ? [] : [persist]);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const shown = (v) => (typeof v === 'string' ? v : String(JSON.stringify(v, null, 2)));
function originHost(origin) {
  if (!origin) return null;
  try {
    return new URL(origin).host || null;
  } catch {
    return null;
  }
}
function browserUseKind(meta, params) {
  const tool = String(meta.tool_name ?? '');
  if (tool === 'access_browser_origin') return 'origin';
  if (tool === 'access_browser_origin_with_raw_cdp') return 'devtools';
  if (tool === 'upload_browser_files') return 'upload';
  if (tool === 'download_browser_files') return 'download';
  if (tool.startsWith('webmcp:')) return 'webmcp';
  if (meta.sensitive_data === 'browsing_history') return 'history';
  if (Array.isArray(params.asset_origins)) return 'assets';
  return 'action';
}
function emptyForm(p) {
  if (p.mode !== void 0 && p.mode !== 'form') return false;
  const schema = schemaOf(p);
  if (schema == null) return true;
  const props = schema.properties;
  if (schema.type !== 'object') return false;
  if (props !== void 0 && (!props || typeof props !== 'object' || Array.isArray(props) || Object.keys(props).length)) return false;
  return schema.required === void 0 || (Array.isArray(schema.required) && !schema.required.length);
}
function browserUseApproval(p) {
  const meta = metaOf(p);
  if (meta?.connector_id !== 'browser-use' || meta.codex_approval_kind !== 'mcp_tool_call' || !emptyForm(p)) return null;
  const params = meta.tool_params && typeof meta.tool_params === 'object' ? meta.tool_params : {};
  const kind = browserUseKind(meta, params);
  const origin = text(meta.origin) ?? text(params.origin) ?? (kind === 'assets' ? text(params.asset_origins[0]) : null);
  const details = [];
  if (kind === 'webmcp' || kind === 'action') {
    const title = text(meta.tool_title);
    if (title) details.push({ label: kind === 'webmcp' ? 'Tool' : 'Action', value: title });
    const about = text(meta.tool_description);
    if (about) details.push({ label: 'Description', value: about });
    const page = text(meta.page_url);
    if (page) details.push({ label: 'Page', value: page });
    if (meta.tool_params !== void 0 && (kind === 'webmcp' || Object.keys(params).length))
      details.push({ label: 'Input', value: shown(meta.tool_params) });
  }
  for (const d of Array.isArray(meta.tool_params_display) ? meta.tool_params_display : []) {
    const label = text(d?.display_name) ?? text(d?.name);
    if (label && d.value !== void 0) details.push({ label, value: shown(d.value) });
  }
  const offered = offeredPersist(meta.persist);
  const sticky = kind === 'origin' || kind === 'devtools';
  const choices = [sticky ? { value: 'chat', label: 'Allow in this chat' } : { value: 'once', label: 'Allow once' }];
  if (!sticky && offered.includes('session')) choices.push({ value: 'session', label: 'Allow in this chat' });
  if (offered.includes('always')) {
    if (kind === 'origin')
      choices.push({ value: 'site', label: 'Allow for this site' }, { value: 'allSites', label: 'Allow for all sites' });
    else if (kind === 'devtools' || kind === 'upload' || kind === 'download' || kind === 'assets')
      choices.push({ value: 'site', label: 'Always allow for this site' });
    else choices.push({ value: 'always', label: 'Always allow' });
  }
  return {
    kind,
    origin,
    host: originHost(origin),
    browser: text(meta.connector_name),
    reason: text(meta.reason) ?? text(params.reason) ?? text(meta.subtitle),
    details,
    sensitive: meta.codex_sensitive_action === true,
    highRisk: meta.riskLevel === 'high' || meta.full_cdp_access === true,
    choices,
  };
}
const BROWSER_PERSIST = {
  once: null,
  chat: null,
  session: { persist: 'session' },
  site: { persist: 'always' },
  always: { persist: 'always' },
  allSites: { persist: 'always', browser_use_persistent_approval_scope: 'all-sites' },
};
function browserUseAnswer(p, choice) {
  if (choice === 'decline' || choice === 'cancel') return elicitationAnswer(choice, null, 'form');
  const approval = browserUseApproval(p);
  if (!approval?.choices.some((c) => c.value === choice)) return elicitationAnswer('cancel', null, 'form');
  return { action: 'accept', content: {}, _meta: BROWSER_PERSIST[choice] };
}
function allowsAllSites(read) {
  if (!read || typeof read !== 'object') return false;
  return read.requirements?.browserUse?.allowGlobalPersistentApproval !== false;
}
export { allowsAllSites, browserUseAnswer, browserUseApproval, elicitationAnswer, nativeAppAnswer, nativeAppApproval, originHost };
