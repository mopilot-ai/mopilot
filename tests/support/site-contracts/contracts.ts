// Site-permission contract unit cases for contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cdpClass, cdpPolicy, CDP_DOMAINS, CDP_METHODS, CDP_CLASSES, ROOT, fs, path, treeFiles, parseSync } from './fixture.ts';

export function registerContracts() {
  const PLUGIN_METHODS = [
    'Accessibility.enable',
    'Accessibility.getFullAXTree',
    'DOM.describeNode',
    'DOM.getBoxModel',
    'DOM.getContentQuads',
    'DOM.getDocument',
    'DOM.getFrameOwner',
    'DOM.getNodeForLocation',
    'DOM.resolveNode',
    'DOM.scrollIntoViewIfNeeded',
    'DOM.setFileInputFiles',
    'DOMSnapshot.captureSnapshot',
    'Debugger.enable',
    'Debugger.resume',
    'Debugger.setPauseOnExceptions',
    'Emulation.setFocusEmulationEnabled',
    'Fetch.continueRequest',
    'Fetch.continueResponse',
    'Fetch.disable',
    'Fetch.enable',
    'Fetch.failRequest',
    'Fetch.fulfillRequest',
    'Input.dispatchDragEvent',
    'Input.dispatchKeyEvent',
    'Input.dispatchMouseEvent',
    'Input.insertText',
    'Input.setInterceptDrags',
    'Input.synthesizeScrollGesture',
    'Network.enable',
    'Network.getAllCookies',
    'Network.getResponseBodyForInterception',
    'Network.setCookie',
    'Network.setExtraHTTPHeaders',
    'Page.addScriptToEvaluateOnNewDocument',
    'Page.captureScreenshot',
    'Page.close',
    'Page.createIsolatedWorld',
    'Page.enable',
    'Page.getFrameTree',
    'Page.getLayoutMetrics',
    'Page.getNavigationHistory',
    'Page.handleJavaScriptDialog',
    'Page.navigate',
    'Page.navigateToHistoryEntry',
    'Page.reload',
    'Page.screencastFrameAck',
    'Page.setDownloadBehavior',
    'Page.setInterceptFileChooserDialog',
    'Page.setLifecycleEventsEnabled',
    'Page.startScreencast',
    'Page.stopScreencast',
    'Runtime.addBinding',
    'Runtime.callFunctionOn',
    'Runtime.enable',
    'Runtime.evaluate',
    'Runtime.getProperties',
    'Runtime.releaseObject',
    'Storage.getCookies',
    'Target.closeTarget',
    'Target.getTargetInfo',
    'Target.getTargets',
    'Target.setAutoAttach',
    'Tracing.start',
    'WebAuthn.enable',
    'Browser.getVersion',
  ];

  test('CM-P19: every CDP method the iab backend accepts is classified read, write or blocked (no unclassified pass-through)', () => {
    // the table is coherent: every method's domain is known, every class is one of the classes
    for (const [method, kind] of Object.entries(CDP_METHODS)) {
      assert.ok(CDP_CLASSES.includes(kind), `${method}: ${kind}`);
      assert.ok(Object.hasOwn(CDP_DOMAINS, method.split('.')[0]), `${method}: its domain is classified`);
    }
    for (const kind of Object.values(CDP_DOMAINS)) assert.ok(['read', 'blocked'].includes(kind as string));
    // every method the plugin sends has a class, and the backend accepts exactly the ones that aren't blocked
    for (const method of PLUGIN_METHODS) {
      const kind = cdpClass(method);
      assert.ok(CDP_CLASSES.includes(kind), method);
      if (kind === 'blocked') assert.throws(() => cdpPolicy(method), /not supported/, method);
      else assert.ok(['send', 'emulated'].includes(cdpPolicy(method)), method);
    }
    // a domain the table doesn't name, and junk, are blocked
    for (const m of ['Made.up', 'Page', '', 'Page.navigate; Browser.close', 42]) assert.equal(cdpClass(m), 'blocked');
    // cookies, other targets and the browser stay out of the plugin's reach
    for (const m of ['Network.getAllCookies', 'Storage.getCookies', 'Target.createTarget', 'Browser.close', 'Page.close'])
      assert.equal(cdpClass(m), 'blocked', m);
    // writes stay writes
    for (const m of ['Input.insertText', 'DOM.setFileInputFiles', 'DOM.setOuterHTML', 'Page.setDocumentContent'])
      assert.equal(cdpClass(m), 'write', m);
    assert.equal(cdpClass('Fetch.continueWithAuth'), 'blocked', 'HTTP-auth credentials are the user’s to type');
    // executeCdp decides through the table alone: no method list of its own
    const src = fs.readFileSync(new URL('electron/capabilities/browser/iabBackend/handlers.cjs', ROOT), 'utf8');
    const start = src.indexOf('  async executeCdp(');
    const end = src.indexOf('  async executeCdpWithCachedExpression', start);
    assert.ok(start >= 0 && end > start, 'the native CDP entrypoint must be found before checking its policy');
    const exec = src.slice(start, end);
    assert.match(exec, /cdpPolicy\(method\);\s*const kind = cdpClass\(method\);/);
    assert.doesNotMatch(exec, /method\.startsWith\('Input\.'\)/);
  });

  /** Call arguments only: a function declaration or a comment is not a grant-table consumer. */
  function chromeGrantArguments(source: string) {
    const parsed = parseSync('grant-consumer.cjs', source);
    assert.equal(parsed.errors.length, 0);
    const args: string[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      const callee = node.callee;
      const consumer =
        callee?.type === 'Identifier'
          ? callee.name === 'chromeTools'
          : callee?.type === 'MemberExpression' && !callee.computed && callee.property.name === 'chromeTools';
      if (node.type === 'CallExpression' && consumer) {
        const first = node.arguments[0];
        args.push(first ? source.slice(first.start, first.end) : '');
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    };
    walk(parsed.program);
    return args;
  }

  test('CM-P20 guard distinguishes grant-table calls from declarations, comments and unrelated function calls', () => {
    const source = `
    function chromeTools({ channel, grants, schemas }) { return []; }
    // chromeTools({ grants: wrongTable })
    function tools() {
      return chromeTools({ channel, grants: this.o.chromeGrants, schemas });
    }
    otherTools({ grants: wrongTable });
    chromeTools({ grants: wrongTable });
    chromeTools();
    bridge.chromeTools({ grants: wrongTable });
  `;
    const args = chromeGrantArguments(source);
    assert.equal(args.length, 4);
    assert.match(args[0], /grants: this\.o\.chromeGrants/);
    assert.doesNotMatch(args[1], /grants: this\.o\.chromeGrants/);
    assert.equal(args[2], '', 'a missing argument stays visible to the fail-closed check');
    assert.doesNotMatch(args[3], /grants: this\.o\.chromeGrants/, 'member calls remain grant-table consumers');
  });

  test('CM-P20: every site table main makes names its browser, and every grant lookup in main goes to a named table', () => {
    const files = treeFiles(new URL('electron/', ROOT).pathname, /\.c?js$/);
    let tables = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(/new OriginGrants\(\{([\s\S]*?)\n\s*\}\)/g)) {
        tables++;
        assert.match(m[1], /\bbrowser: '(iab|chrome)'/, `${path.relative(ROOT.pathname, f)}: a site table names its browser`);
      }
      // a grants object handed to the Your Chrome tools is Chrome's own table
      for (const args of chromeGrantArguments(src))
        assert.match(args, /grants: this\.o\.chromeGrants/, `${path.relative(ROOT.pathname, f)}: Your Chrome's table`);
    }
    assert.equal(tables, 2, 'one table per browser');
    // the IPC picks a table by the browser it names
    const ipc = fs.readFileSync(new URL('electron/app/ipc/browser.cjs', ROOT), 'utf8');
    assert.doesNotMatch(ipc.replace(/const grantsOf = [^\n]*\n/, ''), /live\.(browser|chrome)Grants/);
  });

  // The Codex Browser plugin returns its own instructions (tens of KB of markdown) with the first program of a thread.
  // They describe interruptions in prose ("took control", "stopped in the extension", user_took_over) and mention
  // Computer Use: none of it is the program's output. Abridged from a real first-call result (edge-case suite, 2026-10-14).
}
