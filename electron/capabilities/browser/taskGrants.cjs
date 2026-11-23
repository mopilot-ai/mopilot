// "Allow for this task" on a financial site (#2328): the user's yes to one ordinary action there covers that site's ordinary actions until the chat's turn ends, in that segment. Only an action the caller read and found ordinary is covered (taskCovers): a click on a control that commits (Confirm, Submit, Continue, Pay...), a submitting key, a form submission, page JavaScript, an upload and anything sensitive still ask each time.
const { submitsKeys, pressesKeys, tabsThenActs } = require('./siteRisk.cjs');
const { currentToken, tokenLiveness, mayAct, checkAct } = require('../contract/actionGuard.cjs');
const turnKey = () => {
  const token = currentToken();
  return JSON.stringify([token?.thread ?? null, token?.turn ?? null]);
};

/** Ordinary browsing labels that are covered whatever the commit check below says ("Close menu"). */
const BROWSING = new Set([
  'search',
  'search hotels',
  'show more',
  'show more hotels',
  'show less',
  'hide details',
  'view details',
  'open menu',
  'close menu',
  'back',
  'previous',
  'calendar',
  'free cancellation',
  'sort by price',
  'check-in date',
  'check-out date',
  '\u641c\u7d22',
  '\u641c\u5c0b',
]);

// Words a control that commits is named with: their stems, matched at the start of a word ("Booking", "Payee"), in the
// languages a label may be written in (LETTERS). Money, deletion and passwords are also siteRisk's sensitive actions; this
// list keeps the rest of what commits (Confirm, Continue, Save, Turn off...) asking each time on a financial site.
const COMMIT_STEMS = [
  'accept',
  'activat',
  'add',
  'agree',
  'allow',
  'appl',
  'approv',
  'authori',
  'book',
  'buy',
  'cancel',
  'chang',
  'check out',
  'checkout',
  'claim',
  'clos',
  'complet',
  'confirm',
  'continu',
  'deactivat',
  'delet',
  'deposit',
  'disabl',
  'disput',
  'done',
  'enabl',
  'enrol',
  'finish',
  'freez',
  'link',
  'lock',
  'move money',
  'log',
  'next',
  'ok',
  'open account',
  'order',
  'pay',
  'proceed',
  'purchas',
  'redeem',
  'regist',
  'remov',
  'report',
  'reserv',
  'reset',
  'save',
  'sell',
  'send',
  'set',
  'sign',
  'submit',
  'subscri',
  'trade',
  'transfer',
  'turn o',
  'unlink',
  'unlock',
  'unsubscri',
  'use',
  'updat',
  'upgrad',
  'verif',
  'wire',
  'withdraw',
  'yes',
  'zelle',
  // German, French, Spanish, Italian, Portuguese
  'absenden',
  'best\u00e4tig',
  'bestaetig',
  'bezahl',
  'buchen',
  'freigeb',
  'kaufen',
  'senden',
  'speicher',
  'weiter',
  'zahlen',
  'achet',
  'confirmer',
  'continuer',
  'envoy',
  'payer',
  'r\u00e9serv',
  'valid',
  'acept',
  'compra',
  'confirma',
  'continua',
  'envia',
  'enviar',
  'guarda',
  'pagar',
  'reserva',
  'acquist',
  'avanti',
  'conferm',
  'invia',
  'paga',
  'prenot',
  'salva',
];
const COMMIT_LATIN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${COMMIT_STEMS.join('|')})`, 'iu');
// Chinese (simplified and traditional), Japanese and Korean: words, matched anywhere in the label
const COMMIT_CJK =
  /\u786e\u8ba4|\u78ba\u8a8d|\u786e\u5b9a|\u78ba\u5b9a|\u63d0\u4ea4|\u652f\u4ed8|\u4ed8\u6b3e|\u8d2d\u4e70|\u8cfc\u8cb7|\u9884\u8ba2|\u9810\u8a02|\u9884\u7ea6|\u9810\u7d04|\u8f6c\u8d26|\u8f49\u5e33|\u8f6c\u5e10|\u5220\u9664|\u522a\u9664|\u540c\u610f|\u6388\u6743|\u6388\u6b0a|\u4e0b\u4e00\u6b65|\u7ee7\u7eed|\u7e7c\u7e8c|\u4fdd\u5b58|\u50a8\u5b58|\u5132\u5b58|\u5f00\u901a|\u958b\u901a|\u5173\u95ed|\u95dc\u9589|\u7ed1\u5b9a|\u7d81\u5b9a|\u89e3\u7ed1|\u89e3\u7d81|\u7533\u8bf7|\u7533\u8acb|\u53d1\u9001|\u767c\u9001|\u4e0b\u5355|\u4e0b\u55ae|\u6ce8\u9500|\u8a3b\u92b7|\u4fee\u6539|\u8bbe\u7f6e|\u8a2d\u5b9a|\u53d6\u6d88|\u767b\u51fa|\u9000\u51fa|\u5145\u503c|\u63d0\u73b0|\u63d0\u73fe|\u5151\u6362|\u514c\u63db|\u8ba2\u9605|\u8a02\u95b1|\u6fc0\u6d3b|\u542f\u7528|\u555f\u7528|\u505c\u7528|\u9886\u53d6|\u9818\u53d6|\u5b8c\u6210|\u6b21\u3078|\u8cfc\u5165|\u652f\u6255|\u9001\u4fe1|\u4e88\u7d04|\u767b\u9332|\u7d9a\u884c|\ud655\uc778|\uacb0\uc81c|\ub2e4\uc74c|\uad6c\ub9e4|\uc608\uc57d|\uc1a1\uae08|\uc774\uccb4|\uc800\uc7a5|\uc81c\ucd9c|\ub3d9\uc758|\uc804\uc1a1|\uacc4\uc18d|\ucde8\uc18c|\uc0ad\uc81c/;
// The scripts whose commit words the lists above know: ASCII, the accented Latin letters of those languages, Han, kana, Hangul
const LETTERS =
  /^[\p{N}\p{P}\p{Zs}\p{S}a-zA-Z\u00e0\u00e2\u00e4\u00e6\u00e7\u00e9\u00e8\u00ea\u00eb\u00ee\u00ef\u00f4\u00f6\u0153\u00f9\u00fb\u00fc\u00ff\u00f1\u00df\u00e1\u00ed\u00f3\u00fa\u00e3\u00f5\u00ec\u00f2\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30fc]+$/u;

/**
 * Whether a control's label names nothing that commits: at least two letters, at most 80 characters, only scripts the commit
 * lists know, and no commit word. A label in another script, a symbol (a check mark) or an empty one asks as before.
 * @param {string} name the label, trimmed and lowercased
 */
function plainLabel(name) {
  if (name.length > 80 || (name.match(/\p{L}/gu) ?? []).length < 2 || !LETTERS.test(name)) return false;
  return !COMMIT_LATIN.test(name) && !COMMIT_CJK.test(name);
}

/**
 * Whether an action is ordinary enough for a task's allowance: scrolling and hovering; typing into a field that takes no
 * payment details; keys that neither submit nor press; a click, check or pick on a read control that submits nothing and
 * either is a text field (focusing it, #4441) or has a plain label (plainLabel). An unread target (no intent, a frame
 * nobody could read) is never covered.
 * @param {any} intent the page agent's report on the target @param {{ kind: string, keys?: string, text?: unknown, value?: unknown }} action
 */
function taskCovers(intent, action) {
  if (action?.kind === 'scroll' || action?.kind === 'hover') return true;
  if (
    !action ||
    !intent ||
    intent.unreadable ||
    intent.frame ||
    intent.submits !== false ||
    intent.consent !== null ||
    intent.payment !== false ||
    intent.secret !== false ||
    intent.form === undefined ||
    intent.form?.payment
  )
    return false;
  const read =
    typeof intent.role === 'string' &&
    intent.button === false &&
    intent.editable === true &&
    intent.secret === false &&
    intent.payment === false &&
    intent.submits === false &&
    intent.form !== undefined;
  if (action.kind === 'key') return read && !submitsKeys(action.keys) && !pressesKeys(action.keys, intent) && !tabsThenActs(action.keys);
  if (action.kind === 'type' || action.kind === 'fill') {
    const text = action.text ?? action.value;
    return read && !intent.form?.payment && typeof text === 'string' && !/[\x00-\x1f\x7f\u0085\u2028\u2029]/.test(text);
  }
  if (action.kind === 'click' || action.kind === 'check' || action.kind === 'select') {
    const name = String(intent.name || '')
      .trim()
      .toLowerCase();
    // focusing a text field is as ordinary as typing into it; any other control by its label
    return BROWSING.has(name) || (action.kind === 'click' && read) || (typeof intent.role === 'string' && plainLabel(name));
  }
  return false;
}

/** A segment's allowances belong to the executor's turn token, retired synchronously before asynchronous tab cleanup. */
class TaskGrants {
  constructor() {
    /** @type {Map<string, { segmentId: string, turns: Map<string, { key: string, origins: Set<string>, live: (() => boolean) | null, asks: Map<string, Promise<void>> }> }>} */
    this.byChat = new Map();
  }

  /** Only the running call's turn and segment may borrow an allowance. */
  has(/** @type {string} */ chatId, /** @type {string} */ segmentId, /** @type {string} */ origin) {
    const t = this.byChat.get(chatId);
    const scope = t?.turns.get(turnKey());
    return !!t && t.segmentId === segmentId && !!scope && this.current(chatId, scope) && scope.origins.has(origin);
  }

  /** A segment switch replaces all scopes; named Codex threads retain independent turn scopes. */
  scope(/** @type {string} */ chatId, /** @type {string} */ segmentId) {
    checkAct('using a task allowance', 'aborted');
    if (!currentToken()) return null;
    let t = this.byChat.get(chatId);
    if (!t || t.segmentId !== segmentId) this.byChat.set(chatId, (t = { segmentId, turns: new Map() }));
    for (const [key, scope] of t.turns) if (scope.live && !scope.live()) t.turns.delete(key);
    const key = turnKey();
    let scope = t.turns.get(key);
    if (!scope) t.turns.set(key, (scope = { key, origins: new Set(), live: tokenLiveness(), asks: new Map() }));
    return scope;
  }

  current(/** @type {string} */ chatId, /** @type {any} */ scope) {
    return mayAct() && turnKey() === scope.key && this.byChat.get(chatId)?.turns.get(scope.key) === scope && (!scope.live || scope.live());
  }

  /** A late answer never reinstates a retired turn or a replaced segment. */
  add(/** @type {string} */ chatId, /** @type {string} */ segmentId, /** @type {string} */ origin, /** @type {any} */ expected = null) {
    const t = expected ?? this.scope(chatId, segmentId);
    if (t && this.current(chatId, t)) t.origins.add(origin);
  }

  /** Parallel ordinary actions share an ask lane; a follower rechecks consent after the leader answers. */
  ask(scope, origin, confirm) {
    const previous = scope.asks.get(origin) ?? Promise.resolve();
    const result = previous.then(confirm);
    scope.asks.set(
      origin,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** Late cleanup of an older turn must retain a newer live turn's allowance. Unguarded setup scopes end here. */
  end(/** @type {string} */ chatId) {
    const t = this.byChat.get(chatId);
    if (!t) return;
    for (const [key, scope] of t.turns) if (!scope.live || !scope.live()) t.turns.delete(key);
    if (!t.turns.size) this.clear(chatId);
  }

  clear(/** @type {string} */ chatId) {
    this.byChat.delete(chatId);
  }
}

module.exports = { TaskGrants, taskCovers, plainLabel };
